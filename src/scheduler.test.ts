import { describe, expect, it } from 'vitest'
import { MateQueue, MAX_WAIT_MS, MIN_WAIT_MS, RECHECK_MS } from './scheduler.js'
import type { RequirementView } from './shared.js'

/** Monday 2026-01-05 10:00 UTC — inside a weekday 00:00-12:00 disabled window. */
const BASE = Date.UTC(2026, 0, 5, 10, 0, 0)

function requirement(
  id: string,
  number: number,
  nextWakeAt: number | null,
  status: RequirementView['status'] = 'queued',
): RequirementView {
  return {
    id,
    number,
    title: id,
    brief: id,
    projectPath: '',
    projectTitle: '',
    priority: 'normal',
    mateId: 'mate_1',
    mateName: 'Planner',
    mateModel: 'p/m',
    parentId: null,
    kind: 'requirement',
    status,
    autonomy: 'confirm',
    sessionOverrides: null,
    discussion: [],
    analysis: null,
    plan: null,
    dispatch: null,
    result: null,
    errors: [],
    queue: status === 'queued'
      ? {
        phase: 'analyze',
        reason: 'model-window',
        model: { provider: 'p', model: 'm' },
        window: 'weekday 00:00-12:00',
        enqueuedAt: BASE,
        nextWakeAt,
        timezone: 'UTC',
        attempts: 0,
      }
      : null,
    createdAt: BASE,
    updatedAt: BASE,
    rev: 1,
  }
}

/** Controllable timer functions: records delay, clears, and fires on demand. */
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

  /** Fire every armed timer (one tick per timer), as the real scheduler would. */
  fire(): void {
    const due = [...this.active.values()]
    this.active.clear()
    for (const timer of due) timer.fire()
  }
}

type ProcessItem = (item: RequirementView, context: { processed: string[]; logs: string[] }) => Promise<void>

function createHarness(items: RequirementView[], processItem?: ProcessItem) {
  const clock = { value: BASE }
  const timers = new FakeTimers()
  const processed: string[] = []
  const logs: string[] = []
  const queue = new MateQueue({
    now: () => clock.value,
    list: () => [...items],
    process: async (item) => {
      if (processItem !== undefined) {
        await processItem(item, { processed, logs })
        return
      }
      processed.push(item.id)
      const index = items.findIndex((candidate) => candidate.id === item.id)
      if (index >= 0) items.splice(index, 1)
    },
    log: (message) => { logs.push(message) },
    setTimer: timers.set,
    clearTimer: timers.clear,
  })
  return { queue, clock, timers, processed, logs, items }
}

describe('MateQueue refresh (arming)', () => {
  it('arms for the earliest finite nextWakeAt', () => {
    const later = requirement('later', 2, BASE + 60 * 60_000)
    const sooner = requirement('sooner', 1, BASE + 30 * 60_000)
    const { queue, timers } = createHarness([later, sooner])

    queue.refresh()

    expect(queue.nextWakeAt).toBe(BASE + 30 * 60_000)
    expect(queue.armedDelay).toBe(30 * 60_000)
    expect(queue.dueAt).toBe(BASE + 30 * 60_000)
    expect(timers.count).toBe(1)
    expect(timers.delays).toEqual([30 * 60_000])
  })

  it('clamps a wait shorter than one second up to one second', () => {
    const { queue, timers } = createHarness([requirement('soon', 1, BASE + 500)])

    queue.refresh()

    expect(queue.armedDelay).toBe(MIN_WAIT_MS)
    expect(timers.delays).toEqual([MIN_WAIT_MS])
  })

  it('clamps a wait longer than 24h and re-arms with the remaining time', async () => {
    const wakeAt = BASE + 48 * 60 * 60_000
    const items = [requirement('far', 1, wakeAt)]
    const { queue, clock, timers, processed } = createHarness(items)

    queue.refresh()
    expect(queue.armedDelay).toBe(MAX_WAIT_MS)
    expect(timers.delays).toEqual([MAX_WAIT_MS])

    // The 24h clamp fires; nothing is due yet, so the queue re-arms for the rest.
    clock.value = BASE + 24 * 60 * 60_000
    timers.fire()
    await queue.tick()
    expect(processed).toEqual([])
    expect(items).toHaveLength(1)
    expect(timers.delays).toEqual([MAX_WAIT_MS])

    // The real instant arrives: the requirement is processed and the timer clears.
    clock.value = wakeAt + 1
    timers.fire()
    await queue.tick()
    expect(processed).toEqual(['far'])
    expect(timers.count).toBe(0)
  })

  it('rechecks in five minutes when no item has a finite nextWakeAt', () => {
    const { queue, timers } = createHarness([requirement('unknown', 1, null)])

    queue.refresh()

    expect(queue.nextWakeAt).toBeNull()
    expect(queue.armedDelay).toBe(RECHECK_MS)
    expect(timers.delays).toEqual([RECHECK_MS])
  })

  it('arms nothing for an empty queue', () => {
    const { queue, timers } = createHarness([])

    queue.refresh()

    expect(queue.nextWakeAt).toBeNull()
    expect(queue.armedDelay).toBeNull()
    expect(queue.armed).toBe(false)
    expect(timers.count).toBe(0)
  })

  it('ignores requirements that are not queued', () => {
    const items = [
      requirement('running', 1, BASE - 60_000, 'running'),
      requirement('waiting', 2, BASE + 5_000),
    ]
    const { queue, timers } = createHarness(items)

    queue.refresh()

    expect(queue.nextWakeAt).toBe(BASE + 5_000)
    expect(timers.delays).toEqual([5_000])
  })

  it('replaces a previously armed timer instead of stacking them', () => {
    const items = [requirement('a', 1, BASE + 60_000)]
    const { queue, timers } = createHarness(items)

    queue.refresh()
    queue.refresh()

    expect(timers.count).toBe(1)
  })
})

describe('MateQueue tick', () => {
  it('processes every due item in FIFO order and skips the not-yet-due', async () => {
    const items = [
      requirement('due-first', 1, BASE - 1_000),
      requirement('not-due', 2, BASE + 10_000),
      requirement('due-second', 3, BASE),
    ]
    const { queue, timers, processed } = createHarness(items)

    await queue.tick()

    expect(processed).toEqual(['due-first', 'due-second'])
    expect(items.map((item) => item.id)).toEqual(['not-due'])
    expect(timers.delays).toEqual([10_000])
  })

  it('processes an item whose availability instant is unknown', async () => {
    const items = [requirement('unknown', 1, null)]
    const { queue, clock, timers, processed } = createHarness(items)

    queue.refresh()
    clock.value += RECHECK_MS
    timers.fire()
    await queue.tick()

    expect(processed).toEqual(['unknown'])
    expect(timers.count).toBe(0)
  })

  it('logs a failing item and still processes the rest of the pass', async () => {
    const items = [requirement('boom', 1, BASE - 2_000), requirement('fine', 2, BASE - 1_000)]
    const { queue, processed, logs } = createHarness(items, async (item, context) => {
      if (item.id === 'boom') throw new Error('model call exploded')
      context.processed.push(item.id)
    })

    await queue.tick()

    expect(processed).toEqual(['fine'])
    expect(logs.join('\n')).toContain('model call exploded')
    expect(logs.join('\n')).toContain('[dsh-mate] queue: processing requirement boom failed')
  })

  it('shares an in-flight pass instead of double-processing an item', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const items = [requirement('only', 1, BASE - 1_000)]
    const { queue, processed } = createHarness(items, async (item, context) => {
      await gate
      context.processed.push(item.id)
    })

    const first = queue.tick()
    const second = queue.tick()
    release()
    await Promise.all([first, second])

    expect(processed).toEqual(['only'])
  })
})

describe('MateQueue dispose', () => {
  it('clears the armed timer and stops arming or ticking', async () => {
    const items = [requirement('queued', 1, BASE - 1_000)]
    const { queue, timers, processed } = createHarness(items)

    queue.refresh()
    expect(timers.count).toBe(1)

    queue.dispose()
    expect(timers.count).toBe(0)
    expect(queue.armed).toBe(false)

    queue.refresh()
    expect(timers.count).toBe(0)
    await queue.tick()
    expect(processed).toEqual([])
  })
})
