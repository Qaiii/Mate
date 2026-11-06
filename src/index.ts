import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { MateAnalyzer } from './analyzer.js'
import { CommandError, MateApp } from './app.js'
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
          const app = new MateApp({ store, controller, analyzer, transcript: null, workspaceController: null, log })
          await app.refreshModelCatalog()
          await app.markStarted()
          if (cancelled) return
          state.app = app

          ctx.inject(['sessionQuery'], (queryScope) => {
            const query = (queryScope as unknown as { get(name: string): unknown }).get('sessionQuery') as
              { readSession(id: string): Promise<unknown> } | undefined
            if (query === undefined || typeof query.readSession !== 'function') return
            app.setTranscriptReader(async (sessionId) => reduceTranscript(await query.readSession(sessionId)))
            app.setMessageReader(async (sessionId) => reduceMessages(await query.readSession(sessionId)))
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
      const rev = (body as StateRequest | null)?.rev
      return app.snapshot(typeof rev === 'number' ? rev : undefined)
    })
    route(API.command, async (body, app) => app.command(body as CommandRequest))
  })
}
