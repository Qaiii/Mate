import React from 'react'
import { MateController } from './controller.js'
import { createTranslator, resolveLanguage, type Translator } from './locales.js'
import { MatePanel } from './panel.js'
import { STYLES } from './ui.js'
import type { MateState } from './controller.js'

export const name = 'dsh-mate'

/** Runtime services this browser half waits for. */
export const inject = ['slots']

/** Shared identity of the main panel and its sidebar entry. */
const PANEL_ID = 'mate'

interface SlotsService {
  inject(key: string, callback: () => unknown): void
  register(options: Record<string, unknown>, component: unknown): unknown
}

interface ClientContext {
  effect(fn: () => () => void, label?: string): void
  slots: SlotsService
  uiWorkspace?: { openSession(target: unknown): unknown }
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
}

/** Adapter that binds the React-free controller to the render pass. */
function MatePanelView(face: PanelFace): React.ReactElement {
  const state: MateState = React.useSyncExternalStore(face.controller.subscribe, face.controller.getSnapshot)
  return <MatePanel state={state} controller={face.controller} t={face.t} openSession={face.openSession} />
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

  const face: PanelFace = { controller, t, openSession }

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
