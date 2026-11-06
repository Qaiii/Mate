import React from 'react'
import { COMMANDS, type RequirementView, type SessionTranscriptView } from '../shared.js'
import type { MateController } from './controller.js'
import type { Translator } from './locales.js'
import { formatRelative, projectLabel } from './types.js'
import { Badge, Button, Spinner } from './ui.js'

const MODE_KEY = 'dsh-mate.session-view'

type SessionView = 'drawer' | 'window'

function readMode(): SessionView {
  try {
    return localStorage.getItem(MODE_KEY) === 'window' ? 'window' : 'drawer'
  } catch {
    return 'drawer'
  }
}

function ModeToggle({ mode, t, onChange }: {
  mode: SessionView
  t: Translator
  onChange: (mode: SessionView) => void
}): React.ReactElement {
  return (
    <div className="mate-viewtoggle" role="group" aria-label={t('session.view')}>
      <button type="button" className={mode === 'drawer' ? 'on' : ''} aria-pressed={mode === 'drawer'} onClick={() => onChange('drawer')}>
        {t('session.viewDrawer')}
      </button>
      <button type="button" className={mode === 'window' ? 'on' : ''} aria-pressed={mode === 'window'} onClick={() => onChange('window')}>
        {t('session.viewWindow')}
      </button>
    </div>
  )
}

/**
 * Read-only preview of one existing session, presented either as the right
 * drawer or as a draggable floating window. Actions that were on the board
 * card live here: open the real session, adopt it as a requirement, or hide it.
 */
export function SessionDrawer({ sessionId, controller, t, lang, onClose, openSession, onAdopted }: {
  sessionId: string
  controller: MateController
  t: Translator
  lang: 'zh' | 'en'
  onClose: () => void
  openSession: (sessionId: string) => void
  onAdopted: (requirementId: string) => void
}): React.ReactElement {
  const [mode, setMode] = React.useState<SessionView>(readMode)
  const [data, setData] = React.useState<SessionTranscriptView | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [attempt, setAttempt] = React.useState(0)
  const [position, setPosition] = React.useState<{ x: number; y: number } | null>(null)
  const frameRef = React.useRef<HTMLDivElement | null>(null)
  const dragRef = React.useRef<{ dx: number; dy: number } | null>(null)

  React.useEffect(() => {
    let cancelled = false
    setError(null)
    setData(null)
    void controller
      .run<SessionTranscriptView>(`transcript:${sessionId}`, COMMANDS.sessionTranscript, { sessionId })
      .then((value) => {
        if (cancelled) return
        if (value === null) {
          setError(controller.getSnapshot().notice?.text ?? t('session.loadFailed'))
        } else {
          setData(value)
        }
      })
    return () => { cancelled = true }
  }, [controller, sessionId, t, attempt])

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [onClose])

  const changeMode = (next: SessionView): void => {
    setMode(next)
    try { localStorage.setItem(MODE_KEY, next) } catch { /* private mode */ }
  }

  const adopt = async (): Promise<void> => {
    setBusy(true)
    try {
      const created = await controller.run<RequirementView>(
        `adopt:${sessionId}`,
        COMMANDS.requirementAdoptSession,
        { sessionId },
      )
      if (created !== null) onAdopted(created.id)
    } finally {
      setBusy(false)
    }
  }

  const hide = (): void => {
    void controller.run(`hide:${sessionId}`, COMMANDS.sessionHide, { sessionId }).then(() => onClose())
  }

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    // Pointer capture would retarget the click away from the toggle and close
    // buttons; only the title area starts a drag.
    if ((event.target as HTMLElement).closest('.mate-window-tools') !== null) return
    const rect = frameRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const drag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const offset = dragRef.current
    if (offset === null) return
    const width = frameRef.current?.offsetWidth ?? 720
    const titlebar = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height')) || 0
    const x = Math.min(Math.max(8, event.clientX - offset.dx), Math.max(8, window.innerWidth - width - 8))
    const y = Math.min(Math.max(titlebar + 8, event.clientY - offset.dy), Math.max(titlebar + 8, window.innerHeight - 80))
    setPosition({ x, y })
  }

  const endDrag = (): void => {
    dragRef.current = null
    const frame = frameRef.current
    if (frame !== null) {
      const titlebar = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height')) || 0
      if (frame.offsetTop < titlebar) setPosition({ x: frame.offsetLeft, y: titlebar + 8 })
    }
  }

  const title = data?.title !== undefined && data.title.length > 0 ? data.title : sessionId

  const meta = (
    <div className="mate-kv">
      <Badge tone="warn">{t('badge.untracked')}</Badge>
      <span>{data?.running === true ? t('status.running') : t('badge.idle')}</span>
      <span>·</span>
      <span>{projectLabel(data?.cwd ?? '') || '—'}</span>
      {data !== null && data.updatedAt > 0 ? (
        <>
          <span>·</span>
          <span>{formatRelative(data.updatedAt, lang)}</span>
        </>
      ) : null}
      <span className="mate-mono">{sessionId}</span>
    </div>
  )

  const actions = (
    <div className="mate-dialog-foot" style={{ justifyContent: 'flex-start' }}>
      <Button variant="primary" onClick={() => openSession(sessionId)}>{t('action.openSession')}</Button>
      <Button busy={busy} onClick={() => { void adopt() }}>{t('action.adopt')}</Button>
      <Button variant="ghost" onClick={hide}>{t('action.hideSession')}</Button>
    </div>
  )

  const preview = (
    <section className="mate-section" style={{ minHeight: 0 }}>
      <h3>{t('session.preview')}</h3>
      {error !== null ? (
        <div className="mate-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="mate-error-line">{t('session.loadFailed')}</div>
          <div className="mate-prose mate-mono" style={{ fontSize: 11.5 }}>{error}</div>
          {/unknown command|unknown-command/i.test(error) ? (
            <div className="mate-prose">{t('session.hostStale')}</div>
          ) : null}
          <div>
            <Button onClick={() => setAttempt((value) => value + 1)}>{t('action.retry')}</Button>
          </div>
        </div>
      ) : data === null ? (
        <div className="mate-panel" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Spinner /> {t('session.loading')}</div>
      ) : data.unavailable !== undefined ? (
        <div className="mate-panel mate-prose">{t('session.unavailable')}: {data.unavailable}</div>
      ) : data.messages.length === 0 ? (
        <div className="mate-panel mate-prose">{t('session.empty')}</div>
      ) : (
        <div className="mate-thread">
          {data.messages.map((message, index) => (
            <div key={index} className={`mate-msg ${message.role === 'user' ? 'user' : 'mate'}`}>
              <div className="mate-msg-role">{message.role === 'user' ? t('session.you') : t('session.assistant')}</div>
              {message.text}
            </div>
          ))}
        </div>
      )}
    </section>
  )

  if (mode === 'window') {
    return (
      <div
        ref={frameRef}
        className="mate-window"
        role="dialog"
        aria-modal="false"
        aria-label={title}
        style={position === null ? undefined : { left: position.x, top: position.y, transform: 'none' }}
      >
        <div className="mate-window-head" onPointerDown={startDrag} onPointerMove={drag} onPointerUp={endDrag} onPointerCancel={endDrag}>
          <div className="mate-window-grip" aria-hidden="true">⠿</div>
          <strong className="mate-window-title">{title}</strong>
          <div className="mate-window-tools">
            <ModeToggle mode={mode} t={t} onChange={changeMode} />
            <Button variant="ghost" onClick={onClose} aria-label="close">✕</Button>
          </div>
        </div>
        <div className="mate-window-body">
          {meta}
          {actions}
          {preview}
        </div>
      </div>
    )
  }

  return (
    <div className="mate-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <aside className="mate-drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="mate-dialog-head">
          <h2>{title}</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <ModeToggle mode={mode} t={t} onChange={changeMode} />
            <Button variant="ghost" onClick={onClose} aria-label="close">✕</Button>
          </div>
        </div>
        {meta}
        {actions}
        {preview}
      </aside>
    </div>
  )
}


