import React from 'react'
import { COMMANDS, type MateView, type RequirementStatus, type RequirementView, type Snapshot } from '../shared.js'
import { ComposeDialog, MateEditorDialog, SettingsDialog } from './dialogs.js'
import { RequirementDrawer } from './drawer.js'
import { formatRelative, projectLabel, type PanelContext } from './types.js'
import { Badge, Button, EmptyState, Spinner } from './ui.js'

type ColumnKey = 'pending' | 'running' | 'review' | 'done' | 'failed'

const COLUMNS: Array<{ key: ColumnKey; statuses: RequirementStatus[] }> = [
  { key: 'pending', statuses: ['draft', 'analyzing', 'clarifying', 'proposed', 'approved'] },
  { key: 'running', statuses: ['running'] },
  { key: 'review', statuses: ['awaiting_review'] },
  { key: 'done', statuses: ['done'] },
  { key: 'failed', statuses: ['failed', 'cancelled'] },
]

const STATUS_COLUMN: Record<RequirementStatus, ColumnKey> = {
  draft: 'pending',
  analyzing: 'pending',
  clarifying: 'pending',
  proposed: 'pending',
  approved: 'pending',
  running: 'running',
  awaiting_review: 'review',
  done: 'done',
  failed: 'failed',
  cancelled: 'failed',
}

function statusClass(status: RequirementStatus): string {
  if (status === 'failed') return 'error'
  if (status === 'awaiting_review') return 'warn'
  if (status === 'running') return 'auto'
  return ''
}

/** The Mate main panel: toolbar, filters, live strip, board or list. */
export function MatePanel(context: PanelContext): React.ReactElement {
  const { state, controller, t } = context
  const [view, setView] = React.useState<'board' | 'list'>('board')
  const [mateFilter, setMateFilter] = React.useState<string>('all')
  const [projectFilter, setProjectFilter] = React.useState<string>('all')
  const [columnFilter, setColumnFilter] = React.useState<'all' | ColumnKey>('all')
  const [query, setQuery] = React.useState('')
  const [drawerId, setDrawerId] = React.useState<string | null>(null)
  const [composeOpen, setComposeOpen] = React.useState(false)
  const [mateEditor, setMateEditor] = React.useState<MateView | 'new' | null>(null)
  const [settingsOpen, setSettingsOpen] = React.useState(false)

  const snapshot: Snapshot | null = state.snapshot
  const lang = React.useMemo(() => navigator.language.toLowerCase().startsWith('zh') ? 'zh' as const : 'en' as const, [])

  React.useEffect(() => {
    controller.start()
    return () => { controller.stop() }
  }, [controller])

  const mates = snapshot?.mates.filter((mate) => !mate.archived) ?? []
  const requirements = snapshot?.requirements.filter((item) => item.parentId === null) ?? []
  const projects = snapshot?.projects ?? []

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    return requirements.filter((requirement) => {
      if (mateFilter !== 'all' && requirement.mateId !== mateFilter) return false
      if (projectFilter !== 'all' && requirement.projectPath !== projectFilter) return false
      if (columnFilter !== 'all' && STATUS_COLUMN[requirement.status] !== columnFilter) return false
      if (needle.length > 0) {
        const haystack = `${requirement.title}\n${requirement.brief}`.toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      return true
    })
  }, [requirements, mateFilter, projectFilter, columnFilter, query])

  const byColumn = React.useMemo(() => {
    const groups: Record<ColumnKey, RequirementView[]> = { pending: [], running: [], review: [], done: [], failed: [] }
    for (const requirement of filtered) groups[STATUS_COLUMN[requirement.status]].push(requirement)
    return groups
  }, [filtered])

  const drawerRequirement = drawerId === null
    ? null
    : snapshot?.requirements.find((item) => item.id === drawerId) ?? null

  const activeMate = snapshot?.mates.find((mate) => mate.id === snapshot.settings.defaultMateId) ?? mates[0]
  const openSession = context.openSession
  const busy = (key: string): boolean => state.busy[key] === true

  const refresh = (): void => { void controller.refresh(true) }

  return (
    <div className="mate-root">
      <header className="mate-head">
        <div className="mate-title">
          <h1>{t('panel.title')}</h1>
          <span className="mate-sub">
            {t('panel.subtitle', {
              requirements: requirements.length,
              projects: projects.length,
              sessions: snapshot?.liveSessions.length ?? 0,
            })}
          </span>
          {state.phase === 'loading' ? <Spinner /> : null}
        </div>
        <div className="mate-actions">
          <Button onClick={refresh} disabled={state.phase === 'loading'}>{t('action.refresh')}</Button>
          <Button onClick={() => setMateEditor('new')}>{t('action.newMate')}</Button>
          <Button onClick={() => setSettingsOpen(true)}>{t('action.settings')}</Button>
          <Button variant="primary" onClick={() => setComposeOpen(true)} disabled={mates.length === 0}>
            {t('action.newRequirement')}
          </Button>
        </div>
      </header>

      {state.error !== null ? (
        <div className="mate-panel mate-error-line">
          {t('error.loadFailed', { message: state.error })}
        </div>
      ) : null}

      {query === '' && columnFilter === 'all' ? (
        <div className="mate-chiprow">
          <button type="button" className={`mate-chip${mateFilter === 'all' ? ' on' : ''}`} onClick={() => setMateFilter('all')}>
            {t('filter.allMates')}
          </button>
          {mates.map((mate) => (
            <button
              key={mate.id}
              type="button"
              className={`mate-chip${mateFilter === mate.id ? ' on' : ''}`}
              onClick={() => setMateFilter(mate.id)}
              onDoubleClick={() => setMateEditor(mate)}
              title={`${mate.specialty || mate.description}\n${mate.model.provider}/${mate.model.model}`}
            >
              <span className="mate-dot" />
              {mate.name}
              <span style={{ opacity: 0.6 }}>{mate.autonomy === 'auto' ? t('badge.auto') : t('badge.confirm')}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="mate-toolbar">
        <div className="mate-seg">
          <button type="button" className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>{t('view.board')}</button>
          <button type="button" className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>{t('view.list')}</button>
        </div>
        <div className="mate-filters" style={{ flex: 1 }}>
          <select className="mate-select" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
            <option value="all">{t('filter.allProjects')}</option>
            {projects.map((project) => (
              <option key={project.path} value={project.path}>{projectLabel(project.path)}</option>
            ))}
          </select>
          <select
            className="mate-select"
            value={columnFilter}
            onChange={(event) => setColumnFilter(event.target.value as 'all' | ColumnKey)}
          >
            <option value="all">{t('filter.allStatus')}</option>
            {COLUMNS.map((column) => (
              <option key={column.key} value={column.key}>{t(`column.${column.key}`)}</option>
            ))}
          </select>
          <input
            className="mate-input"
            value={query}
            placeholder={t('filter.search')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {activeMate !== undefined ? (
          <span className="mate-sub">{activeMate.name} · {activeMate.model.model}</span>
        ) : null}
      </div>

      <ActiveStrip context={context} />

      {snapshot === null ? (
        state.phase === 'error'
          ? <EmptyState title={t('error.starting')} hint={state.error ?? undefined} action={<Button onClick={refresh}>{t('action.refresh')}</Button>} />
          : <div className="mate-panel" style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Spinner /> {t('error.starting')}</div>
      ) : mates.length === 0 ? (
        <EmptyState
          title={t('empty.mates.title')}
          hint={t('empty.mates.hint')}
          action={<Button variant="primary" onClick={() => setMateEditor('new')}>{t('action.newMate')}</Button>}
        />
      ) : requirements.length === 0 ? (
        <EmptyState
          title={t('empty.requirements.title')}
          hint={t('empty.requirements.hint')}
          action={<Button variant="primary" onClick={() => setComposeOpen(true)}>{t('action.newRequirement')}</Button>}
        />
      ) : view === 'board' ? (
        <div className="mate-board">
          {COLUMNS.map((column) => (
            <div key={column.key} className="mate-col">
              <div className="mate-col-head">
                <span>{t(`column.${column.key}`)}</span>
                <span className="mate-count">{byColumn[column.key].length}</span>
              </div>
              {byColumn[column.key].length === 0
                ? <div className="mate-empty">{t('empty.column')}</div>
                : byColumn[column.key].map((requirement) => (
                  <RequirementCard
                    key={requirement.id}
                    requirement={requirement}
                    t={t}
                    lang={lang}
                    childrenCount={snapshot.requirements.filter((item) => item.parentId === requirement.id).length}
                    onOpen={() => setDrawerId(requirement.id)}
                  />
                ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="mate-list">
          {[...filtered].sort((a, b) => b.updatedAt - a.updatedAt).map((requirement) => (
            <button key={requirement.id} type="button" className="mate-row" onClick={() => setDrawerId(requirement.id)}>
              <div className="mate-row-main">
                <span className="mate-row-title">#{requirement.number} {requirement.title}</span>
                <span className="mate-row-meta">
                  {requirement.mateName} · {projectLabel(requirement.projectPath)} · {requirement.mateModel} · {formatRelative(requirement.updatedAt, lang)}
                </span>
              </div>
              <Badge tone={requirement.status === 'failed' ? 'error' : requirement.status === 'awaiting_review' ? 'warn' : ''}>
                {t(`status.${requirement.status}`)}
              </Badge>
              {requirement.dispatch?.pendingInput.length ? <Badge tone="warn">{t('badge.needsInput')}</Badge> : null}
            </button>
          ))}
        </div>
      )}

      {state.notice !== null && state.notice.text.length > 0 ? (
        <div className={`mate-notice${state.notice.kind === 'error' ? ' error' : ''}`} onClick={() => controller.clearNotice()}>
          {state.notice.text}
        </div>
      ) : null}

      {composeOpen && snapshot !== null ? (
        <ComposeDialog
          snapshot={snapshot}
          t={t}
          busy={busy('requirement.create')}
          onClose={() => setComposeOpen(false)}
          onSubmit={async (payload) => {
            const created = await controller.run<RequirementView>('requirement.create', COMMANDS.requirementCreate, payload)
            if (created !== null) {
              setComposeOpen(false)
              setDrawerId(created.id)
            }
          }}
        />
      ) : null}

      {mateEditor !== null ? (
        <MateEditorDialog
          mate={mateEditor === 'new' ? null : mateEditor}
          snapshot={snapshot}
          t={t}
          busy={busy('mate.save')}
          onClose={() => setMateEditor(null)}
          onDelete={async (mate) => {
            const removed = await controller.run('mate.delete', COMMANDS.mateDelete, { id: mate.id })
            if (removed !== null) setMateEditor(null)
          }}
          onSubmit={async (payload) => {
            const isNew = mateEditor === 'new'
            const saved = await controller.run<MateView>('mate.save', isNew ? COMMANDS.mateCreate : COMMANDS.mateUpdate, payload)
            if (saved !== null) setMateEditor(null)
            return saved !== null
          }}
        />
      ) : null}

      {settingsOpen && snapshot !== null ? (
        <SettingsDialog
          snapshot={snapshot}
          t={t}
          busy={busy('settings.update')}
          onClose={() => setSettingsOpen(false)}
          onSubmit={async (payload) => {
            const saved = await controller.run('settings.update', COMMANDS.settingsUpdate, payload)
            if (saved !== null) setSettingsOpen(false)
          }}
          onTest={async () => {
            await controller.refresh(true)
            const current = controller.getSnapshot()
            controller.notify(
              current.error === null ? 'ok' : 'error',
              current.error === null
                ? `${t('action.testConnection')}: OK (${current.snapshot?.liveSessions.length ?? 0} sessions, rev ${current.rev})`
                : current.error,
            )
          }}
        />
      ) : null}

      {drawerRequirement !== null && snapshot !== null ? (
        <RequirementDrawer
          requirement={drawerRequirement}
          snapshot={snapshot}
          controller={controller}
          t={t}
          lang={lang}
          openSession={openSession}
          onOpenRequirement={(id) => setDrawerId(id)}
          onClose={() => setDrawerId(null)}
        />
      ) : null}
    </div>
  )
}

function ActiveStrip({ context }: { context: PanelContext }): React.ReactElement | null {
  const { state, t, openSession } = context
  const sessions = state.snapshot?.liveSessions ?? []
  if (sessions.length === 0) return null
  const running = sessions.filter((session) => session.running)
  const shown = [...running, ...sessions.filter((session) => !session.running)].slice(0, 8)
  const lang = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  return (
    <div className="mate-strip" aria-label="live sessions">
      {shown.map((session) => (
        <button
          key={session.sessionId}
          type="button"
          className="mate-strip-item"
          onClick={() => openSession(session.sessionId)}
          title={session.cwd}
          style={{ textAlign: 'left', color: 'inherit', cursor: 'pointer' }}
        >
          <b>{session.title}</b>
          <span>
            {session.running ? (lang === 'zh' ? '运行中' : 'running') : projectLabel(session.cwd)}
            {' · '}
            {formatRelative(session.updatedAt, lang)}
          </span>
        </button>
      ))}
    </div>
  )
}

function RequirementCard({ requirement, t, lang, childrenCount, onOpen }: {
  requirement: RequirementView
  t: PanelContext['t']
  lang: 'zh' | 'en'
  childrenCount: number
  onOpen: () => void
}): React.ReactElement {
  const status = requirement.status
  return (
    <button type="button" className="mate-card" onClick={onOpen}>
      <span className="mate-card-title">#{requirement.number} {requirement.title}</span>
      <span className="mate-card-meta">
        <Badge tone={requirement.autonomy === 'auto' ? 'auto' : 'confirm'}>
          {requirement.autonomy === 'auto' ? t('badge.auto') : t('badge.confirm')}
        </Badge>
        {requirement.kind === 'goal' ? <Badge tone="goal">{t('badge.goal')}</Badge> : null}
        {requirement.dispatch?.pendingInput.length ? <Badge tone="warn">{t('badge.needsInput')}</Badge> : null}
        <span>{t(`status.${status}`)}</span>
      </span>
      <span className="mate-card-foot">
        <span>{projectLabel(requirement.projectPath)}</span>
        <span>·</span>
        <span>{requirement.mateName}</span>
        {requirement.analysis !== null ? (
          <>
            <span>·</span>
            <span>{t('meta.noTasks', { n: requirement.analysis.subTasks.length })}</span>
          </>
        ) : null}
        {childrenCount > 0 ? (
          <>
            <span>·</span>
            <span>{childrenCount} {t('drawer.children')}</span>
          </>
        ) : null}
        <span style={{ marginLeft: 'auto' }}>{formatRelative(requirement.updatedAt, lang)}</span>
      </span>
    </button>
  )
}
