import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { CommandError, MateApp } from './app.js'
import type { MateAnalyzer } from './analyzer.js'
import type { SessionControllerLike } from './dispatch.js'
import { mateDomain, type MateDomain, type MateGlobalRecord } from './domain.js'
import { MateStore } from './store.js'
import {
  COMMANDS,
  MAX_QUEUE_LENGTH,
  type DisabledWindow,
  type MateView,
  type ModelSelection,
  type RequirementView,
  type ScheduleConfig,
  type SettingsView,
} from './shared.js'
import type { HolidayDataBundle } from './holidays.js'

/** Monday 2026-01-05 10:00 UTC — inside the weekday 00:00-12:00 test window. */
const BASE = Date.UTC(2026, 0, 5, 10, 0, 0)
/** First minute the weekday 00:00-12:00 window is open. */
const WINDOW_END = Date.UTC(2026, 0, 5, 12, 0, 0)
const WEEKDAY_MORNING: DisabledWindow = { kind: 'weekday', start: '00:00', end: '12:00' }
const ANALYSIS_MODEL: ModelSelection = { provider: 'p', model: 'analysis-model' }
const DISPATCH_MODEL: ModelSelection = { provider: 'p', model: 'dispatch-model' }
const FREE_MODEL: ModelSelection = { provider: 'p', model: 'free-model' }

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mate-gate-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

function scheduleConfig(models: ScheduleConfig['models']): ScheduleConfig {
  return { models, holidays: [], workdays: [], useBuiltinHolidays: true, timezone: 'UTC' }
}

/** A schedule that disables one route for weekday mornings (00:00-12:00 UTC). */
function blockedRoute(model: string): ScheduleConfig {
  return scheduleConfig([{ provider: 'p', model, disabledWindows: [WEEKDAY_MORNING] }])
}

/** Controllable timer functions; records the armed delay and fires on demand. */
class FakeTimers {
  private seq = 1
  private readonly active = new Map<number, { fire: () => void; delay: number }>()

  set = (fire: () => void, delayMs: number): unknown => {
    const id = this.seq
    this.seq += 1
    this.active.set(id, { fire, delay: delayMs })
    return id
  }

  clear = (handle: unknown): void => {
    this.active.delete(handle as number)
  }

  get count(): number {
    return this.active.size
  }

  get delays(): number[] {
    return [...this.active.values()].map((timer) => timer.delay)
  }

  /** Fire every armed wake timer, as the real Host timer would. */
  fire(): void {
    const due = [...this.active.values()]
    this.active.clear()
    for (const timer of due) timer.fire()
  }
}

/** Minimal in-memory storage domain with the `MateStore` contract. */
class FakeDomain {
  private globalValue: MateGlobalRecord
  private readonly tables = new Map<string, Map<string, unknown>>()

  constructor() {
    this.globalValue = JSON.parse(JSON.stringify(mateDomain.global.initial)) as MateGlobalRecord
  }

  readonly global = {
    get: (): MateGlobalRecord => this.globalValue,
    set: async (value: MateGlobalRecord): Promise<void> => {
      this.globalValue = value
    },
  }

  table(name: string): FakeTable {
    let rows = this.tables.get(name)
    if (rows === undefined) {
      rows = new Map()
      this.tables.set(name, rows)
    }
    return new FakeTable(rows)
  }
}

class FakeTable {
  constructor(private readonly rows: Map<string, unknown>) {}

  get(key: string): unknown | undefined {
    return this.rows.get(key)
  }

  entries(): IterableIterator<[string, unknown]> {
    return this.rows.entries()
  }

  keys(): IterableIterator<string> {
    return this.rows.keys()
  }

  get size(): number {
    return this.rows.size
  }

  async put(key: string, value: unknown): Promise<void> {
    this.rows.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.rows.delete(key)
  }

  async deleteMany(keys: readonly string[]): Promise<number> {
    let removed = 0
    for (const key of keys) if (this.rows.delete(key)) removed += 1
    return removed
  }

  async update(key: string, transform: (current: unknown) => unknown): Promise<unknown> {
    if (!this.rows.has(key)) throw new Error(`missing-key: ${key}`)
    const next = transform(this.rows.get(key))
    this.rows.set(key, next)
    return next
  }
}

function createMate(
  id: string,
  name: string,
  model: ModelSelection,
  options: { dispatchModel?: ModelSelection | null; autonomy?: 'auto' | 'confirm' } = {},
): MateView {
  return {
    id,
    name,
    description: '',
    specialty: '',
    model,
    dispatchModel: options.dispatchModel ?? null,
    autonomy: options.autonomy ?? 'confirm',
    confidenceThreshold: 0.75,
    maxParallel: 2,
    allowSplit: true,
    persona: '',
    createdAt: BASE,
    updatedAt: BASE,
    archived: false,
  }
}

/** Fake analyzer: records each analyzed requirement title and never touches a model. */
function createAnalyzer(calls: string[]): MateAnalyzer {
  const analyzer = {
    async analyze(input: Parameters<MateAnalyzer['analyze']>[0]) {
      calls.push(input.requirement.title)
      return {
        analysis: {
          summary: 'summary',
          confidence: 0.9,
          needsClarification: false,
          subTasks: [],
          risks: [],
          questions: [],
          splitSuggestion: [],
          suggestedProjectPath: null,
          at: BASE,
        },
        usage: { inputTokens: 0, outputTokens: 0 },
        raw: '{}',
      }
    },
    async summarize(): Promise<never> {
      throw new Error('summaries are not part of the availability gate')
    },
    async distillMemory(): Promise<never> {
      throw new Error('memory distillation is not part of the availability gate')
    },
  }
  return analyzer as unknown as MateAnalyzer
}

/** Fake session controller: counts the dispatch calls the gate must prevent. */
function createController(calls: Record<string, number>): SessionControllerLike {
  return {
    async create() {
      calls.create += 1
      return { sessionId: `session-${calls.create}` }
    },
    async selectModel() {
      calls.selectModel += 1
      return {}
    },
    async rename() {
      calls.rename += 1
      return {}
    },
    async prompt() {
      calls.prompt += 1
      return { accepted: true }
    },
    async cancel() {
      calls.cancel += 1
      return {}
    },
    async list() {
      calls.list += 1
      return { items: [] }
    },
    async state() {
      calls.state += 1
      return { running: false }
    },
  }
}

interface HarnessOptions {
  domain?: FakeDomain
  clock?: { value: number }
  /** Persist this schedule before the app is created (undefined keeps the domain as-is). */
  schedule?: ScheduleConfig
  /** Holiday data override; `null` simulates a failed data load (weekend-only fallback). */
  holidayData?: HolidayDataBundle | null
}

async function createHarness(options: HarnessOptions = {}) {
  const domain = options.domain ?? new FakeDomain()
  const store = new MateStore(domain as unknown as Domain<MateDomain>)
  if (options.schedule !== undefined) {
    await store.updateSettings({ schedule: options.schedule })
  }
  const clock = options.clock ?? { value: BASE }
  const timers = new FakeTimers()
  const log: string[] = []
  const analyzed: string[] = []
  const calls: Record<string, number> = {
    create: 0, selectModel: 0, rename: 0, prompt: 0, cancel: 0, list: 0, state: 0,
  }
  const app = new MateApp({
    store,
    controller: createController(calls),
    analyzer: createAnalyzer(analyzed),
    reasoning: null,
    transcript: null,
    workspaceController: null,
    log: (message) => { log.push(message) },
    now: () => clock.value,
    timers: { set: timers.set, clear: timers.clear },
    ...(options.holidayData === undefined ? {} : { holidayData: options.holidayData }),
  })
  return { app, store, domain, clock, timers, log, analyzed, calls }
}

type Harness = Awaited<ReturnType<typeof createHarness>>

async function createRequirement(
  harness: Harness,
  mateId: string,
  brief: string,
  project?: { path: string; title: string },
): Promise<RequirementView> {
  const args: Record<string, unknown> = { brief, mateId }
  if (project !== undefined) {
    args.projectSource = 'user'
    args.projectPath = project.path
    args.projectTitle = project.title
  }
  return await harness.app.command({ command: COMMANDS.requirementCreate, args }) as RequirementView
}

function requirementView(overrides: Partial<RequirementView>): RequirementView {
  return {
    id: 'req_seed',
    number: 99,
    title: 'Seeded',
    brief: 'Seeded',
    projectPath: '',
    projectTitle: '',
    priority: 'normal',
    mateId: 'mate_fixed',
    mateName: 'Mate',
    mateModel: 'p/m',
    parentId: null,
    kind: 'requirement',
    status: 'draft',
    autonomy: 'confirm',
    sessionOverrides: null,
    discussion: [],
    analysis: null,
    plan: null,
    dispatch: null,
    result: null,
    errors: [],
    createdAt: BASE,
    updatedAt: BASE,
    rev: 1,
    ...overrides,
  }
}

describe('analysis availability gate', () => {
  it('queues the requirement and makes zero model calls while the window is closed', async () => {
    const h = await createHarness({ schedule: blockedRoute(ANALYSIS_MODEL.model) })
    const mate = createMate('mate_1', 'Planner', ANALYSIS_MODEL)
    await h.store.putMate(mate)

    const created = await createRequirement(h, mate.id, 'R1')
    await h.app.waitForBackground()

    expect(h.analyzed).toEqual([])
    const stored = h.store.getRequirement(created.id)
    expect(stored?.status).toBe('queued')
    expect(stored?.queue).toMatchObject({
      phase: 'analyze',
      reason: 'model-window',
      model: ANALYSIS_MODEL,
      window: 'weekday 00:00-12:00',
      enqueuedAt: BASE,
      nextWakeAt: WINDOW_END,
      timezone: 'UTC',
      attempts: 0,
    })
    // The timer is armed exactly for the window end, not for a poll interval.
    expect(h.app.queue.nextWakeAt).toBe(WINDOW_END)
    expect(h.timers.delays).toEqual([WINDOW_END - BASE])
    // The block is logged with the requirement identity, route, window and wake instant.
    const logLine = h.log.find((line) => line.includes('[dsh-mate] gate:'))
    expect(logLine).toBeDefined()
    expect(logLine).toContain(`#${created.number}`)
    expect(logLine).toContain('analyze blocked by model window weekday 00:00-12:00')
    expect(logLine).toContain('p/analysis-model')
    expect(logLine).toContain(`until ${new Date(WINDOW_END).toISOString()}`)
  })

  it('wakes at nextWakeAt, dequeues and analyzes exactly once', async () => {
    const h = await createHarness({ schedule: blockedRoute(ANALYSIS_MODEL.model) })
    const mate = createMate('mate_1', 'Planner', ANALYSIS_MODEL)
    await h.store.putMate(mate)
    const created = await createRequirement(h, mate.id, 'R1')
    await h.app.waitForBackground()
    expect(h.analyzed).toEqual([])

    h.clock.value = WINDOW_END
    h.timers.fire()
    await h.app.queue.tick()
    await h.app.waitForBackground()

    expect(h.analyzed).toEqual(['R1'])
    const stored = h.store.getRequirement(created.id)
    expect(stored?.status).toBe('proposed')
    expect(stored?.queue ?? null).toBeNull()
    // Nothing else is queued, so no timer stays armed.
    expect(h.timers.count).toBe(0)
  })

  it('analyzes only the available route when one of two Mates is blocked', async () => {
    const h = await createHarness({ schedule: blockedRoute('blocked-model') })
    const freeMate = createMate('mate_free', 'Free', FREE_MODEL)
    const blockedMate = createMate('mate_blocked', 'Blocked', { provider: 'p', model: 'blocked-model' })
    await h.store.putMate(freeMate)
    await h.store.putMate(blockedMate)

    const available = await createRequirement(h, freeMate.id, 'FREE')
    const blocked = await createRequirement(h, blockedMate.id, 'BLOCKED')
    await h.app.waitForBackground()

    expect(h.analyzed).toEqual(['FREE'])
    expect(h.store.getRequirement(available.id)?.status).toBe('proposed')
    expect(h.store.getRequirement(blocked.id)?.status).toBe('queued')
    expect(h.store.getRequirement(blocked.id)?.queue?.phase).toBe('analyze')
    expect(h.store.getRequirement(blocked.id)?.queue?.nextWakeAt).toBe(WINDOW_END)
    // The blocked half of the partial-availability case is just as auditable as
    // the all-blocked case: exactly one gate log, naming the blocked route.
    const gateLogs = h.log.filter((line) => line.includes('[dsh-mate] gate:'))
    expect(gateLogs).toHaveLength(1)
    expect(gateLogs[0]).toContain('p/blocked-model')
  })

  it('keeps FIFO order and arms the timer on restart', async () => {
    const first = await createHarness({ schedule: blockedRoute(ANALYSIS_MODEL.model) })
    const mate = createMate('mate_1', 'Planner', ANALYSIS_MODEL)
    await first.store.putMate(mate)
    const r1 = await createRequirement(first, mate.id, 'R1')
    const r2 = await createRequirement(first, mate.id, 'R2')
    await first.app.waitForBackground()
    expect(first.store.queuedRequirements().map((item) => item.id)).toEqual([r1.id, r2.id])

    first.app.dispose()
    expect(first.timers.count).toBe(0)

    // Same storage domain, fresh Host: the persisted FIFO queue must survive.
    const second = await createHarness({ domain: first.domain, clock: first.clock })
    await second.app.resume()
    expect(second.store.queuedRequirements().map((item) => item.id)).toEqual([r1.id, r2.id])
    expect(second.timers.delays).toEqual([WINDOW_END - BASE])

    // When the window opens while the Host is up, resume drains both in FIFO order.
    second.clock.value = WINDOW_END
    await second.app.resume()
    await second.app.waitForBackground()

    expect(second.analyzed).toEqual(['R1', 'R2'])
    expect(second.store.getRequirement(r1.id)?.status).not.toBe('queued')
    expect(second.store.getRequirement(r2.id)?.status).not.toBe('queued')
  })
})

describe('dispatch availability gate', () => {
  it('gates the allow-list-mapped dispatch route rather than the raw request', async () => {
    const projectPath = makeTempDir()
    // The raw requested route (free-model) is available; the Mate allow-list maps
    // it onto mapped-model, which is the route that must be judged.
    const h = await createHarness({ schedule: blockedRoute('mapped-model') })
    const mate = createMate('mate_1', 'Planner', ANALYSIS_MODEL, { autonomy: 'confirm' })
    mate.dispatchModels = [{ provider: 'p', model: 'mapped-model' }]
    await h.store.putMate(mate)
    const created = await createRequirement(h, mate.id, 'R1', { path: projectPath, title: 'tmp' })
    await h.app.waitForBackground()
    expect(h.store.getRequirement(created.id)?.status).toBe('proposed')

    await h.app.command({
      command: COMMANDS.requirementUpdate,
      args: { id: created.id, sessionOverrides: FREE_MODEL },
    })
    await h.app.command({
      command: COMMANDS.requirementConfirm,
      args: { id: created.id, targetProjectPath: projectPath, dispatchMode: 'new' },
    })
    await h.app.waitForBackground()

    expect(h.calls.create).toBe(0)
    expect(h.calls.prompt).toBe(0)
    const blocked = h.store.getRequirement(created.id)
    expect(blocked?.status).toBe('queued')
    expect(blocked?.queue?.phase).toBe('dispatch')
    expect(blocked?.queue?.model).toEqual({ provider: 'p', model: 'mapped-model' })
    expect(blocked?.queue?.nextWakeAt).toBe(WINDOW_END)
  })

  it('blocks the dispatch route without calling the dispatcher, then dispatches once the window opens', async () => {
    const projectPath = makeTempDir()
    const h = await createHarness({ schedule: blockedRoute(DISPATCH_MODEL.model) })
    const mate = createMate('mate_1', 'Planner', ANALYSIS_MODEL, {
      dispatchModel: DISPATCH_MODEL,
      autonomy: 'auto',
    })
    await h.store.putMate(mate)

    const created = await createRequirement(h, mate.id, 'R1', { path: projectPath, title: 'tmp' })
    await h.app.waitForBackground()

    // Analysis ran normally (its route is available) but dispatch did not.
    expect(h.analyzed).toEqual(['R1'])
    expect(h.calls.create).toBe(0)
    expect(h.calls.prompt).toBe(0)
    const blocked = h.store.getRequirement(created.id)
    expect(blocked?.status).toBe('queued')
    expect(blocked?.queue).toMatchObject({
      phase: 'dispatch',
      reason: 'model-window',
      model: DISPATCH_MODEL,
      nextWakeAt: WINDOW_END,
      attempts: 0,
    })
    expect(h.log.some((line) => line.includes('dispatch blocked by model window'))).toBe(true)

    h.clock.value = WINDOW_END
    await h.app.queue.tick()
    await h.app.waitForBackground()

    expect(h.calls.create).toBe(1)
    expect(h.calls.prompt).toBe(1)
    const dispatched = h.store.getRequirement(created.id)
    expect(dispatched?.status).toBe('running')
    expect(dispatched?.queue ?? null).toBeNull()
    expect(dispatched?.dispatch?.sessionId).toBe('session-1')
  })
})

describe('in-flight sessions', () => {
  it('leaves a running requirement untouched by a queue pass', async () => {
    const h = await createHarness({ schedule: blockedRoute(ANALYSIS_MODEL.model) })
    const mate = createMate('mate_1', 'Planner', ANALYSIS_MODEL)
    await h.store.putMate(mate)
    const queued = await createRequirement(h, mate.id, 'R1')
    await h.app.waitForBackground()

    const running = requirementView({
      id: 'req_live',
      number: 42,
      title: 'Live',
      brief: 'Live',
      mateId: mate.id,
      mateName: mate.name,
      mateModel: 'p/analysis-model',
      status: 'running',
      dispatch: { sessionId: 'live-session', requestedAt: BASE, lastRunningAt: BASE, reused: false, pendingInput: [] },
      // A stale queue entry must not make the tick touch a running requirement.
      queue: {
        phase: 'analyze',
        reason: 'model-window',
        model: ANALYSIS_MODEL,
        window: 'weekday 00:00-12:00',
        enqueuedAt: BASE,
        nextWakeAt: BASE,
        timezone: 'UTC',
        attempts: 0,
      },
    })
    await h.store.putRequirement(running)
    const before = h.store.getRequirement('req_live')

    h.clock.value = WINDOW_END
    await h.app.queue.tick()
    await h.app.waitForBackground()
    await h.app.processQueued(before!)
    await h.app.resume()

    expect(h.analyzed).toEqual(['R1'])
    const after = h.store.getRequirement('req_live')
    expect(after).toEqual(before)
    expect(after?.status).toBe('running')
    expect(after?.dispatch?.sessionId).toBe('live-session')
    // The queued requirement itself was dequeued normally.
    expect(h.store.getRequirement(queued.id)?.status).toBe('proposed')
  })
})

describe('schedule settings', () => {
  it('rejects an invalid schedule with code schedule-invalid and details', async () => {
    const h = await createHarness()
    const before = h.store.settings().schedule

    const attempt = h.app.command({
      command: COMMANDS.settingsUpdate,
      args: {
        schedule: {
          models: [{
            provider: 'p',
            model: 'm',
            disabledWindows: [{ kind: 'weekday', start: '25:00', end: '26:00' }],
          }],
          holidays: [],
          timezone: null,
        },
      },
    })

    await expect(attempt).rejects.toMatchObject({
      code: 'schedule-invalid',
      detail: { errors: expect.any(Array) },
    })
    await expect(attempt).rejects.toBeInstanceOf(CommandError)
    expect(h.store.settings().schedule).toEqual(before)
  })

  it('persists a valid schedule and exposes it (with the effective zone) in settings and the snapshot', async () => {
    const h = await createHarness()
    const config: ScheduleConfig = {
      models: [{ provider: 'p', model: 'm', disabledWindows: [WEEKDAY_MORNING] }],
      holidays: ['2026-01-01'],
      workdays: ['2026-01-04'],
      useBuiltinHolidays: false,
      timezone: 'UTC',
    }

    const view = await h.app.command({ command: COMMANDS.settingsUpdate, args: { schedule: config } }) as SettingsView

    expect(view.schedule).toEqual(config)
    expect(view.timezone).toEqual({ id: 'UTC', source: 'manual' })
    expect(h.store.settings().schedule).toEqual(config)

    const snapshot = await h.app.snapshot({})
    expect(snapshot.snapshot?.settings.schedule).toEqual(config)
    expect(snapshot.snapshot?.settings.timezone).toEqual({ id: 'UTC', source: 'manual' })
  })

  it('records the browser-reported time zone and resolves it when no manual override exists', async () => {
    const h = await createHarness()

    await h.app.snapshot({ timeZone: 'Asia/Tokyo' })
    expect(h.store.settings().clientTimeZone).toBe('Asia/Tokyo')

    const snapshot = await h.app.snapshot({ timeZone: 'Asia/Tokyo' })
    expect(snapshot.snapshot?.settings.timezone).toEqual({ id: 'Asia/Tokyo', source: 'client' })

    // An invalid zone is ignored instead of being persisted.
    await h.app.snapshot({ timeZone: 'not/a-zone' })
    expect(h.store.settings().clientTimeZone).toBe('Asia/Tokyo')
  })

  it('keeps the holiday list across a Host restart', async () => {
    const first = await createHarness()
    const config: ScheduleConfig = {
      models: [],
      holidays: ['2026-05-01', '2026-05-02', '2026-10-01'],
      workdays: [],
      useBuiltinHolidays: false,
      timezone: null,
    }
    await first.app.command({ command: COMMANDS.settingsUpdate, args: { schedule: config } })
    first.app.dispose()

    // Same persisted storage domain, fresh Host: the local holiday list survives
    // and is exposed again without any external data source.
    const second = await createHarness({ domain: first.domain })
    const snapshot = await second.app.snapshot({})
    expect(snapshot.snapshot?.settings.schedule.holidays).toEqual(['2026-05-01', '2026-05-02', '2026-10-01'])
  })

  it('re-evaluates the queue when a schedule change opens the window', async () => {
    const h = await createHarness({ schedule: blockedRoute(ANALYSIS_MODEL.model) })
    const mate = createMate('mate_1', 'Planner', ANALYSIS_MODEL)
    await h.store.putMate(mate)
    const created = await createRequirement(h, mate.id, 'R1')
    await h.app.waitForBackground()
    expect(h.store.getRequirement(created.id)?.status).toBe('queued')

    // Opening every window is a schedule change: the queued requirement is due
    // immediately and must be re-judged without waiting for the old wake timer.
    await h.app.command({
      command: COMMANDS.settingsUpdate,
      args: { schedule: { models: [], holidays: [], timezone: 'UTC' } },
    })
    await h.app.waitForBackground()

    expect(h.analyzed).toEqual(['R1'])
    expect(h.store.getRequirement(created.id)?.status).toBe('proposed')
  })
})
