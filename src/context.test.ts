import { describe, expect, it } from 'vitest'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { CommandError, MateApp } from './app.js'
import {
  HANDOFF_MAX_CHARS,
  resolveContextCompressionConfig,
  type CompactionOutcome,
  type ContextMeasurement,
} from './compression.js'
import { Dispatcher, buildBrief, type DispatchContextCompression, type SessionControllerLike, type SessionSummaryLike } from './dispatch.js'
import { mateDomain, type MateDomain, type MateGlobalRecord } from './domain.js'
import { COMMANDS, type ContextCompressionConfig, type MateView, type RequirementView, type SettingsView } from './shared.js'
import { MateStore } from './store.js'

const PROJECT = 'D:\\repo\\Mate'
const MATE: MateView = {
  id: 'mate_1',
  name: 'Planner',
  description: '',
  specialty: '',
  model: { provider: 'p', model: 'm' },
  dispatchModel: null,
  autonomy: 'auto',
  confidenceThreshold: 0.75,
  maxParallel: 2,
  allowSplit: true,
  persona: '',
  createdAt: 0,
  updatedAt: 0,
  archived: false,
}

function requirement(overrides: Partial<RequirementView> = {}): RequirementView {
  return {
    id: 'req_1',
    number: 17,
    title: '派发前上下文压缩与回退',
    brief: '启用上下文压缩',
    projectPath: PROJECT,
    projectTitle: 'Mate',
    priority: 'normal',
    mateId: MATE.id,
    mateName: MATE.name,
    mateModel: 'p/m',
    parentId: null,
    kind: 'requirement',
    status: 'approved',
    autonomy: 'auto',
    sessionOverrides: null,
    discussion: [],
    analysis: null,
    plan: null,
    dispatch: null,
    result: null,
    errors: [],
    createdAt: 0,
    updatedAt: 0,
    rev: 1,
    ...overrides,
  }
}

interface PromptCall {
  sessionId: string
  text: string
}

/** Controller fake that records create/select/rename/prompt calls. */
class FakeController implements SessionControllerLike {
  created = 0
  readonly prompts: PromptCall[] = []
  selectModels: string[] = []
  renames: string[] = []
  /** Sessions returned by `list()`; drives reuse validation in the app path. */
  listItems: SessionSummaryLike[] = []
  /** Values returned by the optional `projections()` face (contextPressure lives here). */
  projectionValues: Record<string, unknown> | null = null

  async create(): Promise<{ sessionId: string }> {
    this.created += 1
    return { sessionId: `session-new-${this.created}` }
  }

  async selectModel(request: { sessionId: string }): Promise<unknown> {
    this.selectModels.push(request.sessionId)
    return {}
  }

  async rename(request: { sessionId: string; title: string }): Promise<unknown> {
    this.renames.push(request.sessionId)
    return {}
  }

  async prompt(request: { sessionId: string; content: Array<{ type: 'text'; text: string }> }): Promise<{ accepted: boolean }> {
    this.prompts.push({ sessionId: request.sessionId, text: request.content[0]?.text ?? '' })
    return { accepted: true }
  }

  async cancel(): Promise<unknown> {
    return {}
  }

  async list(): Promise<{ items: SessionSummaryLike[] }> {
    return { items: this.listItems }
  }

  async state(): Promise<{ running: boolean }> {
    return { running: false }
  }

  async projections(): Promise<{ kind: string; values: Record<string, unknown> } | null> {
    return this.projectionValues === null ? null : { kind: 'sequenced', values: this.projectionValues }
  }
}

interface FakeCompression {
  adapter: DispatchContextCompression
  readonly measured: string[]
  readonly compacted: string[]
  readonly configReads: number[]
}

function fakeCompression(options: {
  config?: ContextCompressionConfig
  measurement?: ContextMeasurement | null
  outcome?: CompactionOutcome
} = {}): FakeCompression {
  const measured: string[] = []
  const compacted: string[] = []
  const configReads: number[] = []
  const config = options.config ?? { enabled: true, threshold: 80 }
  const measurement = options.measurement === undefined
    ? { usedTokens: 900, windowTokens: 1000, source: 'provider' as const }
    : options.measurement
  const outcome = options.outcome ?? { ok: true }
  return {
    measured,
    compacted,
    configReads,
    adapter: {
      config: () => {
        configReads.push(1)
        return config
      },
      measure: async (sessionId) => {
        measured.push(sessionId)
        return measurement
      },
      compact: async (sessionId) => {
        compacted.push(sessionId)
        return outcome
      },
    },
  }
}

async function dispatchWith(
  compression: FakeCompression | null,
  overrides: {
    requirement?: RequirementView
    options?: { reuseSessionId?: string }
    workspace?: null
  } = {},
): Promise<{ controller: FakeController; log: string[]; outcome: Awaited<ReturnType<Dispatcher['dispatch']>> }> {
  const controller = new FakeController()
  const log: string[] = []
  const dispatcher = new Dispatcher(
    controller,
    () => null,
    (message) => { log.push(message) },
    new AbortController().signal,
    compression === null ? null : compression.adapter,
  )
  const outcome = await dispatcher.dispatch(
    overrides.requirement ?? requirement(),
    MATE,
    PROJECT,
    null,
    overrides.options ?? { reuseSessionId: 'session-reused' },
  )
  return { controller, log, outcome }
}

describe('dispatch context compression gate', () => {
  it('disabled + over threshold: no measurement, no compaction, original dispatch', async () => {
    const compression = fakeCompression({ config: { enabled: false, threshold: 80 } })
    const { controller, outcome } = await dispatchWith(compression)
    expect(compression.measured).toEqual([])
    expect(compression.compacted).toEqual([])
    expect(controller.created).toBe(0)
    expect(controller.prompts).toHaveLength(1)
    expect(controller.prompts[0]?.sessionId).toBe('session-reused')
    expect(controller.prompts[0]?.text).toBe(buildBrief(requirement(), MATE, PROJECT, true))
    expect(outcome.reused).toBe(true)
    expect(outcome.sessionId).toBe('session-reused')
  })

  it('disabled + under threshold: identical behaviour to the pre-feature dispatch', async () => {
    const compression = fakeCompression({
      config: { enabled: false, threshold: 80 },
      measurement: { usedTokens: 100, windowTokens: 1000, source: 'provider' },
    })
    const { controller } = await dispatchWith(compression)
    expect(compression.measured).toEqual([])
    expect(compression.compacted).toEqual([])
    expect(controller.created).toBe(0)
    expect(controller.prompts[0]?.text).toBe(buildBrief(requirement(), MATE, PROJECT, true))
  })

  it('enabled + under threshold: measures once but keeps the reused session and the same prompt', async () => {
    const compression = fakeCompression({
      config: { enabled: true, threshold: 80 },
      measurement: { usedTokens: 500, windowTokens: 1000, source: 'provider' },
    })
    const { controller, log } = await dispatchWith(compression)
    expect(compression.measured).toEqual(['session-reused'])
    expect(compression.compacted).toEqual([])
    expect(controller.created).toBe(0)
    expect(controller.prompts[0]?.sessionId).toBe('session-reused')
    expect(controller.prompts[0]?.text).toBe(buildBrief(requirement(), MATE, PROJECT, true))
    const decisionLog = log.find((line) => line.includes('context-compression:'))
    expect(decisionLog).toContain('reason=below-threshold')
    expect(decisionLog).toContain('strategy=none')
  })

  it('enabled + over threshold: compacts the reused session and dispatches into it', async () => {
    const compression = fakeCompression({ config: { enabled: true, threshold: 80 } })
    const { controller, log, outcome } = await dispatchWith(compression)
    expect(compression.measured).toEqual(['session-reused'])
    expect(compression.compacted).toEqual(['session-reused'])
    expect(controller.created).toBe(0)
    expect(controller.prompts).toHaveLength(1)
    expect(controller.prompts[0]?.sessionId).toBe('session-reused')
    expect(controller.prompts[0]?.text).toBe(buildBrief(requirement(), MATE, PROJECT, true))
    expect(outcome.reused).toBe(true)
    const decisionLog = log.find((line) => line.includes('context-compression:'))
    expect(decisionLog).toContain('reason=threshold-reached')
    expect(decisionLog).toContain('threshold=80%')
    expect(decisionLog).toContain('usage=90.0%')
    expect(decisionLog).toContain('strategy=compress')
  })

  it('enabled + over threshold + compaction busy: falls back to a fresh session with a handoff summary', async () => {
    const compression = fakeCompression({
      config: { enabled: true, threshold: 80 },
      outcome: { ok: false, reason: 'busy: an active turn owns the session' },
    })
    const { controller, log, outcome } = await dispatchWith(compression)
    expect(compression.compacted).toEqual(['session-reused'])
    expect(controller.created).toBe(1)
    expect(controller.prompts).toHaveLength(1)
    const prompt = controller.prompts[0]!
    expect(prompt.sessionId).toBe('session-new-1')
    expect(prompt.text.startsWith('# Handoff summary (fresh session)')).toBe(true)
    expect(prompt.text).toContain(`Target project: Mate (${PROJECT})`)
    expect(prompt.text).toContain('Current task: 派发前上下文压缩与回退')
    expect(prompt.text).toContain('Completed work items:')
    // The requirement brief still follows the handoff summary.
    expect(prompt.text).toContain(buildBrief(requirement(), MATE, PROJECT, false))
    expect(outcome.reused).toBe(false)
    expect(outcome.sessionId).toBe('session-new-1')
    expect(outcome.warnings.some((warning) => warning.code === 'context-compression-fallback')).toBe(true)
    const decisionLog = log.find((line) => line.includes('context-compression:'))
    expect(decisionLog).toContain('reason=threshold-reached')
    expect(decisionLog).toContain('threshold=80%')
    expect(decisionLog).toContain('usage=90.0%')
    expect(decisionLog).toContain('strategy=new-session')
    expect(decisionLog).toContain('failure=busy')
  })

  it('enabled + over threshold + no compaction service: falls back to a fresh session', async () => {
    const compression = fakeCompression({
      config: { enabled: true, threshold: 80 },
      outcome: { ok: false, reason: 'compaction-service-unavailable' },
    })
    const { controller } = await dispatchWith(compression)
    expect(controller.created).toBe(1)
    expect(controller.prompts[0]?.sessionId).toBe('session-new-1')
    expect(controller.prompts[0]?.text.startsWith('# Handoff summary (fresh session)')).toBe(true)
  })

  it('a new dispatch (mode=new) never measures or compacts', async () => {
    const compression = fakeCompression({ config: { enabled: true, threshold: 80 } })
    const { controller } = await dispatchWith(compression, {
      requirement: requirement({
        plan: { targetProjectPath: PROJECT, dispatchMode: 'new', extraInstruction: '', at: 0 },
      }),
    })
    expect(compression.measured).toEqual([])
    expect(compression.compacted).toEqual([])
    expect(controller.created).toBe(1)
    expect(controller.prompts).toHaveLength(1)
    expect(controller.prompts[0]?.text).toBe(buildBrief(requirement(), MATE, PROJECT, false))
  })

  it('carries completed and remaining work items from the previous result', async () => {
    const compression = fakeCompression({ outcome: { ok: false, reason: 'no-compactable-range' } })
    const { controller } = await dispatchWith(compression, {
      requirement: requirement({
        result: {
          doneSummary: '实现了初版',
          acceptance: [{ item: '调用链梳理通过', met: true }, { item: '未完成的验收点', met: false }],
          remaining: ['补测试'],
          followUps: [],
          at: 0,
        },
      }),
    })
    const text = controller.prompts[0]!.text
    expect(text).toContain('- 调用链梳理通过')
    expect(text).not.toContain('- 未完成的验收点')
    expect(text).toContain('Remaining work items:')
    expect(text).toContain('- 补测试')
  })

  it('bounds the handoff summary and keeps exactly one prompt', async () => {
    const compression = fakeCompression({ outcome: { ok: false, reason: 'no-compactable-range' } })
    const longBrief = 'long brief '.repeat(800)
    const { controller } = await dispatchWith(compression, {
      requirement: requirement({ brief: longBrief }),
    })
    const text = controller.prompts[0]!.text
    const handoff = text.slice(0, text.indexOf('\n\nYou are implementing'))
    expect(handoff.length).toBeGreaterThan(0)
    expect(handoff.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS)
    expect(controller.prompts).toHaveLength(1)
  })

  it('degrades to a minimal summary when no history exists', async () => {
    const compression = fakeCompression({ outcome: { ok: false, reason: 'no-compactable-range' } })
    const { controller } = await dispatchWith(compression, { requirement: requirement() })
    const text = controller.prompts[0]!.text
    expect(text).toContain('(none recorded yet; start from the current task)')
    expect(text).not.toContain('Remaining work items:')
  })
})

// ---------------------------------------------------------------- settings

/** Minimal in-memory storage domain for the `MateStore` contract. */
class FakeDomain {
  private globalValue: MateGlobalRecord
  private readonly tables = new Map<string, Map<string, unknown>>()

  constructor(seed?: MateGlobalRecord) {
    this.globalValue = seed === undefined
      ? JSON.parse(JSON.stringify(mateDomain.global.initial)) as MateGlobalRecord
      : seed
  }

  readonly global = {
    get: (): MateGlobalRecord => this.globalValue,
    set: async (value: MateGlobalRecord): Promise<void> => { this.globalValue = value },
  }

  /** Simulate a pre-feature storage row: drop the contextCompression section. */
  removeContextCompression(): void {
    const next = { ...this.globalValue }
    delete (next as { contextCompression?: unknown }).contextCompression
    this.globalValue = next
  }

  table(name: string): {
    get(key: string): unknown
    entries(): IterableIterator<[string, unknown]>
    put(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<boolean>
    update(key: string, transform: (current: unknown) => unknown): Promise<unknown>
  } {
    let rows = this.tables.get(name)
    if (rows === undefined) {
      rows = new Map()
      this.tables.set(name, rows)
    }
    const map = rows
    return {
      get: (key) => map.get(key),
      entries: () => map.entries(),
      put: async (key, value) => { map.set(key, value) },
      delete: async (key) => map.delete(key),
      update: async (key, transform) => {
        const next = transform(map.get(key))
        map.set(key, next)
        return next
      },
    }
  }
}

function createSettingsApp(
  domain: FakeDomain = new FakeDomain(),
  controller: SessionControllerLike = new FakeController(),
  options: { contextWindow?: (provider: string, model: string) => Promise<number | null>; log?: (message: string) => void } = {},
): { app: MateApp; store: MateStore; domain: FakeDomain; controller: SessionControllerLike } {
  const store = new MateStore(domain as unknown as Domain<MateDomain>)
  const app = new MateApp({
    store,
    controller,
    analyzer: null,
    reasoning: null,
    transcript: null,
    workspaceController: null,
    log: options.log ?? (() => {}),
    ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
  })
  return { app, store, domain, controller }
}

describe('context compression settings', () => {
  it('defaults to disabled with threshold 80 when the stored section is missing', async () => {
    const domain = new FakeDomain()
    domain.removeContextCompression()
    const { app, store } = createSettingsApp(domain)
    expect(store.contextCompression()).toEqual({ enabled: false, threshold: 80 })
    const snapshot = await app.snapshot({})
    expect(snapshot.snapshot?.settings.contextCompression).toEqual({ enabled: false, threshold: 80 })
  })

  it('persists a valid policy and exposes it in the settings view and snapshot', async () => {
    const { app, store } = createSettingsApp()
    const view = await app.command({
      command: COMMANDS.settingsUpdate,
      args: { contextCompression: { enabled: true, threshold: 65 } },
    }) as SettingsView
    expect(view.contextCompression).toEqual({ enabled: true, threshold: 65 })
    expect(store.settings().contextCompression).toEqual({ enabled: true, threshold: 65 })
    expect(store.contextCompression()).toEqual({ enabled: true, threshold: 65 })
    const snapshot = await app.snapshot({})
    expect(snapshot.snapshot?.settings.contextCompression).toEqual({ enabled: true, threshold: 65 })
  })

  it('rejects an invalid threshold without touching the stored config', async () => {
    const { app, store } = createSettingsApp()
    await app.command({
      command: COMMANDS.settingsUpdate,
      args: { contextCompression: { enabled: true, threshold: 70 } },
    })
    for (const threshold of [0, 101, 80.5, 'eighty']) {
      const attempt = app.command({
        command: COMMANDS.settingsUpdate,
        args: { contextCompression: { enabled: true, threshold } },
      })
      await expect(attempt).rejects.toBeInstanceOf(CommandError)
      await expect(attempt).rejects.toMatchObject({ code: 'context-compression-invalid' })
      expect(store.settings().contextCompression).toEqual({ enabled: true, threshold: 70 })
    }
  })

  it('keeps a saved policy across a Host restart (same storage domain)', async () => {
    const first = createSettingsApp()
    await first.app.command({
      command: COMMANDS.settingsUpdate,
      args: { contextCompression: { enabled: true, threshold: 45 } },
    })
    first.app.dispose()

    const second = createSettingsApp(first.domain)
    expect(second.store.contextCompression()).toEqual({ enabled: true, threshold: 45 })
    const snapshot = await second.app.snapshot({})
    expect(snapshot.snapshot?.settings.contextCompression).toEqual({ enabled: true, threshold: 45 })
  })

  it('accepts a pre-feature storage global that has no contextCompression section', () => {
    // The durable boundary re-validates the stored global; an old mate.json
    // without this section must still open (the section is optional).
    const legacy = {
      seq: 3,
      defaultMateId: null,
      pollMs: 2500,
      reuseIdleSession: false,
      lastProjectPath: null,
      lastStartedAt: 1700000000000,
      schedule: { models: [], holidays: [], timezone: null },
      clientTimeZone: null,
    }
    const parsed = mateDomain.global.schema.parse(legacy) as { contextCompression?: unknown }
    expect(parsed.contextCompression).toBeUndefined()
    expect(resolveContextCompressionConfig(parsed.contextCompression)).toEqual({ enabled: false, threshold: 80 })
  })

  it('applies the persisted policy to a real reused dispatch through the Host', async () => {
    const controller = new FakeController()
    controller.listItems = [{
      sessionId: 'session-reused',
      cwd: PROJECT,
      running: false,
      updatedAt: 0,
    }]
    const { app, store } = createSettingsApp(new FakeDomain(), controller)
    await store.putMate(MATE)
    await store.updateSettings({ contextCompression: { enabled: true, threshold: 80 } })
    const seeded = requirement({
      analysis: {
        provider: 'p',
        model: 'm',
        summary: 'summary',
        confidence: 0.9,
        needsClarification: false,
        subTasks: [],
        risks: [],
        questions: [],
        splitSuggestion: [],
        suggestedProjectPath: null,
        reuseSessionId: 'session-reused',
        sessionModel: null,
        at: 0,
      },
      plan: { targetProjectPath: PROJECT, dispatchMode: 'auto', extraInstruction: '', at: 0 },
    })
    await store.putRequirement(seeded)
    app.setContextMeter(async () => ({ usedTokens: 900, windowTokens: 1000 }))
    app.setContextCompactor(async () => ({ ok: false, reason: 'busy' }))

    await app.command({ command: COMMANDS.requirementRedispatch, args: { id: seeded.id } })
    await app.waitForBackground()

    const stored = store.getRequirement(seeded.id)!
    expect(stored.status).toBe('running')
    expect(stored.dispatch?.sessionId).toBe('session-new-1')
    expect(stored.dispatch?.reused).toBe(false)
    expect(stored.errors.some((error) => error.code === 'context-compression-fallback')).toBe(true)
    // Exactly one dispatch: into the fresh session, carrying the handoff summary.
    expect(controller.prompts).toHaveLength(1)
    expect(controller.prompts[0]?.sessionId).toBe('session-new-1')
    expect(controller.prompts[0]?.text.startsWith('# Handoff summary (fresh session)')).toBe(true)
    expect(controller.prompts[0]?.text).toContain(`Target project: Mate (${PROJECT})`)
  })

  it('measures through the controller projection face and prefers the route window', async () => {
    const controller = new FakeController()
    controller.listItems = [{
      sessionId: 'session-reused',
      cwd: PROJECT,
      running: false,
      updatedAt: 0,
    }]
    // projectedTokens = 900. The stored window (4000) belongs to the old model;
    // the dispatch route advertises 1000, so occupancy is 90% -> compress.
    controller.projectionValues = {
      contextPressure: { pressureTokens: 500, projectedTokens: 900, contextWindow: 4000 },
    }
    const log: string[] = []
    let compacted = 0
    const { app, store } = createSettingsApp(new FakeDomain(), controller, {
      contextWindow: async () => 1000,
      log: (message) => { log.push(message) },
    })
    await store.putMate(MATE)
    await store.updateSettings({ contextCompression: { enabled: true, threshold: 80 } })
    const seeded = requirement({
      analysis: {
        provider: 'p',
        model: 'm',
        summary: 'summary',
        confidence: 0.9,
        needsClarification: false,
        subTasks: [],
        risks: [],
        questions: [],
        splitSuggestion: [],
        suggestedProjectPath: null,
        reuseSessionId: 'session-reused',
        sessionModel: null,
        at: 0,
      },
      plan: { targetProjectPath: PROJECT, dispatchMode: 'auto', extraInstruction: '', at: 0 },
    })
    await store.putRequirement(seeded)
    // No token-meter/estimator wired: the projection face alone must measure it,
    // including for a cold session with no live body to meter.
    app.setContextCompactor(async () => {
      compacted += 1
      return { ok: true, tokensFreed: 100 }
    })

    await app.command({ command: COMMANDS.requirementRedispatch, args: { id: seeded.id } })
    await app.waitForBackground()

    expect(compacted).toBe(1)
    expect(controller.created).toBe(0)
    expect(controller.prompts[0]?.sessionId).toBe('session-reused')
    const decisionLog = log.find((line) => line.includes('context-compression:'))
    expect(decisionLog).toContain('usage=90.0%')
    expect(decisionLog).toContain('tokens=900/1000')
    expect(decisionLog).toContain('strategy=compress')
  })
})
