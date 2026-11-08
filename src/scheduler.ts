/**
 * The persisted wake timer for queued requirements.
 *
 * A requirement blocked by a model availability window is stored with
 * `status: 'queued'` and a `queue.nextWakeAt` instant. This module owns the one
 * timer that wakes the Host when the earliest of those instants arrives. It has
 * no storage or model knowledge: the queue order comes from an injected
 * `list()`, and the actual dequeue/re-judgement is an injected `process()`
 * callback (see `MateApp.processQueued`).
 *
 * The clock and the timer functions are injected too, so the whole class is
 * deterministic in unit tests (fake clock + fake `setTimer`/`clearTimer`).
 */
import type { RequirementView } from './shared.js'

/** Opaque timer identity; tests return anything and receive it back on clear. */
export type QueueTimerHandle = unknown

export interface MateQueueDeps {
  /** Injected clock: the current epoch ms. Never read `Date.now()` directly. */
  now: () => number
  /** Queued requirements in FIFO order (the store already sorts them). */
  list: () => RequirementView[]
  /** Re-judge and resume one due requirement; resolves when the attempt is recorded. */
  process: (requirement: RequirementView) => Promise<void>
  /** Diagnostics sink, same `[dsh-mate] …` prefix convention as the rest of the Host. */
  log: (message: string) => void
  /** Timer functions; default to the global `setTimeout`/`clearTimeout`. */
  setTimer?: (fire: () => void, delayMs: number) => QueueTimerHandle
  clearTimer?: (handle: QueueTimerHandle) => void
  /** Short aliases for {@link setTimer} / {@link clearTimer}. */
  set?: (fire: () => void, delayMs: number) => QueueTimerHandle
  /** Short alias for {@link clearTimer}. */
  clear?: (handle: QueueTimerHandle) => void
}

/** A single wait is clamped so a far-away window cannot overflow a timer. */
export const MIN_WAIT_MS = 1_000
export const MAX_WAIT_MS = 24 * 60 * 60 * 1_000
/** Re-check interval when a blocked route has no known next availability. */
export const RECHECK_MS = 5 * 60 * 1_000

interface QueuePlan {
  /** Earliest finite `nextWakeAt` the plan was computed from, or null. */
  nextWakeAt: number | null
  /** Wait actually armed after clamping; `nextWakeAt - now` when in range. */
  delayMs: number
  /** Instant (epoch ms) the armed timer is due. */
  dueAt: number
}

/** The wake timer for the persisted requirement queue. */
export class MateQueue {
  private readonly setTimer: (fire: () => void, delayMs: number) => QueueTimerHandle
  private readonly clearTimer: (handle: QueueTimerHandle) => void
  private handle: QueueTimerHandle | null = null
  private plan: QueuePlan | null = null
  private ticking = false
  private inFlightTick: Promise<void> | null = null
  private disposed = false

  constructor(private readonly deps: MateQueueDeps) {
    const set = deps.setTimer ?? deps.set
    const clear = deps.clearTimer ?? deps.clear
    this.setTimer = set ?? ((fire, delayMs) => {
      const handle = setTimeout(fire, delayMs)
      // A pending wake must not keep the Host process alive.
      const unrefable = handle as { unref?: () => void }
      if (typeof unrefable.unref === 'function') unrefable.unref()
      return handle
    })
    this.clearTimer = clear ?? ((handle) => { clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>) })
  }

  /** Earliest finite `nextWakeAt` the current plan was built from. */
  get nextWakeAt(): number | null {
    return this.plan?.nextWakeAt ?? null
  }

  /** Wait in ms currently armed after clamping; null when no timer is armed. */
  get armedDelay(): number | null {
    return this.plan?.delayMs ?? null
  }

  /** Alias of {@link armedDelay} for readability in assertions. */
  get armedDelayMs(): number | null {
    return this.armedDelay
  }

  /** True while a timer is armed. */
  get armed(): boolean {
    return this.handle !== null
  }

  /** Instant the currently armed timer is due; null when idle. */
  get dueAt(): number | null {
    return this.plan?.dueAt ?? null
  }

  /**
   * Recompute the earliest wake instant and arm the timer for it.
   *
   * - empty queue: no timer is needed, so any existing one is cleared;
   * - no item has a finite `nextWakeAt`: re-check in {@link RECHECK_MS};
   * - otherwise wait `nextWakeAt - now` clamped to [{@link MIN_WAIT_MS},
   *   {@link MAX_WAIT_MS}]. A clamped wait is re-armed after it fires because
   *   {@link tick} recomputes the remaining time.
   */
  refresh(): void {
    if (this.disposed) return
    this.clear()
    const queued = this.deps.list().filter((requirement) => requirement.status === 'queued' && requirement.queue != null)
    if (queued.length === 0) return
    const now = this.deps.now()
    let earliest: number | null = null
    for (const requirement of queued) {
      const wakeAt = requirement.queue?.nextWakeAt
      if (typeof wakeAt !== 'number' || !Number.isFinite(wakeAt)) continue
      if (earliest === null || wakeAt < earliest) earliest = wakeAt
    }
    const delayMs = earliest === null
      ? RECHECK_MS
      : Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, earliest - now))
    this.plan = { nextWakeAt: earliest, delayMs, dueAt: now + delayMs }
    this.handle = this.setTimer(() => {
      this.handle = null
      void this.tick()
    }, delayMs)
  }

  /**
   * Process every due queued requirement in FIFO order, then re-arm.
   *
   * Due means `queue.nextWakeAt === null` (unknown availability — re-check it)
   * or the instant has passed. `process()` is awaited one requirement at a time
   * so FIFO order also holds for the resumed work. A failing item is logged and
   * does not stop the rest of the pass. Concurrent calls share the in-flight
   * pass instead of processing an item twice.
   */
  async tick(): Promise<void> {
    if (this.disposed) return
    if (this.ticking) return this.inFlightTick ?? Promise.resolve()
    this.ticking = true
    const run = (async () => {
      try {
        const now = this.deps.now()
        const due = this.deps.list().filter((requirement) => {
          if (requirement.status !== 'queued' || requirement.queue == null) return false
          const wakeAt = requirement.queue.nextWakeAt
          return wakeAt === null || !Number.isFinite(wakeAt) || wakeAt <= now
        })
        for (const requirement of due) {
          if (this.disposed) return
          try {
            await this.deps.process(requirement)
          } catch (error) {
            this.deps.log(`[dsh-mate] queue: processing requirement ${requirement.id} failed: ${String(error)}`)
          }
        }
      } finally {
        this.ticking = false
        this.inFlightTick = null
        this.refresh()
      }
    })()
    this.inFlightTick = run
    return run
  }

  /** Clear the timer and stop arming new ones (Host unload). */
  dispose(): void {
    this.disposed = true
    this.inFlightTick = null
    this.clear()
  }

  private clear(): void {
    if (this.handle !== null) {
      this.clearTimer(this.handle)
      this.handle = null
    }
    this.plan = null
  }
}
