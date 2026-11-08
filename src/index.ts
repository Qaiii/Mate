import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { MateAnalyzer } from './analyzer.js'
import { CommandError, MateApp } from './app.js'
import { estimateTokensFromSessionSnapshot } from './compression.js'
import { mateDomain } from './domain.js'
import type { SessionControllerLike, WorkspaceControllerLike } from './dispatch.js'
import { API, type CommandRequest, type StateRequest } from './shared.js'
import { MateStore } from './store.js'

/** Package name; the bundle row id in cordis.patch.yml is `dsh-mate` too. */
export const name = 'dsh-mate'

/** Host services Mate needs before it can accept commands. */
export const inject = ['storageDomain', 'llm', 'sessionController']

interface InitState {
  app: MateApp | null
  error: string | null
}

function json(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

function textOfMessage(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: string } =>
      block !== null && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** Ask the LLM runtime for the adapter-owned reasoning levels of one model. */
function makeReasoningReader(
  llm: unknown,
): ((provider: string, model: string) => Promise<{ efforts: Array<{ id: string; name: string; description?: string }>; defaultEffort?: string } | null>) | null {
  const service = llm as {
    resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<{
      reasoning?: {
        efforts?: Array<{ id: string; name: string; description?: string }>
        defaultEffort?: string
      }
    }>
  } | null | undefined
  if (service === null || service === undefined || typeof service.resolveModelInfo !== 'function') return null
  return async (provider, model) => {
    try {
      const info = await service.resolveModelInfo!(provider, model)
      const efforts = (info.reasoning?.efforts ?? []).map((effort) => ({
        id: effort.id,
        name: effort.name,
        ...(effort.description === undefined ? {} : { description: effort.description }),
      }))
      return {
        efforts,
        ...(info.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort }),
      }
    } catch {
      return null
    }
  }
}
/**
 * Read one route's context-window capacity from the LLM adapter metadata. The
 * pre-dispatch context gate needs it to turn token usage into an occupancy
 * percentage; `null` means "this adapter does not advertise capacity", which
 * makes the gate skip the compression branch.
 */
function makeContextWindowReader(
  llm: unknown,
): ((provider: string, model: string) => Promise<number | null>) | null {
  const service = llm as {
    resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<{
      context?: { contextWindow?: number }
    }>
  } | null | undefined
  if (service === null || service === undefined || typeof service.resolveModelInfo !== 'function') return null
  return async (provider, model) => {
    try {
      const info = await service.resolveModelInfo!(provider, model)
      const window = info.context?.contextWindow
      return typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : null
    } catch {
      return null
    }
  }
}

/** Reduce a validated session log to a bounded transcript for the summarizer. */
function reduceTranscript(snapshot: unknown): string {
  return reduceMessages(snapshot)
    .map((message) => `${message.role === 'user' ? 'USER' : 'ASSISTANT'}: ${message.text}`)
    .join('\n\n')
    .slice(-20000)
}

/** Reduce a validated session log to readable chat turns for the preview drawer. */
function reduceMessages(snapshot: unknown): Array<{ role: 'user' | 'assistant'; text: string }> {
  const events = (snapshot as { events?: unknown })?.events
  if (!Array.isArray(events)) return []
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const record = event as { type?: unknown; data?: Record<string, unknown> }
    if (record.type !== 'user/message' && record.type !== 'assistant/message') continue
    const text = textOfMessage(record.data?.message).trim()
    if (text.length === 0) continue
    messages.push({ role: record.type === 'user/message' ? 'user' : 'assistant', text: text.slice(0, 4000) })
  }
  return messages.slice(-80)
}

/**
 * Host half of Mate. Registers exact Fetch routes on the `connection` service
 * and owns the requirement lifecycle, model calls, and session dispatch.
 */
export function apply(ctx: Context): void {
  const state: InitState = { app: null, error: null }
  const log = (message: string): void => { console.warn(message) }

  ctx.inject(['storageDomain', 'llm', 'sessionController'], (scope) => {
    const services = scope as unknown as {
      storageDomain: { open(spec: typeof mateDomain): Promise<{ close(): Promise<void> }> }
      llm: ConstructorParameters<typeof MateAnalyzer>[0] | null | undefined
      get(name: string): unknown
    }
    const controller = services.get('sessionController') as SessionControllerLike | undefined
    if (controller === undefined) {
      state.error = 'sessionController is unavailable'
      return
    }
    const storageDomain = services.storageDomain
    const llm = services.llm

    // The inject callback's context is transient: every long-lived effect must
    // be created on the plugin's own context, including after an await.
    ctx.effect(() => {
      let cancelled = false
      void (async () => {
        try {
          const domain = await storageDomain.open(mateDomain)
          if (cancelled) {
            await domain.close()
            return
          }
          ctx.effect(() => () => { void domain.close() }, 'dsh-mate: storage domain')

          const store = new MateStore(domain as never)
          const analyzer = llm ? new MateAnalyzer(llm as unknown as ConstructorParameters<typeof MateAnalyzer>[0]) : null
          const reasoning = makeReasoningReader(llm)
          const contextWindow = makeContextWindowReader(llm)
          const app = new MateApp({
            store,
            controller,
            analyzer,
            reasoning,
            transcript: null,
            workspaceController: null,
            log,
            contextWindow,
          })
          await app.refreshModelCatalog()
          await app.markStarted()
          if (cancelled) return
          state.app = app
          // Recover requirements queued while the Host was down (FIFO persisted,
          // so a restart never loses the order) and arm the wake timer for the rest.
          await app.resume()

          ctx.inject(['sessionQuery'], (queryScope) => {
            const query = (queryScope as unknown as { get(name: string): unknown }).get('sessionQuery') as
              {
                readSession(id: string): Promise<unknown>
                readSurface?: (id: string) => Promise<unknown>
              } | undefined
            if (query === undefined || typeof query.readSession !== 'function') return
            app.setTranscriptReader(async (sessionId) => reduceTranscript(await query.readSession(sessionId)))
            app.setMessageReader(async (sessionId) => reduceMessages(await query.readSession(sessionId)))
            // Cold sessions have no live body for the token meter, so the
            // durable surface + fixed heuristic is the documented fallback
            // measure. `readSurface` excludes shadowed (already-compacted)
            // history; the raw log would double-count it.
            app.setContextEstimator(async (sessionId) => {
              if (typeof query.readSurface === 'function') {
                try {
                  return estimateTokensFromSessionSnapshot(await query.readSurface(sessionId))
                } catch {
                  // Fall through to the raw log when the surface fold is unavailable.
                }
              }
              return estimateTokensFromSessionSnapshot(await query.readSession(sessionId))
            })
          })

          // Provider-backed occupancy: `ctx.tokenMeter` needs the live Session
          // body from `ctx.sessions`. When either service is absent (headless
          // profiles, older Hosts) measurement falls back to the estimator.
          ctx.inject(['tokenMeter', 'sessions'], (meterScope) => {
            const meterServices = meterScope as unknown as { get(name: string): unknown }
            const tokenMeter = meterServices.get('tokenMeter') as {
              contextPressure?: (session: unknown) => { pressureTokens?: number; contextWindow?: number } | undefined
              measure?: (session: unknown, header?: unknown) => { totalTokens?: number } | undefined
            } | undefined
            const sessions = meterServices.get('sessions') as { get(id: string): unknown | undefined } | undefined
            if (tokenMeter === undefined || sessions === undefined) return
            app.setContextMeter(async (sessionId) => {
              const session = sessions.get(sessionId)
              if (session === undefined || session === null) return null
              let pressure: { pressureTokens?: number; contextWindow?: number } | undefined
              try {
                pressure = typeof tokenMeter.contextPressure === 'function'
                  ? tokenMeter.contextPressure(session)
                  : undefined
              } catch {
                pressure = undefined
              }
              const windowTokens = typeof pressure?.contextWindow === 'number' ? pressure.contextWindow : null
              // `contextPressure()` only exposes pressureTokens/contextWindow;
              // projectedTokens lives in the projection face and is read by the
              // app's `projectionPressure()` path instead.
              const pressureUsed = pressure?.pressureTokens ?? null
              if (typeof pressureUsed === 'number' && Number.isFinite(pressureUsed)) {
                return { usedTokens: pressureUsed, windowTokens }
              }
              // A session with no completed call has no provider anchor yet;
              // `measure()` still prices the current surface heuristically.
              try {
                const measured = typeof tokenMeter.measure === 'function' ? tokenMeter.measure(session) : undefined
                if (measured === undefined || measured === null || typeof measured.totalTokens !== 'number') return null
                return { usedTokens: measured.totalTokens, windowTokens }
              } catch {
                return null
              }
            })
          })

          // Compaction: `ctx.compaction.compactNow` operates on a live idle
          // Agent. A cold session has none, which is exactly the documented
          // "compaction unavailable -> fresh session" fallback path.
          ctx.inject(['agents', 'compaction'], (compactionScope) => {
            const compactionServices = compactionScope as unknown as { get(name: string): unknown }
            const agents = compactionServices.get('agents') as { get(id: string): unknown | undefined } | undefined
            const compaction = compactionServices.get('compaction') as {
              compactNow?: (agent: unknown, signal?: AbortSignal) => Promise<{ shadowedTokenCount?: number } | null>
            } | undefined
            if (agents === undefined || compaction === undefined || typeof compaction.compactNow !== 'function') return
            app.setContextCompactor(async (sessionId, signal) => {
              const agent = agents.get(sessionId)
              if (agent === undefined || agent === null) {
                return { ok: false, reason: 'no-live-agent (the session has no idle Agent to compact)' }
              }
              try {
                const result = await compaction.compactNow!(agent, signal)
                if (result === null || result === undefined) return { ok: false, reason: 'no-compactable-range' }
                return {
                  ok: true,
                  ...(typeof result.shadowedTokenCount === 'number' ? { tokensFreed: result.shadowedTokenCount } : {}),
                }
              } catch (error) {
                return { ok: false, reason: error instanceof Error ? error.message : String(error) }
              }
            })
          })

          // The Workspace controller is optional: when it is absent the dispatcher
          // falls back to headless sessions, so Mate still works in headless/CLI
          // profiles. When present it lets dispatched sessions attach to the
          // project's Workspace and appear in the sidebar.
          ctx.inject(['workspaceController'], (workspaceScope) => {
            const workspaceController = (workspaceScope as unknown as { get(name: string): unknown }).get('workspaceController') as
              WorkspaceControllerLike | undefined
            if (workspaceController === undefined) return
            app.setWorkspaceController(workspaceController)
          })

          // The api-session events are declared by the shipped session-controller
          // package; type the registration locally so Mate does not depend on it.
          const on = (ctx as unknown as {
            on(event: string, listener: (...args: never[]) => void): () => void
          }).on.bind(ctx)
          on('api-session/status', (sessionId: string, running: boolean) => {
            void app.onSessionStatus(sessionId, running)
          })
          on('api-session/error', (sessionId: string, message: string) => {
            void app.onSessionError(sessionId, message)
          })
          ctx.effect(() => {
            const timer = setInterval(() => { void app.reconcile() }, 15_000)
            return () => { clearInterval(timer) }
          }, 'dsh-mate: monitor timer')
          void app.reconcile()
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error)
          log(`[dsh-mate] initialization failed: ${String(error)}`)
        }
      })()
      return () => {
        cancelled = true
        state.app?.dispose()
        state.app = null
      }
    }, 'dsh-mate: initialization')
  })

  ctx.inject(['connection'], (scope) => {
    const connection = (scope as unknown as { get(name: string): unknown }).get('connection') as
      { fetch?: { register?: (route: Record<string, unknown>) => () => void } } | undefined
    const register = connection?.fetch?.register
    if (typeof register !== 'function') {
      log('[dsh-mate] connection.fetch.register is unavailable; the Mate panel cannot reach the host half')
      return
    }

    const route = (path: string, handler: (body: unknown, app: MateApp) => Promise<unknown>): void => {
      scope.effect(() => register({
        path: `/${path}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request): Promise<Response> => {
          let body: unknown = {}
          try {
            const text = await request.text()
            body = text.length > 0 ? JSON.parse(text) : {}
          } catch {
            return json({ ok: false, error: { code: 'bad-json', message: 'the request body is not valid JSON' } })
          }
          const app = state.app
          if (app === null) {
            return json({ ok: false, error: { code: 'starting', message: state.error ?? 'Mate is still starting' } })
          }
          try {
            return json({ ok: true, value: await handler(body, app) })
          } catch (error) {
            const code = error instanceof CommandError ? error.code : 'internal'
            const message = error instanceof Error ? error.message : String(error)
            return json({
              ok: false,
              error: {
                code,
                message,
                detail: error instanceof CommandError ? error.detail : undefined,
              },
            })
          }
        },
      }), `dsh-mate: ${path} route`)
    }

    route(API.ping, async () => ({ pong: true, plugin: name, at: Date.now() }))
    route(API.state, async (body, app) => {
      const request = (body ?? {}) as StateRequest
      return app.snapshot(request)
    })
    route(API.command, async (body, app) => app.command(body as CommandRequest))
  })
}
