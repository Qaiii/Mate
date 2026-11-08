import React from 'react'
import { MateController } from './controller.js'
import { createTranslator, resolveLanguage, type Translator } from './locales.js'
import { MatePanel } from './panel.js'
import { STYLES } from './ui.js'
import type { MateState } from './controller.js'
import type { PickDirectoryResult } from './types.js'

export const name = 'dsh-mate'

/** Runtime services this browser half waits for. */
export const inject = ['slots', 'uiWorkspace']

/** Shared identity of the main panel and its sidebar entry. */
const PANEL_ID = 'mate'

interface SlotsService {
  inject(key: string, callback: () => unknown): void
  register(options: Record<string, unknown>, component: unknown): unknown
}

interface ClientContext {
  effect(fn: () => () => void, label?: string): void
  slots: SlotsService
  uiWorkspace?: {
    openSession(target: unknown): unknown
    directoryPicker?: { pick(params?: unknown): Promise<unknown> }
  }
  layout?: { selectPanel(panelId: string | null): void }
}

function MateIcon({ size = 20 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 18.5V6.5L12 12.5l8-6v12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12.5" r="1.7" fill="currentColor" />
    </svg>
  )
}

interface PanelFace {
  controller: MateController
  t: Translator
  openSession: (sessionId: string) => void
  pickDirectory: () => Promise<PickDirectoryResult>
}

interface BoundaryProps {
  t: Translator
  children: React.ReactNode
}

interface BoundaryState {
  error: Error | null
}

/**
 * Keeps one failing render from blanking the whole slot: the user sees the
 * rule it broke and can retry, and the Host half keeps running.
 */
class PanelErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error): void {
    console.error('[dsh-mate] panel crashed', error)
  }

  override render(): React.ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <div className="mate-root">
        <div className="mate-panel mate-error-line" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <strong>{this.props.t('error.panelCrashed')}</strong>
          <span className="mate-mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {this.state.error.message}
          </span>
          <div>
            <button type="button" className="mate-btn" onClick={() => this.setState({ error: null })}>
              {this.props.t('action.retry')}
            </button>
          </div>
        </div>
      </div>
    )
  }
}

/** Adapter that binds the React-free controller to the render pass. */
function MatePanelView(face: PanelFace): React.ReactElement {
  const state: MateState = React.useSyncExternalStore(face.controller.subscribe, face.controller.getSnapshot)
  return (
    <PanelErrorBoundary t={face.t}>
      <MatePanel state={state} controller={face.controller} t={face.t} openSession={face.openSession} pickDirectory={face.pickDirectory} />
    </PanelErrorBoundary>
  )
}

/**
 * Browser half: one global main panel, its sidebar entry, and the shared
 * theme-aware stylesheet. All host data arrives through Fetch routes.
 */
export function apply(ctx: ClientContext): void {
  const language = resolveLanguage()
  const t = createTranslator(language)
  const controller = new MateController({ language: () => language })

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.pluginCss = 'dsh-mate'
    style.textContent = STYLES
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dsh-mate: styles')

  ctx.effect(() => () => { controller.stop() }, 'dsh-mate: controller')

  const openSession = (sessionId: string): void => {
    if (sessionId.length === 0) return
    if (ctx.uiWorkspace !== undefined && typeof ctx.uiWorkspace.openSession === 'function') {
      try {
        ctx.uiWorkspace.openSession(sessionId)
        return
      } catch {
        // Fall through to the layout fallback below.
      }
    }
    if (ctx.layout !== undefined) {
      try { ctx.layout.selectPanel(null) } catch { /* leave the current panel as is */ }
    }
  }

  /**
   * Ask the shipped directory picker for one path. Profiles without a native
   * chooser (for example the browser dev profile) report `unavailable` so the
   * dialog can fall back to a manual path entry.
   */
  const pickDirectory = async (): Promise<PickDirectoryResult> => {
    const picker = ctx.uiWorkspace?.directoryPicker?.pick
    if (picker === undefined) return { path: null, unavailable: true }
    try {
      const result = await picker.call(ctx.uiWorkspace?.directoryPicker, {})
      const candidate = typeof result === 'string'
        ? result
        : result !== null && typeof result === 'object' && typeof (result as { path?: unknown }).path === 'string'
          ? (result as { path: string }).path
          : ''
      return { path: candidate.length > 0 ? candidate : null, unavailable: false }
    } catch (error) {
      console.warn('[dsh-mate] directory picker unavailable:', String(error))
      return { path: null, unavailable: true }
    }
  }
  const face: PanelFace = { controller, t, openSession, pickDirectory }

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    inject: () => face,
  }, MatePanelView))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 40,
    label: () => 'Mate',
  }, MateIcon))
}




