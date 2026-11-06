import React from 'react'
import type { MateView, ModelSelection, Snapshot } from '../shared.js'
import type { Translator } from './locales.js'
import { Button, Field, Modal } from './ui.js'

export interface ComposePayload {
  brief: string
  mateId: string
  projectPath: string
}

/**
 * One input is enough: the body is the requirement. The Mate names the card,
 * picks the project, the session model and whether to split.
 */
export function ComposeDialog({ snapshot, t, busy, projectPath, onClose, onSubmit }: {
  snapshot: Snapshot
  t: Translator
  busy: boolean
  projectPath: string
  onClose: () => void
  onSubmit: (payload: ComposePayload) => void | Promise<void>
}): React.ReactElement {
  const mates = snapshot.mates.filter((mate) => !mate.archived)
  const [brief, setBrief] = React.useState('')
  const [mateId, setMateId] = React.useState(snapshot.settings.defaultMateId ?? mates[0]?.id ?? '')
  const areaRef = React.useRef<HTMLTextAreaElement | null>(null)

  React.useEffect(() => {
    areaRef.current?.focus()
  }, [])

  const canSend = brief.trim().length > 0 && mateId.length > 0 && !busy
  const send = (): void => {
    if (!canSend) return
    void onSubmit({ brief: brief.trim(), mateId, projectPath })
  }

  return (
    <Modal
      title={t('compose.title')}
      onClose={onClose}
      footer={(
        <>
          {mates.length > 1 ? (
            <select
              className="mate-select"
              style={{ width: 'auto', marginRight: 'auto' }}
              value={mateId}
              onChange={(event) => setMateId(event.target.value)}
              aria-label={t('compose.mate')}
            >
              {mates.map((mate) => (
                <option key={mate.id} value={mate.id}>{mate.name}</option>
              ))}
            </select>
          ) : null}
          <span className="mate-sub">{t('compose.hint')}</span>
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" busy={busy} disabled={!canSend} onClick={send}>
            {t('action.send')}
          </Button>
        </>
      )}
    >
      <textarea
        ref={areaRef}
        className="mate-textarea"
        style={{ minHeight: 168 }}
        value={brief}
        placeholder={t('compose.placeholder')}
        onChange={(event) => setBrief(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            send()
          }
        }}
      />
    </Modal>
  )
}

export interface MatePayload {
  id?: string
  name: string
  persona: string
  model: ModelSelection
  autonomy: 'confirm' | 'auto'
}

/** Mate identity is the name it displays and answers as; the model is one pick. */
export function MateEditorDialog({ mate, snapshot, t, busy, onClose, onSubmit, onDelete }: {
  mate: MateView | null
  snapshot: Snapshot | null
  t: Translator
  busy: boolean
  onClose: () => void
  onSubmit: (payload: MatePayload) => Promise<boolean> | void
  onDelete: (mate: MateView) => void | Promise<void>
}): React.ReactElement {
  const catalog = snapshot?.settings.modelCatalog ?? []
  const options = catalog.flatMap((group) => group.models.map((model) => ({
    key: `${group.provider}|${model.id}`,
    label: `${group.name && group.name !== group.provider ? group.name + ' · ' : ''}${model.name || model.id}`,
    provider: group.provider,
  })))
  const initialKey = mate !== null
    ? `${mate.model.provider}|${mate.model.model}`
    : options[0]?.key ?? ''
  const [name, setName] = React.useState(mate?.name ?? '')
  const [persona, setPersona] = React.useState(mate?.persona ?? '')
  const [modelKey, setModelKey] = React.useState(initialKey)
  const [autonomy, setAutonomy] = React.useState<'confirm' | 'auto'>(mate?.autonomy ?? 'auto')
  const selected = options.find((option) => option.key === modelKey)
  const legacyKey = mate !== null && selected === undefined ? initialKey : null

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (trimmed.length === 0 || modelKey.length === 0) return
    const [selectedProvider, selectedModel] = modelKey.split('|')
    await onSubmit({
      ...(mate === null ? {} : { id: mate.id }),
      name: trimmed,
      persona: persona.trim(),
      model: { provider: selectedProvider, model: selectedModel },
      autonomy,
    })
  }

  return (
    <Modal
      title={mate === null ? t('action.newMate') : mate.name}
      onClose={onClose}
      narrow
      footer={(
        <>
          {mate !== null ? (
            <Button
              variant="danger"
              onClick={() => { if (window.confirm(t('mate.deleteConfirm'))) void onDelete(mate) }}
            >
              {t('action.delete')}
            </Button>
          ) : null}
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={name.trim().length === 0 || modelKey.length === 0}
            onClick={() => { void submit() }}
          >
            {t('action.save')}
          </Button>
        </>
      )}
    >
      <Field label={t('mate.name')} hint={t('mate.nameHint')}>
        <input className="mate-input" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
      </Field>
      <Field label={t('mate.modelLabel')}>
        <select className="mate-select" value={modelKey} onChange={(event) => setModelKey(event.target.value)}>
          {legacyKey !== null ? <option value={legacyKey}>{legacyKey.replace('|', ' / ')}</option> : null}
          {catalog.map((group) => (
            <optgroup key={group.provider} label={group.name || group.provider}>
              {group.models.map((entry) => (
                <option key={`${group.provider}|${entry.id}`} value={`${group.provider}|${entry.id}`}>
                  {entry.name || entry.id}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>
      <Field label={t('mate.autonomy')} hint={t('mate.autonomyHint')}>
        <select className="mate-select" value={autonomy} onChange={(event) => setAutonomy(event.target.value as 'confirm' | 'auto')}>
          <option value="auto">{t('badge.auto')}</option>
          <option value="confirm">{t('badge.confirm')}</option>
        </select>
      </Field>
      <Field label={t('mate.persona')} hint={t('mate.personaHint')}>
        <textarea className="mate-textarea" value={persona} onChange={(event) => setPersona(event.target.value)} />
      </Field>
    </Modal>
  )
}

export function SettingsDialog({ snapshot, t, busy, onClose, onSubmit, onTest, onRestoreHidden }: {
  snapshot: Snapshot
  t: Translator
  busy: boolean
  onClose: () => void
  onSubmit: (payload: { defaultMateId: string | null; pollMs: number }) => void | Promise<void>
  onTest: () => void | Promise<void>
  onRestoreHidden: (sessionId: string) => void | Promise<void>
}): React.ReactElement {
  const [defaultMateId, setDefaultMateId] = React.useState(snapshot.settings.defaultMateId ?? '')
  const [pollMs, setPollMs] = React.useState(String(snapshot.settings.pollMs))
  const started = snapshot.settings.lastStartedAt
  return (
    <Modal
      title={t('settings.title')}
      onClose={onClose}
      narrow
      footer={(
        <>
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={() => { void onSubmit({ defaultMateId: defaultMateId === '' ? null : defaultMateId, pollMs: Number(pollMs) }) }}
          >
            {t('action.save')}
          </Button>
        </>
      )}
    >
      <Field label={t('settings.defaultMate')}>
        <select className="mate-select" value={defaultMateId} onChange={(event) => setDefaultMateId(event.target.value)}>
          <option value="">—</option>
          {snapshot.mates.filter((mate) => !mate.archived).map((mate) => (
            <option key={mate.id} value={mate.id}>{mate.name}</option>
          ))}
        </select>
      </Field>
      <Field label={t('settings.pollMs')}>
        <input className="mate-input" type="number" min="1000" max="30000" step="500" value={pollMs} onChange={(event) => setPollMs(event.target.value)} />
      </Field>
      <div className="mate-panel" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="mate-kv">
          <span>{t('settings.version')}</span>
          <span className="mate-mono">v{snapshot.settings.version}</span>
        </div>
        <div className="mate-kv">
          <span>{t('settings.startedAt')}</span>
          <span className="mate-mono">
            {started === null || started <= 0 ? '—' : new Date(started).toLocaleString()}
          </span>
        </div>
        <div className="mate-kv">
          <span>{t('settings.sessionCount')}</span>
          <span className="mate-mono">{snapshot.liveSessions.length}</span>
          <span>·</span>
          <span>{t('settings.mateCount')}</span>
          <span className="mate-mono">{snapshot.mates.length}</span>
        </div>
        <div>
          <Button onClick={() => { void onTest() }}>{t('action.testConnection')}</Button>
        </div>
      </div>
      <Field label={t('settings.hiddenSessions')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {snapshot.liveSessions.filter((session) => session.hidden).length === 0
            ? <span className="mate-sub">{t('settings.noneHidden')}</span>
            : snapshot.liveSessions.filter((session) => session.hidden).map((session) => (
              <div key={session.sessionId} className="mate-row" style={{ cursor: 'default' }}>
                <span className="mate-row-main">
                  <span className="mate-row-title">{session.title}</span>
                  <span className="mate-row-meta">{session.cwd || '—'}</span>
                </span>
                <Button onClick={() => { void onRestoreHidden(session.sessionId) }}>{t('action.restore')}</Button>
              </div>
            ))}
        </div>
      </Field>
    </Modal>
  )
}

