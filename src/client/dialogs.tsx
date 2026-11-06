import React from 'react'
import { COMMANDS, type MateView, type ModelSelection, type ProjectSource, type Snapshot } from '../shared.js'
import type { Translator } from './locales.js'
import type { MateController } from './controller.js'
import { projectLabel } from './types.js'
import { Badge, Button, Field, Modal } from './ui.js'

export interface ComposePayload {
  brief: string
  mateId: string
  projectSource: ProjectSource
  projectPath: string
  projectTitle?: string
}

type ProjectMode = 'auto' | 'user' | 'user-new'

/**
 * One input is enough for the body: the Mate names the card. The project is a
 * three-mode choice — auto (Mate decides), an existing project, or a new one —
 * and never overwrites the other fields while switching.
 */
export function ComposeDialog({ snapshot, controller, t, busy, onClose, onSubmit }: {
  snapshot: Snapshot
  controller: MateController
  t: Translator
  busy: boolean
  onClose: () => void
  onSubmit: (payload: ComposePayload) => void | Promise<void>
}): React.ReactElement {
  const mates = snapshot.mates.filter((mate) => !mate.archived)
  const projects = snapshot.projects
  const lastProjectPath = snapshot.settings.lastProjectPath
  const lastValid = lastProjectPath !== null && lastProjectPath.length > 0
    && projects.some((project) => project.path === lastProjectPath)
    ? lastProjectPath
    : null

  const [brief, setBrief] = React.useState('')
  const [mateId, setMateId] = React.useState(snapshot.settings.defaultMateId ?? mates[0]?.id ?? '')
  const [mode, setMode] = React.useState<ProjectMode>('auto')
  const [source, setSource] = React.useState<ProjectSource>('auto')
  const [selectedPath, setSelectedPath] = React.useState('')
  const [newPath, setNewPath] = React.useState('')
  const [pickerBusy, setPickerBusy] = React.useState(false)
  const [registerBusy, setRegisterBusy] = React.useState(false)
  const [hint, setHint] = React.useState<string | null>(null)
  const areaRef = React.useRef<HTMLTextAreaElement | null>(null)

  React.useEffect(() => {
    areaRef.current?.focus()
  }, [])

  const canSend = brief.trim().length > 0 && mateId.length > 0 && !busy

  const enterUserMode = (): void => {
    if (lastProjectPath !== null && lastProjectPath.length > 0 && lastValid === null) {
      // The remembered project is no longer in the list: fall back to auto.
      setMode('auto')
      setSource('auto')
      setHint(t('compose.projectLastGone'))
      return
    }
    setMode('user')
    setSource('user')
    setHint(null)
    setSelectedPath((current) => current.length > 0 ? current : (lastValid ?? projects[0]?.path ?? ''))
  }

  const pickNative = async (): Promise<void> => {
    setPickerBusy(true)
    setHint(null)
    try {
      const result = await controller.run<{ path: string | null }>('project.pickDirectory', COMMANDS.projectPickDirectory, {})
      if (result !== null && typeof result.path === 'string' && result.path.length > 0) {
        setSelectedPath(result.path)
        setSource('user-new')
        setMode('user')
        setNewPath('')
        setHint(t('compose.projectRegistered'))
      }
    } catch {
      // Errors surface through the controller notice; keep the manual input.
    } finally {
      setPickerBusy(false)
    }
    if (controller.getSnapshot().notice?.kind === 'error') {
      setHint(controller.getSnapshot().notice?.text ?? t('error.projectPickFailed'))
    }
  }

  const registerManual = async (): Promise<void> => {
    const path = newPath.trim()
    if (path.length === 0) return
    setRegisterBusy(true)
    setHint(null)
    try {
      const result = await controller.run<{ path: string; title: string }>('project.register', COMMANDS.projectRegister, { path })
      if (result !== null) {
        setSelectedPath(result.path)
        setSource('user-new')
        setMode('user')
        setNewPath('')
        setHint(t('compose.projectRegistered'))
      } else {
        setHint(controller.getSnapshot().notice?.text ?? t('error.projectRegisterFailed'))
      }
    } finally {
      setRegisterBusy(false)
    }
  }

  const send = (): void => {
    if (!canSend) return
    let projectSource: ProjectSource = 'auto'
    let projectPath = ''
    let projectTitle: string | undefined
    if (mode === 'user' && selectedPath.length > 0) {
      projectSource = source
      projectPath = selectedPath
      projectTitle = projects.find((project) => project.path === selectedPath)?.title
    } else if (mode !== 'auto') {
      // New-project mode with no directory chosen (or user mode with an empty
      // list): degrade to auto and say so.
      setHint(t('compose.projectFallbackAuto'))
    }
    void onSubmit({ brief: brief.trim(), mateId, projectSource, projectPath, projectTitle })
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
        style={{ minHeight: 120 }}
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

      <Field label={t('compose.projectMode')} hint={t('compose.projectModeHint')}>
        <div className="mate-seg" role="radiogroup" aria-label={t('compose.projectMode')}>
          <button
            type="button"
            className={mode === 'auto' ? 'on' : ''}
            onClick={() => { setMode('auto'); setSource('auto'); setHint(null) }}
          >
            {t('compose.projectAuto')}
          </button>
          <button type="button" className={mode === 'user' ? 'on' : ''} onClick={enterUserMode}>
            {t('compose.projectList')}
          </button>
          <button
            type="button"
            className={mode === 'user-new' ? 'on' : ''}
            onClick={() => { setMode('user-new'); setSource('user-new'); setHint(null) }}
          >
            {t('compose.projectNew')}
          </button>
        </div>
      </Field>

      {mode === 'auto' ? (
        <div className="mate-sub">{t('compose.projectAutoHint')}</div>
      ) : null}

      {mode === 'user' ? (
        <Field label={t('compose.project')} hint={t('compose.projectListHint')}>
          <select
            className="mate-select"
            value={selectedPath}
            onChange={(event) => { setSelectedPath(event.target.value); setSource('user') }}
          >
            {projects.map((project) => (
              <option key={project.path} value={project.path}>{projectLabel(project.path)} — {project.path}</option>
            ))}
            {selectedPath.length > 0 && projects.every((project) => project.path !== selectedPath) ? (
              <option value={selectedPath}>{selectedPath}</option>
            ) : null}
          </select>
        </Field>
      ) : null}

      {mode === 'user-new' ? (
        <Field label={t('compose.projectNew')} hint={t('compose.projectNewHint')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button busy={pickerBusy} onClick={() => { void pickNative() }}>{t('compose.projectNewPick')}</Button>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                className="mate-input"
                value={newPath}
                placeholder={t('compose.projectPathPlaceholder')}
                onChange={(event) => setNewPath(event.target.value)}
              />
              <Button busy={registerBusy} disabled={newPath.trim().length === 0} onClick={() => { void registerManual() }}>
                {t('compose.projectNewRegister')}
              </Button>
            </div>
          </div>
        </Field>
      ) : null}

      {hint !== null ? (
        <div className="mate-sub" style={{ color: 'var(--dsw-alias-state-warn-label, #dd8629)' }}>{hint}</div>
      ) : null}
    </Modal>
  )
}

export interface MatePayload {
  id?: string
  name: string
  model: ModelSelection
  autonomy: 'confirm' | 'auto'
}

/** Mate identity is the name it displays and answers as; the model is one pick. */
export function MateEditorDialog({ mate, snapshot, t, busy, onClose, onSubmit, onDelete, onTeach, onForget }: {
  mate: MateView | null
  snapshot: Snapshot | null
  t: Translator
  busy: boolean
  onClose: () => void
  onSubmit: (payload: MatePayload) => Promise<boolean> | void
  onDelete: (mate: MateView) => void | Promise<void>
  onTeach: (text: string) => Promise<MateView | null>
  onForget: (entryId: string) => Promise<MateView | null>
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
  const [modelKey, setModelKey] = React.useState(initialKey)
  const [autonomy, setAutonomy] = React.useState<'confirm' | 'auto'>(mate?.autonomy ?? 'auto')
  const [memory, setMemory] = React.useState(mate?.memory ?? [])
  const [teachText, setTeachText] = React.useState('')
  const [memoryBusy, setMemoryBusy] = React.useState(false)
  const selected = options.find((option) => option.key === modelKey)
  const legacyKey = mate !== null && selected === undefined ? initialKey : null

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (trimmed.length === 0 || modelKey.length === 0) return
    const [selectedProvider, selectedModel] = modelKey.split('|')
    await onSubmit({
      ...(mate === null ? {} : { id: mate.id }),
      name: trimmed,
      model: { provider: selectedProvider, model: selectedModel },
      autonomy,
    })
  }

  const teach = async (): Promise<void> => {
    const text = teachText.trim()
    if (text.length === 0 || mate === null || memoryBusy) return
    setMemoryBusy(true)
    try {
      const updated = await onTeach(text)
      if (updated !== null) {
        setMemory(updated.memory ?? [])
        setTeachText('')
      }
    } finally {
      setMemoryBusy(false)
    }
  }

  const forget = async (entryId: string): Promise<void> => {
    if (mate === null || memoryBusy) return
    setMemoryBusy(true)
    try {
      const updated = await onForget(entryId)
      if (updated !== null) setMemory(updated.memory ?? [])
    } finally {
      setMemoryBusy(false)
    }
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

      <Field label={t('mate.memoryTitle')} hint={mate === null ? t('mate.memoryAfterSave') : t('mate.memoryHint')}>
        {mate === null ? null : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {memory.length === 0 ? (
              <div className="mate-sub">{t('mate.memoryEmpty')}</div>
            ) : (
              memory.map((entry) => (
                <div key={entry.id} className="mate-row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                  <span className="mate-row-main">
                    <span className="mate-row-title" style={{ whiteSpace: 'normal' }}>
                      <Badge>{t(`memory.kind.${entry.kind}`)}</Badge> {entry.text}
                    </span>
                  </span>
                  <Button variant="ghost" busy={memoryBusy} onClick={() => { void forget(entry.id) }}>
                    {t('action.forget')}
                  </Button>
                </div>
              ))
            )}
            <textarea
              className="mate-textarea"
              style={{ minHeight: 84 }}
              value={teachText}
              placeholder={t('mate.teachPlaceholder')}
              onChange={(event) => setTeachText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  void teach()
                }
              }}
            />
            <div>
              <Button variant="primary" busy={memoryBusy} disabled={teachText.trim().length === 0} onClick={() => { void teach() }}>
                {t('action.remember')}
              </Button>
            </div>
          </div>
        )}
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


