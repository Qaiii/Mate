import React from 'react'
import type { MateView, Snapshot } from '../shared.js'
import type { Translator } from './locales.js'
import { Button, Field, Modal } from './ui.js'

const PROVIDER_DATALIST = 'mate-providers'
const MODEL_DATALIST = 'mate-models'

function ModelFields({ provider, model, effort, onChange, t, snapshot }: {
  provider: string
  model: string
  effort: string
  onChange: (next: { provider: string; model: string; reasoningEffort: string }) => void
  t: Translator
  snapshot: Snapshot | null
}): React.ReactElement {
  const providers = snapshot?.settings.modelCatalog ?? []
  const models = providers.find((group) => group.provider === provider)?.models ?? []
  return (
    <div className="mate-grid3">
      <Field label={t('mate.provider')}>
        <input
          className="mate-input"
          value={provider}
          list={PROVIDER_DATALIST}
          onChange={(event) => onChange({ provider: event.target.value, model, reasoningEffort: effort })}
        />
      </Field>
      <Field label={t('mate.model')}>
        <input
          className="mate-input"
          value={model}
          list={MODEL_DATALIST}
          onChange={(event) => onChange({ provider, model: event.target.value, reasoningEffort: effort })}
        />
      </Field>
      <Field label={t('mate.effort')}>
        <input
          className="mate-input"
          value={effort}
          placeholder={t('mate.effortDefault')}
          onChange={(event) => onChange({ provider, model, reasoningEffort: event.target.value })}
        />
      </Field>
      <datalist id={PROVIDER_DATALIST}>
        {providers.map((group) => <option key={group.provider} value={group.provider}>{group.name}</option>)}
      </datalist>
      <datalist id={MODEL_DATALIST}>
        {models.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </datalist>
    </div>
  )
}

export interface ComposePayload {
  title: string
  brief: string
  projectPath: string
  projectTitle: string
  mateId: string
  priority: 'low' | 'normal' | 'high'
  autonomy?: 'confirm' | 'auto'
}

export function ComposeDialog({ snapshot, t, busy, onClose, onSubmit }: {
  snapshot: Snapshot
  t: Translator
  busy: boolean
  onClose: () => void
  onSubmit: (payload: ComposePayload) => void | Promise<void>
}): React.ReactElement {
  const mates = snapshot.mates.filter((mate) => !mate.archived)
  const initialMate = snapshot.settings.defaultMateId ?? mates[0]?.id ?? ''
  const [title, setTitle] = React.useState('')
  const [brief, setBrief] = React.useState('')
  const [projectPath, setProjectPath] = React.useState(snapshot.projects[0]?.path ?? '')
  const [mateId, setMateId] = React.useState(initialMate)
  const [priority, setPriority] = React.useState<'low' | 'normal' | 'high'>('normal')
  const [autonomy, setAutonomy] = React.useState<'follow' | 'confirm' | 'auto'>('follow')
  const mate = mates.find((item) => item.id === mateId)

  const submit = (): void => {
    if (title.trim().length === 0 || brief.trim().length === 0 || mateId.length === 0) return
    void onSubmit({
      title: title.trim(),
      brief: brief.trim(),
      projectPath,
      projectTitle: projectPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? projectPath,
      mateId,
      priority,
      ...(autonomy === 'follow' ? {} : { autonomy }),
    })
  }

  return (
    <Modal
      title={t('compose.title')}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={title.trim().length === 0 || brief.trim().length === 0 || mateId.length === 0}
            onClick={submit}
          >
            {t('compose.submit')}
          </Button>
        </>
      )}
    >
      <Field label={t('compose.name')}>
        <input className="mate-input" value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
      </Field>
      <Field label={t('compose.brief')} hint={t('compose.briefHint')}>
        <textarea className="mate-textarea" style={{ minHeight: 140 }} value={brief} onChange={(event) => setBrief(event.target.value)} />
      </Field>
      <div className="mate-grid2">
        <Field label={t('compose.project')} hint={t('compose.projectHint')}>
          <select className="mate-select" value={projectPath} onChange={(event) => setProjectPath(event.target.value)}>
            <option value="">—</option>
            {snapshot.projects.map((project) => (
              <option key={project.path} value={project.path}>{project.path}</option>
            ))}
          </select>
        </Field>
        <Field label={t('compose.mate')}>
          <select className="mate-select" value={mateId} onChange={(event) => setMateId(event.target.value)}>
            {mates.map((item) => (
              <option key={item.id} value={item.id}>{item.name} · {item.model.model}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="mate-grid2">
        <Field label={t('compose.autonomy')}>
          <select className="mate-select" value={autonomy} onChange={(event) => setAutonomy(event.target.value as 'follow' | 'confirm' | 'auto')}>
            <option value="follow">
              {t('compose.autonomyFollow', { mode: mate?.autonomy === 'auto' ? t('badge.auto') : t('badge.confirm') })}
            </option>
            <option value="confirm">{t('compose.autonomyConfirm')}</option>
            <option value="auto">{t('compose.autonomyAuto')}</option>
          </select>
        </Field>
        <Field label={t('compose.priority')}>
          <select className="mate-select" value={priority} onChange={(event) => setPriority(event.target.value as 'low' | 'normal' | 'high')}>
            <option value="low">{t('priority.low')}</option>
            <option value="normal">{t('priority.normal')}</option>
            <option value="high">{t('priority.high')}</option>
          </select>
        </Field>
      </div>
    </Modal>
  )
}

export interface MatePayload {
  id?: string
  name: string
  description: string
  specialty: string
  persona: string
  model: { provider: string; model: string; reasoningEffort?: string }
  dispatchModel: { provider: string; model: string; reasoningEffort?: string } | null
  autonomy: 'confirm' | 'auto'
  confidenceThreshold: number
  maxParallel: number
  allowSplit: boolean
}

export function MateEditorDialog({ mate, snapshot, t, busy, onClose, onSubmit, onDelete }: {
  mate: MateView | null
  snapshot: Snapshot | null
  t: Translator
  busy: boolean
  onClose: () => void
  onSubmit: (payload: MatePayload) => Promise<boolean> | void
  onDelete: (mate: MateView) => void | Promise<void>
}): React.ReactElement {
  const [name, setName] = React.useState(mate?.name ?? '')
  const [specialty, setSpecialty] = React.useState(mate?.specialty ?? '')
  const [description, setDescription] = React.useState(mate?.description ?? '')
  const [persona, setPersona] = React.useState(mate?.persona ?? '')
  const [model, setModel] = React.useState({
    provider: mate?.model.provider ?? '',
    model: mate?.model.model ?? '',
    reasoningEffort: mate?.model.reasoningEffort ?? '',
  })
  const [customDispatch, setCustomDispatch] = React.useState(mate?.dispatchModel !== null && mate?.dispatchModel !== undefined)
  const [dispatchModel, setDispatchModel] = React.useState({
    provider: mate?.dispatchModel?.provider ?? '',
    model: mate?.dispatchModel?.model ?? '',
    reasoningEffort: mate?.dispatchModel?.reasoningEffort ?? '',
  })
  const [autonomy, setAutonomy] = React.useState<'confirm' | 'auto'>(mate?.autonomy ?? 'confirm')
  const [threshold, setThreshold] = React.useState(String(mate?.confidenceThreshold ?? 0.75))
  const [maxParallel, setMaxParallel] = React.useState(String(mate?.maxParallel ?? 2))
  const [allowSplit, setAllowSplit] = React.useState(mate?.allowSplit ?? true)

  const submit = async (): Promise<void> => {
    if (name.trim().length === 0 || model.provider.trim().length === 0 || model.model.trim().length === 0) return
    const payload: MatePayload = {
      ...(mate === null ? {} : { id: mate.id }),
      name: name.trim(),
      description: description.trim(),
      specialty: specialty.trim(),
      persona: persona.trim(),
      model: {
        provider: model.provider.trim(),
        model: model.model.trim(),
        ...(model.reasoningEffort.trim().length > 0 ? { reasoningEffort: model.reasoningEffort.trim() } : {}),
      },
      dispatchModel: customDispatch && dispatchModel.provider.trim().length > 0 && dispatchModel.model.trim().length > 0
        ? {
          provider: dispatchModel.provider.trim(),
          model: dispatchModel.model.trim(),
          ...(dispatchModel.reasoningEffort.trim().length > 0 ? { reasoningEffort: dispatchModel.reasoningEffort.trim() } : {}),
        }
        : null,
      autonomy,
      confidenceThreshold: Number(threshold),
      maxParallel: Number(maxParallel),
      allowSplit,
    }
    await onSubmit(payload)
  }

  return (
    <Modal
      title={mate === null ? t('action.newMate') : `${mate.name}`}
      onClose={onClose}
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
            disabled={name.trim().length === 0 || model.provider.trim().length === 0 || model.model.trim().length === 0}
            onClick={() => { void submit() }}
          >
            {t('action.save')}
          </Button>
        </>
      )}
    >
      <div className="mate-grid2">
        <Field label={t('mate.name')}>
          <input className="mate-input" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </Field>
        <Field label={t('mate.specialty')}>
          <input className="mate-input" value={specialty} onChange={(event) => setSpecialty(event.target.value)} />
        </Field>
      </div>
      <Field label={t('mate.description')}>
        <input className="mate-input" value={description} onChange={(event) => setDescription(event.target.value)} />
      </Field>
      <Field label={t('mate.persona')}>
        <textarea className="mate-textarea" value={persona} onChange={(event) => setPersona(event.target.value)} />
      </Field>
      <Field label={t('mate.modelSection')}>
        <ModelFields
          provider={model.provider}
          model={model.model}
          effort={model.reasoningEffort}
          onChange={setModel}
          t={t}
          snapshot={snapshot}
        />
      </Field>
      <label className="mate-check">
        <input type="checkbox" checked={customDispatch} onChange={(event) => setCustomDispatch(event.target.checked)} />
        {t('mate.dispatchSection')}
      </label>
      {customDispatch ? (
        <ModelFields
          provider={dispatchModel.provider}
          model={dispatchModel.model}
          effort={dispatchModel.reasoningEffort}
          onChange={setDispatchModel}
          t={t}
          snapshot={snapshot}
        />
      ) : (
        <span className="mate-sub">{t('mate.dispatchFollow')}</span>
      )}
      <div className="mate-grid3">
        <Field label={t('mate.autonomy')}>
          <select className="mate-select" value={autonomy} onChange={(event) => setAutonomy(event.target.value as 'confirm' | 'auto')}>
            <option value="confirm">{t('badge.confirm')}</option>
            <option value="auto">{t('badge.auto')}</option>
          </select>
        </Field>
        <Field label={t('mate.threshold')}>
          <input className="mate-input" type="number" min="0.5" max="0.95" step="0.05" value={threshold} onChange={(event) => setThreshold(event.target.value)} />
        </Field>
        <Field label={t('mate.maxParallel')}>
          <input className="mate-input" type="number" min="1" max="8" step="1" value={maxParallel} onChange={(event) => setMaxParallel(event.target.value)} />
        </Field>
      </div>
      <label className="mate-check">
        <input type="checkbox" checked={allowSplit} onChange={(event) => setAllowSplit(event.target.checked)} />
        {t('mate.allowSplit')}
      </label>
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

