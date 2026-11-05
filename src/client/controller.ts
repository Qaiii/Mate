import type { Snapshot } from '../shared.js'
import { fetchState, runCommand } from './api.js'

export interface Notice {
  kind: 'ok' | 'error'
  text: string
  at: number
}

export interface MateState {
  phase: 'loading' | 'ready' | 'error'
  rev: number
  snapshot: Snapshot | null
  error: string | null
  busy: Record<string, boolean>
  notice: Notice | null
  lastSyncAt: number
}

export interface ControllerOptions {
  language: () => string
  pollMs?: number
}

type Listener = () => void

/**
 * React-free snapshot store: owns polling, a stable state object, and the
 * command channel. Components subscribe through `useSyncExternalStore`.
 */
export class MateController {
  private state: MateState = {
    phase: 'loading',
    rev: 0,
    snapshot: null,
    error: null,
    busy: {},
    notice: null,
    lastSyncAt: 0,
  }

  private readonly listeners = new Set<Listener>()
  private timer: ReturnType<typeof setInterval> | null = null
  private abort: AbortController | null = null
  private started = false
  private polling = false

  constructor(private readonly options: ControllerOptions) {}

  readonly getSnapshot = (): MateState => this.state

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  start(): void {
    if (this.started) return
    this.started = true
    void this.refresh(true)
    this.timer = setInterval(() => { void this.refresh(false) }, this.pollMs())
  }

  stop(): void {
    this.started = false
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.abort?.abort()
    this.abort = null
  }

  private pollMs(): number {
    const configured = this.state.snapshot?.settings.pollMs ?? this.options.pollMs ?? 2500
    return Math.max(1000, Math.min(30_000, configured))
  }

  async refresh(force: boolean): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const response = await fetchState(force ? undefined : this.state.rev)
      if (response.unchanged) {
        this.patch({ lastSyncAt: Date.now(), phase: 'ready', error: null })
        return
      }
      if (response.snapshot !== undefined) {
        this.patch({
          phase: 'ready',
          rev: response.rev,
          snapshot: response.snapshot,
          error: null,
          lastSyncAt: Date.now(),
        })
      }
    } catch (error) {
      this.patch({
        phase: this.state.snapshot === null ? 'error' : 'ready',
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.polling = false
    }
  }

  /** Run one command, then force a snapshot refresh. Returns the command value. */
  async run<T = unknown>(key: string, command: string, args: object = {}): Promise<T | null> {
    this.patch({ busy: { ...this.state.busy, [key]: true } })
    try {
      const requestId = `mate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const payload = { ...(args as Record<string, unknown>), language: this.options.language() }
      const response = await runCommand(command, payload, requestId)
      await this.refresh(true)
      if (response.ok) {
        this.notify('ok', '')
        return response.value as T
      }
      return null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.notify('error', message)
      return null
    } finally {
      const busy = { ...this.state.busy }
      delete busy[key]
      this.patch({ busy })
    }
  }

  notify(kind: 'ok' | 'error', text: string): void {
    this.patch({ notice: { kind, text, at: Date.now() } })
  }

  clearNotice(): void {
    this.patch({ notice: null })
  }

  private patch(partial: Partial<MateState>): void {
    this.state = { ...this.state, ...partial }
    for (const listener of this.listeners) {
      try { listener() } catch { /* a broken subscriber must not stop polling */ }
    }
  }
}
