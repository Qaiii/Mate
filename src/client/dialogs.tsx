import React from 'react'
import {
  CONTEXT_COMPRESSION_THRESHOLD_MAX,
  CONTEXT_COMPRESSION_THRESHOLD_MIN,
  validateContextCompressionConfig,
} from '../compression.js'
import { WEEKDAYS } from '../schedule.js'
import {
  COMMANDS,
  type ContextCompressionConfig,
  type DisabledWindow,
  type DispatchModelRule,
  type MateDistillView,
  type MateMemoryKind,
  type MateView,
  type ModelEffortsView,
  type ModelSchedule,
  type ModelSelection,
  type ProjectSource,
  type ScheduleConfig,
  type Snapshot,
  type TimeZoneView,
  type WeekdayCode,
} from '../shared.js'
import { composePayload, readLastMateId, resolveComposeMateId, writeLastMateId, type ComposePayload } from './compose.js'
import type { Translator } from './locales.js'
import type { MateController } from './controller.js'
import {
  MAX_HOLIDAY_RANGE_DAYS,
  cloneSchedule,
  expandHolidayRange,
  expandYearHolidays,
  formatZonedDateTime,
  groupHolidays,
  isRealDateKey,
  issueMessage,
  issuesFor,
  mergeHolidays,
  newDisabledWindow,
  parseHolidayYear,
  removeHolidayDates,
  removeHolidayYear,
  toggleWeekday,
  tryModelAvailability,
  validateScheduleDraft,
  windowKindChoice,
  windowSummary,
  withWindowKind,
  type WindowKindChoice,
} from './scheduleDraft.js'
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

/** One localized validation message per line, in the existing diagnostic style. */
function ErrorLines({ messages }: { messages: string[] }): React.ReactElement | null {
  if (messages.length === 0) return null
  return (
    <div className="mate-errors">
      {messages.map((message, index) => (
        <span key={index} className="mate-error-line">{message}</span>
      ))}
    </div>
  )
}

/** The context-compression section as edited: the threshold stays raw input text. */
export interface ContextCompressionDraft {
  enabled: boolean
  threshold: string
}

/** Which localized message an invalid threshold input should show. */
export type ContextCompressionDraftError = 'number' | 'integer' | 'range'

export type ContextCompressionDraftValidation =
  | { ok: true; value: ContextCompressionConfig }
  | { ok: false; error: ContextCompressionDraftError }

/**
 * Validate the context-compression draft with the same pure rules the Host
 * applies to `settings.update`. The threshold is kept as text while editing, so
 * empty/non-numeric input reports `number` instead of silently coercing to 0;
 * decimal input reports `integer`, and input outside 1-100 reports `range`.
 * Invalid input must never reach `onSubmit`.
 */
export function validateContextCompressionDraft(draft: ContextCompressionDraft): ContextCompressionDraftValidation {
  const text = draft.threshold.trim()
  const numeric = text.length === 0 ? Number.NaN : Number(text)
  if (!Number.isFinite(numeric)) return { ok: false, error: 'number' }
  const result = validateContextCompressionConfig({ enabled: draft.enabled, threshold: numeric })
  if (result.ok) return result
  const code = result.errors[0]?.code
  if (code === 'threshold-integer') return { ok: false, error: 'integer' }
  if (code === 'threshold-range') return { ok: false, error: 'range' }
  return { ok: false, error: 'number' }
}

/**
 * Settings: general fields, the effective/overridable scheduling zone, the
 * per-model disabled windows, and the holiday calendar. The draft is validated
 * with the same pure function the Host uses; save stays disabled while invalid,
 * and a Host-side `schedule-invalid` keeps the dialog open (the panel only
 * closes it when the save actually succeeded).
 */
export function SettingsDialog({ snapshot, t, busy, onClose, onSubmit, onTest, onRestoreHidden }: {
  snapshot: Snapshot
  t: Translator
  busy: boolean
  onClose: () => void
  onSubmit: (payload: {
    defaultMateId: string | null
    pollMs: number
    schedule: ScheduleConfig
    contextCompression: ContextCompressionConfig
  }) => void | Promise<void>
  onTest: () => void | Promise<void>
  onRestoreHidden: (sessionId: string) => void | Promise<void>
}): React.ReactElement {
  // Freeze the persisted schedule at open time: the panel polls every few
  // seconds, and a refreshed snapshot must not clobber what the user is editing.
  const [initial] = React.useState(() => cloneSchedule(snapshot.settings.schedule))
  const [defaultMateId, setDefaultMateId] = React.useState(snapshot.settings.defaultMateId ?? '')
  const [pollMs, setPollMs] = React.useState(String(snapshot.settings.pollMs))
  const [models, setModels] = React.useState<ModelSchedule[]>(initial.models)
  const [holidays, setHolidays] = React.useState<string[]>(initial.holidays)
  const [timezoneOverride, setTimezoneOverride] = React.useState(initial.timezone ?? '')
  // Runtime-tolerant read: an older Host may not send the compression block yet.
  const [initialCompression] = React.useState<ContextCompressionConfig>(
    () => (snapshot.settings as { contextCompression?: ContextCompressionConfig }).contextCompression
      ?? { enabled: false, threshold: 80 },
  )
  const [compressionEnabled, setCompressionEnabled] = React.useState(initialCompression.enabled)
  const [thresholdText, setThresholdText] = React.useState(String(initialCompression.threshold))
  const [modelChoice, setModelChoice] = React.useState('')
  const [holidayDate, setHolidayDate] = React.useState('')
  const [rangeFrom, setRangeFrom] = React.useState('')
  const [rangeTo, setRangeTo] = React.useState('')
  const [bulkYear, setBulkYear] = React.useState(String(new Date().getFullYear()))
  const [bulkDates, setBulkDates] = React.useState('')
  const [holidayNote, setHolidayNote] = React.useState<string | null>(null)
  const started = snapshot.settings.lastStartedAt

  // Runtime-tolerant read: an older Host may not send the schedule block yet.
  const timezone: TimeZoneView =
    (snapshot.settings as { timezone?: TimeZoneView }).timezone ?? { id: 'UTC', source: 'host' }
  const catalog = snapshot.settings.modelCatalog
  const holidayGroups = React.useMemo(() => groupHolidays(holidays), [holidays])

  /** A model route's catalog display name; empty when the catalog does not know it. */
  const routeLabel = (provider: string, model: string): string => {
    const group = catalog.find((item) => item.provider === provider)
    const entry = group?.models.find((item) => item.id === model)
    const groupLabel = group?.name && group.name !== provider ? `${group.name} · ` : ''
    if (entry?.name && entry.name !== model) return `${groupLabel}${entry.name}`
    if (group?.name && group.name !== provider) return group.name
    return ''
  }

  const routeOptions = catalog.flatMap((group) => group.models.map((entry) => ({
    key: `${group.provider}|${entry.id}`,
    provider: group.provider,
    model: entry.id,
    label: `${group.name && group.name !== group.provider ? group.name + ' · ' : ''}${entry.name || entry.id}`,
  })))
  const configuredKeys = new Set(models.map((entry) => `${entry.provider}|${entry.model}`))
  const addableRoutes = routeOptions.filter((option) => !configuredKeys.has(option.key))
  const addRoute = addableRoutes.find((option) => option.key === modelChoice) ?? addableRoutes[0]

  const draft = React.useMemo<ScheduleConfig>(() => ({
    models,
    holidays,
    timezone: timezoneOverride.trim().length === 0 ? null : timezoneOverride.trim(),
  }), [models, holidays, timezoneOverride])
  const validation = React.useMemo(() => validateScheduleDraft(draft), [draft])
  const errors = validation.ok ? [] : validation.errors
  // The compression section is validated separately: its threshold is raw
  // input text, and the Host validates the same rules on save.
  const compressionValidation = React.useMemo(
    () => validateContextCompressionDraft({ enabled: compressionEnabled, threshold: thresholdText }),
    [compressionEnabled, thresholdText],
  )
  const canSave = validation.ok && compressionValidation.ok
  const issueCount = errors.length + (compressionValidation.ok ? 0 : 1)
  const compressionErrorMessage = (error: ContextCompressionDraftError): string => {
    if (error === 'integer') return t('settings.contextCompression.thresholdInteger')
    if (error === 'range') {
      return t('settings.contextCompression.thresholdRange', {
        min: CONTEXT_COMPRESSION_THRESHOLD_MIN,
        max: CONTEXT_COMPRESSION_THRESHOLD_MAX,
      })
    }
    return t('settings.contextCompression.thresholdNumber')
  }
  // The live availability preview follows the manual override when one is
  // typed, otherwise the zone the Host reports as effective.
  const previewZone = draft.timezone ?? timezone.id

  const generalErrors = errors.filter((issue) => {
    if (issue.path === '' || issue.path === 'models') return true
    if (/^models\[\d+\]/.test(issue.path)) return false
    if (issue.path === 'holidays' || issue.path.startsWith('holidays[')) return false
    if (issue.path === 'timezone') return false
    return true
  })
  const timezoneIssues = issuesFor(errors, 'timezone').map((issue) => issueMessage(t, issue))
  const holidayIssues = errors
    .filter((issue) => issue.path === 'holidays' || issue.path.startsWith('holidays['))
    .map((issue) => issueMessage(t, issue))

  const modelIssues = (modelIndex: number): string[] => issuesFor(errors, `models[${modelIndex}]`)
    .filter((issue) => !issue.path.includes('.disabledWindows['))
    .map((issue) => issueMessage(t, issue))
  const windowIssues = (modelIndex: number, windowIndex: number): string[] =>
    issuesFor(errors, `models[${modelIndex}].disabledWindows[${windowIndex}]`)
      .map((issue) => issueMessage(t, issue))

  const addModel = (): void => {
    if (addRoute === undefined) return
    const provider = addRoute.provider
    const model = addRoute.model
    setModels((current) => current.some((entry) => entry.provider === provider && entry.model === model)
      ? current
      : [...current, { provider, model, disabledWindows: [] }])
    setModelChoice('')
  }
  const removeModel = (modelIndex: number): void => {
    setModels((current) => current.filter((_, index) => index !== modelIndex))
  }
  const addWindow = (modelIndex: number): void => {
    setModels((current) => current.map((entry, index) => index === modelIndex
      ? { ...entry, disabledWindows: [...entry.disabledWindows, newDisabledWindow()] }
      : entry))
  }
  const removeWindow = (modelIndex: number, windowIndex: number): void => {
    setModels((current) => current.map((entry, index) => index === modelIndex
      ? { ...entry, disabledWindows: entry.disabledWindows.filter((_, at) => at !== windowIndex) }
      : entry))
  }
  const updateWindow = (modelIndex: number, windowIndex: number, next: DisabledWindow): void => {
    setModels((current) => current.map((entry, index) => index === modelIndex
      ? {
          ...entry,
          disabledWindows: entry.disabledWindows.map((window, at) => at === windowIndex ? next : window),
        }
      : entry))
  }

  const addSingleHoliday = (): void => {
    if (!isRealDateKey(holidayDate)) {
      setHolidayNote(t('settings.holidays.invalidDate'))
      return
    }
    setHolidays((current) => mergeHolidays(current, [holidayDate]))
    setHolidayDate('')
    setHolidayNote(null)
  }
  const addHolidayRange = (): void => {
    const to = rangeTo.length > 0 ? rangeTo : rangeFrom
    const result = expandHolidayRange(rangeFrom, to)
    if (result.error === 'invalid') {
      setHolidayNote(t('settings.holidays.rangeInvalid'))
      return
    }
    if (result.error === 'too-long') {
      setHolidayNote(t('settings.holidays.rangeTooLong', { n: MAX_HOLIDAY_RANGE_DAYS }))
      return
    }
    setHolidays((current) => mergeHolidays(current, result.dates))
    setRangeFrom('')
    setRangeTo('')
    setHolidayNote(null)
  }
  const addBulkHolidays = (): void => {
    if (parseHolidayYear(bulkYear) === null) {
      setHolidayNote(t('settings.holidays.yearInvalid'))
      return
    }
    const result = expandYearHolidays(bulkYear, bulkDates)
    if (result.dates.length === 0) {
      setHolidayNote(result.invalid.length > 0
        ? t('settings.holidays.bulkInvalid', { items: result.invalid.join(', ') })
        : t('settings.holidays.bulkEmpty'))
      return
    }
    setHolidays((current) => mergeHolidays(current, result.dates))
    setBulkDates('')
    setHolidayNote(result.invalid.length > 0
      ? t('settings.holidays.bulkInvalid', { items: result.invalid.join(', ') })
      : null)
  }
  const deleteHoliday = (date: string): void => {
    setHolidays((current) => removeHolidayDates(current, [date]))
  }
  const deleteHolidayYear = (year: string): void => {
    setHolidays((current) => removeHolidayYear(current, year))
  }

  const submit = (): void => {
    if (!validation.ok || !compressionValidation.ok) return
    void onSubmit({
      defaultMateId: defaultMateId === '' ? null : defaultMateId,
      pollMs: Number(pollMs),
      schedule: validation.value,
      contextCompression: compressionValidation.value,
    })
  }

  return (
    <Modal
      title={t('settings.title')}
      onClose={onClose}
      wide
      footer={(
        <>
          {!canSave ? (
            <span className="mate-sub mate-foot-hint">
              {t('settings.invalid', { n: issueCount })}
            </span>
          ) : null}
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" busy={busy} disabled={!canSave} onClick={submit}>
            {t('action.save')}
          </Button>
        </>
      )}
    >
      <div className="mate-profile">
        <section className="mate-profile-section">
          <h3>{t('settings.timezone.title')}</h3>
          <div className="mate-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="mate-kv">
              <span>{t('settings.timezone.effective')}</span>
              <span className="mate-mono">{timezone.id}</span>
              <Badge tone={timezone.source === 'manual' ? 'auto' : 'confirm'}>
                {t(`settings.timezone.source.${timezone.source}`)}
              </Badge>
            </div>
            <Field label={t('settings.timezone.override')} hint={t('settings.timezone.overrideHint')}>
              <input
                className="mate-input"
                value={timezoneOverride}
                placeholder={t('settings.timezone.overridePlaceholder')}
                onChange={(event) => setTimezoneOverride(event.target.value)}
              />
            </Field>
            <ErrorLines messages={timezoneIssues} />
          </div>
        </section>

        <section className="mate-profile-section">
          <h3>{t('settings.schedule.title')}</h3>
          <span className="mate-sub">{t('settings.schedule.hint')}</span>
          <span className="mate-sub">{t('settings.schedule.zoneNote', { zone: previewZone })}</span>
          {models.length === 0 ? (
            <div className="mate-kv">
              <Badge tone="auto">{t('settings.schedule.alwaysAvailable')}</Badge>
              <span className="mate-sub">{t('settings.schedule.empty')}</span>
            </div>
          ) : null}
          {models.map((entry, modelIndex) => {
            const availability = tryModelAvailability(entry, previewZone, holidays)
            return (
              <div
                key={`${entry.provider}|${entry.model}`}
                className="mate-panel"
                style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="mate-row-main">
                    <span className="mate-row-title mate-mono">{entry.provider} / {entry.model}</span>
                    {routeLabel(entry.provider, entry.model) !== ''
                      ? <span className="mate-row-meta">{routeLabel(entry.provider, entry.model)}</span>
                      : null}
                  </span>
                  {availability === null ? null : availability.available
                    ? <Badge tone="auto">{t('settings.schedule.status.available')}</Badge>
                    : <Badge tone="warn">{t('settings.schedule.status.blocked')}</Badge>}
                  <Button
                    variant="ghost"
                    aria-label={t('settings.schedule.removeModel')}
                    title={t('settings.schedule.removeModel')}
                    onClick={() => removeModel(modelIndex)}
                  >
                    ✕
                  </Button>
                </div>
                {availability !== null && !availability.available && availability.nextAvailableAt !== null ? (
                  <span className="mate-sub">
                    {t('settings.schedule.status.next', {
                      time: formatZonedDateTime(availability.nextAvailableAt, previewZone),
                    })}
                  </span>
                ) : null}
                <ErrorLines messages={modelIssues(modelIndex)} />
                {entry.disabledWindows.length === 0
                  ? <span className="mate-sub">{t('settings.schedule.alwaysAvailable')}</span>
                  : entry.disabledWindows.map((window, windowIndex) => {
                    const choice = windowKindChoice(window.kind)
                    return (
                      <div
                        key={windowIndex}
                        title={windowSummary(window)}
                        style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                      >
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <select
                            className="mate-select"
                            style={{ width: 'auto', minWidth: 110 }}
                            value={choice}
                            aria-label={t('settings.schedule.windowKind')}
                            onChange={(event) => updateWindow(
                              modelIndex,
                              windowIndex,
                              withWindowKind(window, event.target.value as WindowKindChoice),
                            )}
                          >
                            <option value="weekday">{t('settings.schedule.kind.weekday')}</option>
                            <option value="weekend">{t('settings.schedule.kind.weekend')}</option>
                            <option value="holiday">{t('settings.schedule.kind.holiday')}</option>
                            <option value="weekdays">{t('settings.schedule.kind.weekdays')}</option>
                          </select>
                          {choice === 'weekdays' ? (
                            <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
                              {WEEKDAYS.map((code: WeekdayCode) => {
                                const checked = Array.isArray(window.kind) && window.kind.includes(code)
                                return (
                                  <label key={code} className="mate-check">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => updateWindow(modelIndex, windowIndex, toggleWeekday(window, code))}
                                    />
                                    {t(`weekday.${code}`)}
                                  </label>
                                )
                              })}
                            </span>
                          ) : null}
                          <input
                            className="mate-input"
                            type="time"
                            style={{ width: 112 }}
                            value={window.start}
                            aria-label={t('settings.schedule.start')}
                            title={t('settings.schedule.start')}
                            onChange={(event) => updateWindow(modelIndex, windowIndex, { ...window, start: event.target.value })}
                          />
                          <span className="mate-sub">–</span>
                          <input
                            className="mate-input"
                            type="time"
                            style={{ width: 112 }}
                            value={window.end}
                            aria-label={t('settings.schedule.end')}
                            title={t('settings.schedule.end')}
                            onChange={(event) => updateWindow(modelIndex, windowIndex, { ...window, end: event.target.value })}
                          />
                          <Button
                            variant="ghost"
                            aria-label={t('settings.schedule.removeWindow')}
                            title={t('settings.schedule.removeWindow')}
                            onClick={() => removeWindow(modelIndex, windowIndex)}
                          >
                            ✕
                          </Button>
                        </div>
                        <ErrorLines messages={windowIssues(modelIndex, windowIndex)} />
                      </div>
                    )
                  })}
                <div>
                  <Button onClick={() => addWindow(modelIndex)}>+ {t('settings.schedule.addWindow')}</Button>
                </div>
              </div>
            )
          })}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {catalog.length === 0 ? (
              <span className="mate-sub">{t('settings.schedule.catalogEmpty')}</span>
            ) : addableRoutes.length === 0 ? (
              <span className="mate-sub">{t('settings.schedule.allModelsConfigured')}</span>
            ) : (
              <>
                <select
                  className="mate-select"
                  style={{ width: 'auto', minWidth: 220 }}
                  value={addRoute?.key ?? ''}
                  aria-label={t('settings.schedule.addModel')}
                  onChange={(event) => setModelChoice(event.target.value)}
                >
                  {addableRoutes.map((option) => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
                <Button onClick={addModel}>+ {t('settings.schedule.addModel')}</Button>
              </>
            )}
          </div>
        </section>

        <section className="mate-profile-section">
          <h3>{t('settings.holidays.title')}</h3>
          <span className="mate-sub">{t('settings.holidays.hint')}</span>
          <div className="mate-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ width: 170 }}>
                <Field label={t('settings.holidays.date')}>
                  <input
                    className="mate-input"
                    type="date"
                    value={holidayDate}
                    onChange={(event) => setHolidayDate(event.target.value)}
                  />
                </Field>
              </div>
              <Button disabled={holidayDate === ''} onClick={addSingleHoliday}>
                {t('settings.holidays.addDate')}
              </Button>
            </div>
            <div className="mate-kv">
              <span>{t('settings.holidays.range')}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ width: 170 }}>
                <Field label={t('settings.holidays.from')}>
                  <input
                    className="mate-input"
                    type="date"
                    value={rangeFrom}
                    onChange={(event) => setRangeFrom(event.target.value)}
                  />
                </Field>
              </div>
              <div style={{ width: 170 }}>
                <Field label={t('settings.holidays.to')}>
                  <input
                    className="mate-input"
                    type="date"
                    value={rangeTo}
                    onChange={(event) => setRangeTo(event.target.value)}
                  />
                </Field>
              </div>
              <Button disabled={rangeFrom === ''} onClick={addHolidayRange}>
                {t('settings.holidays.addRange')}
              </Button>
            </div>
            <div className="mate-kv">
              <span>{t('settings.holidays.bulk')}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ width: 110 }}>
                <Field label={t('settings.holidays.year')}>
                  <input
                    className="mate-input"
                    inputMode="numeric"
                    maxLength={4}
                    value={bulkYear}
                    onChange={(event) => setBulkYear(event.target.value)}
                  />
                </Field>
              </div>
              <div style={{ flex: '1 1 220px', minWidth: 200 }}>
                <Field label={t('settings.holidays.mmdd')} hint={t('settings.holidays.mmddHint')}>
                  <input
                    className="mate-input"
                    value={bulkDates}
                    placeholder="01-01, 05-01, 10-01"
                    onChange={(event) => setBulkDates(event.target.value)}
                  />
                </Field>
              </div>
              <Button disabled={bulkDates.trim().length === 0} onClick={addBulkHolidays}>
                {t('settings.holidays.bulkAdd')}
              </Button>
            </div>
            {holidayNote !== null ? (
              <span className="mate-error-line">{holidayNote}</span>
            ) : null}
            <ErrorLines messages={holidayIssues} />
          </div>
          {holidays.length === 0 ? (
            <div className="mate-sub">{t('settings.holidays.none')}</div>
          ) : (
            <div className="mate-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {holidayGroups.map((group) => (
                <div key={group.year} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="mate-row-title">{group.year}</span>
                    <span className="mate-sub">{t('settings.holidays.count', { n: group.dates.length })}</span>
                    <Button variant="ghost" onClick={() => deleteHolidayYear(group.year)}>
                      {t('settings.holidays.deleteYear', { year: group.year })}
                    </Button>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {group.dates.map((date) => (
                      <span key={date} className="mate-chipwrap">
                        <span className="mate-chip" style={{ cursor: 'default' }}>{date}</span>
                        <button
                          type="button"
                          className="mate-chip-edit"
                          aria-label={t('settings.holidays.deleteDate', { date })}
                          title={t('settings.holidays.deleteDate', { date })}
                          onClick={() => deleteHoliday(date)}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="mate-profile-section">
          <h3>{t('settings.contextCompression.title')}</h3>
          <div className="mate-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label className="mate-check">
              <input
                type="checkbox"
                checked={compressionEnabled}
                onChange={(event) => setCompressionEnabled(event.target.checked)}
              />
              {t('settings.contextCompression.enable')}
            </label>
            <Field
              label={t('settings.contextCompression.threshold')}
              hint={t('settings.contextCompression.thresholdHint')}
            >
              <input
                className="mate-input"
                type="number"
                min={CONTEXT_COMPRESSION_THRESHOLD_MIN}
                max={CONTEXT_COMPRESSION_THRESHOLD_MAX}
                step={1}
                inputMode="numeric"
                value={thresholdText}
                disabled={!compressionEnabled}
                aria-label={t('settings.contextCompression.threshold')}
                aria-invalid={compressionValidation.ok ? undefined : true}
                onChange={(event) => setThresholdText(event.target.value)}
              />
            </Field>
            <ErrorLines messages={compressionValidation.ok ? [] : [compressionErrorMessage(compressionValidation.error)]} />
          </div>
        </section>

        <section className="mate-profile-section">
          <h3>{t('settings.section.general')}</h3>
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
        </section>

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
      </div>
    </Modal>
  )
}











