import React from 'react'
import { COMMANDS, type RequirementView, type SessionTranscriptView } from '../shared.js'
import type { MateController } from './controller.js'
import type { Translator } from './locales.js'
import { formatRelative, projectLabel } from './types.js'
import { Badge, Button, Spinner } from './ui.js'

/**
 * Read-only preview of one existing session. Actions that were on the board
 * card live here: open the real session, adopt it into a requirement, or hide
 * it from the board.
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
  const [data, setData] = React.useState<SessionTranscriptView | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    setError(null)
    setData(null)
    void controller
      .run<SessionTranscriptView>(`transcript:${sessionId}`, COMMANDS.sessionTranscript, { sessionId })
      .then((value) => {
        if (cancelled) return
        if (value === null) {
          // `run` records the Host's message in the notice; surface it so a
          // stale Host half is diagnosable instead of a generic failure.
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

  return (
    <div className="mate-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <aside className="mate-drawer" role="dialog" aria-modal="true" aria-label={data?.title ?? sessionId}>
        <div className="mate-dialog-head">
          <h2>{data?.title ?? sessionId.slice(0, 16)}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="close">✕</Button>
        </div>

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

        <div className="mate-dialog-foot" style={{ justifyContent: 'flex-start' }}>
          <Button variant="primary" onClick={() => openSession(sessionId)}>{t('action.openSession')}</Button>
          <Button busy={busy} onClick={() => { void adopt() }}>{t('action.adopt')}</Button>
          <Button
            variant="ghost"
            onClick={() => {
              void controller.run(`hide:${sessionId}`, COMMANDS.sessionHide, { sessionId }).then(() => onClose())
            }}
          >
            {t('action.hideSession')}
          </Button>
        </div>

        <section className="mate-section">
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
      </aside>
    </div>
  )
}
