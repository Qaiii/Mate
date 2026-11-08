import React from 'react'
import { COMMANDS, type DispatchModelRule, type MateDistillView, type MateMemoryKind, type MateView, type ModelEffortsView, type ModelSelection, type ProjectSource, type Snapshot } from '../shared.js'
import { composePayload, readLastMateId, resolveComposeMateId, writeLastMateId, type ComposePayload } from './compose.js'
import type { Translator } from './locales.js'
import type { MateController } from './controller.js'
import { projectLabel, type PickDirectoryResult } from './types.js'
import { Badge, Button, Field, Modal } from './ui.js'

export type { ComposePayload } from './compose.js'


/**
 * One input is enough for the body: the Mate names the card. The project is a
 * three-mode choice — auto (Mate decides), an existing project, or a new one —
 * and never overwrites the other fields while switching.
 */
export function ComposeDialog({ snapshot, controller, t, busy, onPickDirectory, onClose, onSubmit }: {
  snapshot: Snapshot
  controller: MateController
  t: Translator
  busy: boolean
  onPickDirectory: () => Promise<PickDirectoryResult>
  onClose: () => void
  onSubmit: (payload: ComposePayload) => void | Promise<void>
}): React.ReactElement {
  const mates = snapshot.mates.filter((mate) => !mate.archived)
  const projects = snapshot.projects

  const [brief, setBrief] = React.useState('')
  // Open with the Mate used last (localStorage); fall back to the configured
  // default, then to the first available Mate.
  const [mateId, setMateId] = React.useState(() => resolveComposeMateId(
    readLastMateId(),
    mates,
    snapshot.settings.defaultMateId,
  ))
  // One select holds every project target: auto, each known project, then the
  // new-project entry at the end.
  const [choice, setChoice] = React.useState('auto')
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const previousChoice = React.useRef('auto')
  const [hint, setHint] = React.useState<string | null>(null)
  const NEW_PROJECT = '__new__'
  const noMates = mates.length === 0
  const areaRef = React.useRef<HTMLTextAreaElement | null>(null)

  React.useEffect(() => {
    areaRef.current?.focus()
  }, [])

  // A Mate archived/deleted while the dialog is open must not leave the
  // selection on a ghost id; the same fallback chain repairs it silently.
  React.useEffect(() => {
    setMateId((current) => resolveComposeMateId(current, mates, snapshot.settings.defaultMateId))
  }, [mates, snapshot.settings.defaultMateId])

  const chooseMate = (next: string): void => {
    setMateId(next)
    if (next.length > 0) writeLastMateId(next)
  }

  const canSend = brief.trim().length > 0 && mateId.length > 0 && !busy

  /** Create a new directory and register it as a project. */
  const createPath = async (path: string): Promise<boolean> => {
    const record = await controller.run<{ path: string; title: string }>(
      'project.create',
      COMMANDS.projectCreate,
      { path },
    )
    if (record === null) {
      setHint(controller.getSnapshot().notice?.text ?? t('error.projectRegisterFailed'))
      return false
    }
    setChoice(record.path)
    setHint(t('compose.projectRegistered'))
    setPickerOpen(false)
    return true
  }

  /** Pick one of the projects that are already registered. */
  const selectExisting = (path: string): void => {
    setChoice(path)
    setHint(null)
    setPickerOpen(false)
  }

  const openProjectPicker = (): void => {
    previousChoice.current = choice
    setPickerOpen(true)
  }

  const cancelProjectPicker = (): void => {
    setChoice(previousChoice.current)
    setPickerOpen(false)
  }

  const send = (): void => {
    if (!canSend) return
    let project: { source: ProjectSource; path: string; title?: string } = { source: 'auto', path: '' }
    if (choice === NEW_PROJECT) {
      setHint(t('compose.projectFallbackAuto'))
    } else if (choice !== 'auto') {
      project = {
        source: 'user',
        path: choice,
        title: projects.find((entry) => entry.path === choice)?.title,
      }
    }
    void onSubmit(composePayload(brief, mateId, project))
  }

  return (
    <>
    <Modal
      title={t('compose.title')}
      onClose={onClose}
      footer={(
        <>
          <span className="mate-sub mate-foot-hint" style={{ marginRight: 'auto' }}>{t('compose.hint')}</span>
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

      <Field
        label={t('compose.mate')}
        hint={noMates ? t('compose.mateEmpty') : t('compose.mateHint')}
      >
        <select
          className="mate-select"
          value={mateId}
          onChange={(event) => chooseMate(event.target.value)}
          disabled={noMates}
          aria-label={t('compose.mate')}
        >
          {noMates
            ? <option value="">{t('compose.mateEmpty')}</option>
            : mates.map((mate) => <option key={mate.id} value={mate.id}>{mate.name}</option>)}
        </select>
      </Field>

      <Field
        label={t('compose.project')}
        hint={choice === 'auto' ? t('compose.projectModeHint') : choice === NEW_PROJECT ? t('compose.projectNewHint') : t('compose.projectListHint')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <select
            className="mate-select"
            value={choice}
            onChange={(event) => {
              if (event.target.value === NEW_PROJECT) {
                openProjectPicker()
                return
              }
              setChoice(event.target.value)
              setHint(null)
            }}
            aria-label={t('compose.project')}
          >
            <option value="auto">{t('compose.projectAuto')}</option>
            {projects.map((project) => (
              <option key={project.path} value={project.path}>{projectLabel(project.path)} — {project.path}</option>
            ))}
            <option value={NEW_PROJECT}>＋ {t('compose.projectNew')}</option>
          </select>
        </div>
      </Field>

      {hint !== null ? (
        <div className="mate-sub" style={{ color: 'var(--dsw-alias-state-warn-label, #dd8629)' }}>{hint}</div>
      ) : null}
    </Modal>
      {pickerOpen ? (
        <ProjectPickerDialog
          projects={projects}
          t={t}
          onPickDirectory={onPickDirectory}
          onCreate={createPath}
          onSelectExisting={selectExisting}
          onCancel={cancelProjectPicker}
        />
      ) : null}
    </>
  )
}

/**
 * 新建项目 chooser: pick one of the registered projects, or create a new
 * directory (native chooser when the profile has one, manual path otherwise).
 */
export function ProjectPickerDialog({ projects, t, onPickDirectory, onCreate, onSelectExisting, onCancel }: {
  projects: Snapshot['projects']
  t: Translator
  onPickDirectory: () => Promise<PickDirectoryResult>
  onCreate: (path: string) => Promise<boolean>
  onSelectExisting: (path: string) => void
  onCancel: () => void
}): React.ReactElement {
  const [view, setView] = React.useState<'menu' | 'existing' | 'new'>('menu')
  const [path, setPath] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [hint, setHint] = React.useState<string | null>(null)

  const chooseNative = async (): Promise<void> => {
    setView('new')
    setBusy(true)
    setHint(null)
    try {
      const picked = await onPickDirectory()
      if (picked.unavailable) setHint(t('compose.pickUnavailable'))
      else if (picked.path === null) setHint(t('compose.pickCancelled'))
      else await onCreate(picked.path)
    } finally {
      setBusy(false)
    }
  }

  const submitManual = async (): Promise<void> => {
    const value = path.trim()
    if (value.length === 0) return
    setBusy(true)
    setHint(null)
    try {
      await onCreate(value)
    } finally {
      setBusy(false)
    }
  }

  const footer = view === 'menu' ? (
    <>
      <Button variant="ghost" onClick={onCancel}>{t('compose.pickCancel')}</Button>
      <Button onClick={() => setView('existing')}>{t('compose.pickExisting')}</Button>
      <Button variant="primary" onClick={() => { void chooseNative() }}>{t('compose.pickNew')}</Button>
    </>
  ) : view === 'existing' ? (
    <>
      <Button variant="ghost" onClick={() => setView('menu')}>{t('compose.pickBack')}</Button>
      <Button onClick={onCancel}>{t('compose.pickCancel')}</Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={() => setView('menu')}>{t('compose.pickBack')}</Button>
      <Button onClick={onCancel}>{t('compose.pickCancel')}</Button>
      <Button variant="primary" busy={busy} disabled={path.trim().length === 0} onClick={() => { void submitManual() }}>
        {t('compose.projectNewCreate')}
      </Button>
    </>
  )

  return (
    <Modal title={t('compose.pickTitle')} onClose={onCancel} narrow footer={footer}>
      {view === 'menu' ? <div className="mate-sub">{t('compose.pickHint')}</div> : null}
      {view === 'existing' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="mate-sub">{t('compose.pickExistingHint')}</div>
          {projects.length === 0 ? (
            <div className="mate-sub">{t('compose.pickNoProjects')}</div>
          ) : (
            projects.map((project) => (
              <button
                key={project.path}
                type="button"
                className="mate-row"
                onClick={() => onSelectExisting(project.path)}
              >
                <span className="mate-row-main">
                  <span className="mate-row-title">{project.title || projectLabel(project.path)}</span>
                  <span className="mate-row-meta">{project.path}</span>
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
      {view === 'new' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="mate-sub">{t('compose.pickNewHint')}</div>
          <Field label={t('compose.pickPathLabel')}>
            <input
              className="mate-input"
              value={path}
              placeholder={t('compose.projectPathPlaceholder')}
              onChange={(event) => setPath(event.target.value)}
            />
          </Field>
        </div>
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
  /** Restrict which model/effort pairs dispatched sessions may use. */
  dispatchModels?: DispatchModelRule[]
  /** Instruct the Mate at creation time; it is distilled into memory then. */
  memoryText?: string
}

/** Mate identity is the name it displays and answers as; the model is one pick. */
export function MateEditorDialog({ mate, snapshot, t, busy, onClose, onSubmit, onDelete, onDistill, onRemember, onForget, onEditMemory, onEfforts }: {
  mate: MateView | null
  snapshot: Snapshot | null
  t: Translator
  busy: boolean
  onClose: () => void
  onSubmit: (payload: MatePayload) => Promise<MateView | null>
  onDelete: (mate: MateView) => void | Promise<void>
  onDistill: (mateId: string, text: string) => Promise<MateDistillView | null>
  onRemember: (mateId: string, entries: Array<{ kind: MateMemoryKind; text: string }>) => Promise<MateView | null>
  onForget: (mateId: string, entryId: string) => Promise<MateView | null>
  onEditMemory: (mateId: string, entryId: string, kind: MateMemoryKind, text: string) => Promise<MateView | null>
  onEfforts: (provider: string, model: string) => Promise<ModelEffortsView | null>
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
  const [proposal, setProposal] = React.useState<MateDistillView['entries'] | null>(null)
  const [created, setCreated] = React.useState<MateView | null>(null)
  const [editing, setEditing] = React.useState<{ id: string; kind: MateMemoryKind; text: string } | null>(null)
  const [effort, setEffort] = React.useState(mate?.model.reasoningEffort ?? '')
  const [efforts, setEfforts] = React.useState<ModelEffortsView['efforts']>([])
  const [effortsLoading, setEffortsLoading] = React.useState(false)
  const proposalRef = React.useRef<HTMLDivElement | null>(null)
  const selected = options.find((option) => option.key === modelKey)
  const legacyKey = mate !== null && selected === undefined ? initialKey : null
  const [modelProvider, modelId] = modelKey.split('|')
  const [rules, setRules] = React.useState<Array<{ provider: string; model: string; effort: string }>>(
    (mate?.dispatchModels ?? []).map((rule) => ({ provider: rule.provider, model: rule.model, effort: rule.reasoningEffort ?? '' })),
  )
  const [ruleEfforts, setRuleEfforts] = React.useState<Record<string, ModelEffortsView['efforts']>>({})
  const ruleEffortsCb = React.useRef(onEfforts)
  ruleEffortsCb.current = onEfforts
  const effective = mate ?? created
  const effectiveId = effective?.id ?? null

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (trimmed.length === 0 || modelKey.length === 0) return
    const [selectedProvider, selectedModel] = modelKey.split('|')
    const saved = await onSubmit({
      ...(mate === null ? {} : { id: mate.id }),
      name: trimmed,
      model: {
        provider: selectedProvider,
        model: selectedModel,
        ...(effort.length > 0 ? { reasoningEffort: effort } : {}),
      },
      autonomy,
      dispatchModels: rules.map((rule) => ({
        provider: rule.provider,
        model: rule.model,
        ...(rule.effort.length > 0 ? { reasoningEffort: rule.effort } : {}),
      })),
      ...(mate === null && teachText.trim().length > 0 ? { memoryText: teachText.trim() } : {}),
    })
    if (saved === null) return
    if (mate !== null) {
      onClose()
      return
    }
    // Creation succeeded: keep the dialog open so the first memory can be
    // reviewed and written before it closes.
    setCreated(saved)
    const instruction = teachText.trim()
    if (instruction.length === 0) {
      onClose()
      return
    }
    setMemoryBusy(true)
    try {
      const distilled = await onDistill(saved.id, instruction)
      setProposal(distilled?.entries ?? [])
      setTeachText('')
    } finally {
      setMemoryBusy(false)
    }
  }

  React.useEffect(() => {
    if (proposal !== null) proposalRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [proposal])

  const effortsCb = React.useRef(onEfforts)
  effortsCb.current = onEfforts

  React.useEffect(() => {
    if (modelProvider === undefined || modelId === undefined || modelId.length === 0) return
    let cancelled = false
    setEffortsLoading(true)
    void effortsCb.current(modelProvider, modelId).then((value) => {
      if (cancelled) return
      const list = value?.efforts ?? []
      setEfforts(list)
      setEffortsLoading(false)
      setEffort((current) => (current.length === 0 || list.some((option) => option.id === current) ? current : ''))
    })
    return () => { cancelled = true }
  }, [modelProvider, modelId])

  // Fetch each dispatch rule's effort options once per model route.
  React.useEffect(() => {
    const missing = rules
      .map((rule) => `${rule.provider}|${rule.model}`)
      .filter((key, index, list) => list.indexOf(key) === index && ruleEfforts[key] === undefined)
    if (missing.length === 0) return
    let cancelled = false
    for (const key of missing) {
      const [provider, model] = key.split('|')
      void ruleEffortsCb.current(provider, model).then((value) => {
        if (cancelled) return
        const list = value?.efforts ?? []
        setRuleEfforts((current) => ({ ...current, [key]: list }))
        setRules((current) => current.map((rule) => {
          if (`${rule.provider}|${rule.model}` !== key || rule.effort.length === 0) return rule
          return list.some((option) => option.id === rule.effort) ? rule : { ...rule, effort: '' }
        }))
      })
    }
    return () => { cancelled = true }
  }, [rules, ruleEfforts])

  const teach = async (): Promise<void> => {
    const text = teachText.trim()
    if (text.length === 0 || effectiveId === null || memoryBusy) return
    setMemoryBusy(true)
    try {
      const distilled = await onDistill(effectiveId, text)
      if (distilled !== null) setProposal(distilled.entries)
    } finally {
      setMemoryBusy(false)
    }
  }

  const remember = async (): Promise<void> => {
    if (effectiveId === null || proposal === null || memoryBusy) return
    setMemoryBusy(true)
    try {
      const updated = await onRemember(effectiveId, proposal.filter((entry) => !entry.existing))
      if (updated !== null) {
        setMemory(updated.memory ?? [])
        setProposal(null)
        setTeachText('')
        if (mate === null) onClose()
      }
    } finally {
      setMemoryBusy(false)
    }
  }

  const saveEdit = async (): Promise<void> => {
    if (editing === null || effectiveId === null || memoryBusy) return
    setMemoryBusy(true)
    try {
      const updated = await onEditMemory(effectiveId, editing.id, editing.kind, editing.text.trim())
      if (updated !== null) {
        setMemory(updated.memory ?? [])
        setEditing(null)
      }
    } finally {
      setMemoryBusy(false)
    }
  }

  const forget = async (entryId: string): Promise<void> => {
    if (effectiveId === null || memoryBusy) return
    setMemoryBusy(true)
    try {
      const updated = await onForget(effectiveId, entryId)
      if (updated !== null) setMemory(updated.memory ?? [])
    } finally {
      setMemoryBusy(false)
    }
  }

  return (
    <Modal
      title={mate === null ? t('action.newMate') : mate.name}
      onClose={onClose}
      wide
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
            disabled={created !== null || name.trim().length === 0 || modelKey.length === 0}
            onClick={() => { void submit() }}
          >
            {t('action.save')}
          </Button>
        </>
      )}
    >
      <div className="mate-profile">
        <div className="mate-profile-hero">
          <div className="mate-avatar" aria-hidden="true">{(name.trim().charAt(0) || 'M').toUpperCase()}</div>
          <div className="mate-profile-id">
            <input
              className="mate-profile-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('mate.name')}
              aria-label={t('mate.name')}
              autoFocus
            />
            <div className="mate-profile-meta">
              <Badge tone="confirm">{selected?.label ?? modelKey.replace('|', ' / ')}</Badge>
              {efforts.length > 0 ? (
                <Badge>{effort.length > 0 ? (efforts.find((option) => option.id === effort)?.name ?? effort) : t('mate.effortDefault')}</Badge>
              ) : null}
              <Badge tone={autonomy === 'auto' ? 'auto' : 'confirm'}>
                {autonomy === 'auto' ? t('badge.auto') : t('badge.confirm')}
              </Badge>
              <span className="mate-sub">{memory.length} {t('mate.memoryUnit')}</span>
            </div>
            <div className="mate-sub">{t('mate.nameHint')}</div>
          </div>
        </div>

        <section className="mate-profile-section">
          <h3>{t('mate.section.model')}</h3>
          <div className="mate-grid3">
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
            {efforts.length > 0 ? (
              <Field label={t('mate.effort')} hint={t('mate.effortHint')}>
                <select className="mate-select" value={effort} onChange={(event) => setEffort(event.target.value)}>
                  <option value="">{t('mate.effortDefault')}</option>
                  {efforts.map((option) => (
                    <option key={option.id} value={option.id}>{option.name}</option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label={t('mate.effort')}>
                <div className="mate-sub">{t('mate.effortUnavailable')}</div>
              </Field>
            )}
            <Field label={t('mate.autonomy')} hint={t('mate.autonomyHint')}>
              <select className="mate-select" value={autonomy} onChange={(event) => setAutonomy(event.target.value as 'confirm' | 'auto')}>
                <option value="auto">{t('badge.auto')}</option>
                <option value="confirm">{t('badge.confirm')}</option>
              </select>
            </Field>
          </div>
        </section>

        <section className="mate-profile-section">
          <Field label={t('mate.dispatchModels')} hint={t('mate.dispatchModelsHint')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rules.length === 0 ? (
            <div className="mate-sub">{t('mate.dispatchModelsEmpty')}</div>
          ) : (
            rules.map((rule, index) => {
              const routeKey = `${rule.provider}|${rule.model}`
              const effortOptions = ruleEfforts[routeKey] ?? []
              return (
                <div key={`${routeKey}-${index}`} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select
                    className="mate-select"
                    value={routeKey}
                    aria-label={t('mate.dispatchModels')}
                    onChange={(event) => {
                      const [provider, model] = event.target.value.split('|')
                      setRules((current) => current.map((item, i) => (i === index ? { provider, model, effort: '' } : item)))
                    }}
                  >
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
                  <select
                    className="mate-select"
                    style={{ maxWidth: 160 }}
                    value={rule.effort}
                    aria-label={t('mate.effort')}
                    onChange={(event) => setRules((current) => current.map((item, i) => (i === index ? { ...item, effort: event.target.value } : item)))}
                  >
                    <option value="">{t('mate.effortDefault')}</option>
                    {effortOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.name}</option>
                    ))}
                  </select>
                  <Button
                    variant="ghost"
                    aria-label={`${t('action.delete')} ${rule.model}`}
                    onClick={() => setRules((current) => current.filter((_, i) => i !== index))}
                  >
                    ✕
                  </Button>
                </div>
              )
            })
          )}
          <div>
            <Button
              disabled={options.length === 0}
              onClick={() => {
                const first = options[0]
                if (first === undefined) return
                setRules((current) => [...current, { provider: first.provider, model: first.key.split('|')[1] ?? '', effort: '' }])
              }}
            >
              {t('mate.dispatchAdd')}
            </Button>
          </div>
        </div>
          </Field>
        </section>

        <section className="mate-profile-section">
          <Field label={t('mate.memoryTitle')} hint={effective === null ? t('mate.memoryCreateHint') : t('mate.memoryHint')}>
        {effective === null ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea
              className="mate-textarea"
              style={{ minHeight: 84 }}
              value={teachText}
              placeholder={t('mate.teachPlaceholder')}
              onChange={(event) => setTeachText(event.target.value)}
            />
            <div className="mate-sub">{t('mate.memoryCreateNote')}</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {memory.length === 0 ? (
              <div className="mate-sub">{t('mate.memoryEmpty')}</div>
            ) : (
              memory.map((entry) => (
                <div key={entry.id} className="mate-row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                  {editing !== null && editing.id === entry.id ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                      <select
                        className="mate-select"
                        value={editing.kind}
                        onChange={(event) => setEditing({ ...editing, kind: event.target.value as MateMemoryKind })}
                      >
                        {(['role', 'constraint', 'preference', 'glossary', 'note'] as const).map((kind) => (
                          <option key={kind} value={kind}>{t(`memory.kind.${kind}`)}</option>
                        ))}
                      </select>
                      <textarea
                        className="mate-textarea"
                        value={editing.text}
                        onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                      />
                      <div style={{ display: 'flex', gap: 8 }}>
                        <Button
                          variant="primary"
                          busy={memoryBusy}
                          disabled={editing.text.trim().length === 0}
                          onClick={() => { void saveEdit() }}
                        >
                          {t('action.save')}
                        </Button>
                        <Button variant="ghost" disabled={memoryBusy} onClick={() => setEditing(null)}>
                          {t('action.cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <span className="mate-row-main">
                        <span className="mate-row-title" style={{ whiteSpace: 'normal' }}>
                          <Badge>{t(`memory.kind.${entry.kind}`)}</Badge> {entry.text}
                        </span>
                      </span>
                      <Button
                        variant="ghost"
                        disabled={memoryBusy}
                        onClick={() => setEditing({ id: entry.id, kind: entry.kind, text: entry.text })}
                      >
                        {t('action.edit')}
                      </Button>
                      <Button variant="ghost" busy={memoryBusy} onClick={() => { void forget(entry.id) }}>
                        {t('action.forget')}
                      </Button>
                    </>
                  )}
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

            {proposal !== null ? (
              <div ref={proposalRef} className="mate-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="mate-row-title">{t('mate.proposalTitle')}</div>
                {proposal.length === 0 ? (
                  <div className="mate-sub">{t('mate.proposalEmpty')}</div>
                ) : (
                  proposal.map((entry, index) => (
                    <div key={index} className="mate-row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                      <span className="mate-row-main">
                        <span className="mate-row-title" style={{ whiteSpace: 'normal' }}>
                          <Badge>{t(`memory.kind.${entry.kind}`)}</Badge>{' '}
                          <Badge tone={entry.existing ? 'goal' : 'confirm'}>
                            {entry.existing ? t('memory.existing') : t('memory.new')}
                          </Badge>{' '}
                          {entry.text}
                        </span>
                      </span>
                    </div>
                  ))
                )}
                {proposal.length > 0 && proposal.every((entry) => entry.existing) ? (
                  <div className="mate-sub">{t('mate.proposalNothingNew')}</div>
                ) : null}
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button
                    variant="primary"
                    busy={memoryBusy}
                    disabled={proposal.every((entry) => entry.existing)}
                    onClick={() => { void remember() }}
                  >
                    {t('action.applyRemember')}
                  </Button>
                  <Button variant="ghost" disabled={memoryBusy} onClick={() => {
                    setProposal(null)
                    if (created !== null && mate === null) onClose()
                  }}>
                    {t('action.cancel')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </Field>
        </section>
      </div>
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











