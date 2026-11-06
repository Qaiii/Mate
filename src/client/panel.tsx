import React from 'react'
import { COMMANDS, type LiveSessionView, type MateDistillView, type MateView, type ModelEffortsView, type RequirementStatus, type RequirementView, type Snapshot } from '../shared.js'
import { ComposeDialog, MateEditorDialog, SettingsDialog } from './dialogs.js'
import { RequirementDrawer } from './drawer.js'
import { SessionDrawer } from './sessionDrawer.js'
import { formatRelative, projectLabel, projectSourceLabelKey, type PanelContext } from './types.js'
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
  conflict: 'pending',
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
  const [sessionDrawerId, setSessionDrawerId] = React.useState<string | null>(null)
  const [composeOpen, setComposeOpen] = React.useState(false)
  const [mateEditor, setMateEditor] = React.useState<MateView | 'new' | null>(null)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [showSessions, setShowSessions] = React.useState(true)

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

  /** Existing sessions Mate is not tracking yet, shown in their own lane. */
  const sessionCards = React.useMemo<LiveSessionView[]>(() => {
    if (!showSessions || snapshot === null) return []
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000
    const needle = query.trim().toLowerCase()
    return snapshot.liveSessions
      .filter((session) => {
        if (session.hidden || session.blank) return false
        if (session.origin === 'subagent') return false
        if (session.linkedRequirementId !== null) return false
        if (projectFilter !== 'all' && session.cwd !== projectFilter) return false
        if (needle.length > 0 && !`${session.title}\n${session.cwd}`.toLowerCase().includes(needle)) return false
        return session.running || session.updatedAt >= dayAgo
      })
      .sort((a, b) => Number(b.running) - Number(a.running) || b.updatedAt - a.updatedAt)
  }, [snapshot, showSessions, projectFilter, query])

  const totalSessionCards = sessionCards.length

  const drawerRequirement = drawerId === null
    ? null
    : snapshot?.requirements.find((item) => item.id === drawerId) ?? null

  const activeMate = snapshot?.mates.find((mate) => mate.id === snapshot.settings.defaultMateId) ?? mates[0]
  const openSession = context.openSession
  const busy = (key: string): boolean => state.busy[key] === true

  const refresh = (): void => { void controller.refresh(true) }

  const cardsFor = (key: ColumnKey): Array<
    | { kind: 'req'; at: number; requirement: RequirementView }
    | { kind: 'session'; at: number; session: LiveSessionView }
  > => {
    const fromRequirements = byColumn[key].map((requirement) => ({
      kind: 'req' as const,
      at: requirement.updatedAt,
      requirement,
    }))
    // Untracked sessions join the column that matches their state: a running
    // session is in progress, an idle one has finished its last turn.
    const sessionsForColumn = columnFilter === 'all' || columnFilter === key
      ? key === 'running'
        ? sessionCards.filter((session) => session.running)
        : key === 'done'
          ? sessionCards.filter((session) => !session.running)
          : []
      : []
    const fromSessions = sessionsForColumn.map((session) => ({
      kind: 'session' as const,
      at: session.updatedAt,
      session,
    }))
    return [...fromRequirements, ...fromSessions].sort((a, b) => b.at - a.at)
  }

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
        <div className="mate-projecttabs" role="tablist" aria-label={t('compose.project')}>
          <button
            type="button"
            role="tab"
            aria-selected={projectFilter === 'all'}
            className={`mate-projecttab${projectFilter === 'all' ? ' on' : ''}`}
            onClick={() => setProjectFilter('all')}
          >
            {t('filter.allProjects')}
          </button>
          {projects.map((project) => (
            <button
              key={project.path}
              type="button"
              role="tab"
              aria-selected={projectFilter === project.path}
              className={`mate-projecttab${projectFilter === project.path ? ' on' : ''}`}
              title={project.path}
              onClick={() => setProjectFilter(project.path)}
            >
              {projectLabel(project.path)}
              {project.running > 0 ? <span className="mate-dot" style={{ marginLeft: 5 }} /> : null}
            </button>
          ))}
        </div>
        {view === 'list' ? (
          <select
            className="mate-select"
            style={{ width: 'auto' }}
            value={columnFilter}
            onChange={(event) => setColumnFilter(event.target.value as 'all' | ColumnKey)}
          >
            <option value="all">{t('filter.allStatus')}</option>
            {COLUMNS.map((column) => (
              <option key={column.key} value={column.key}>{t(`column.${column.key}`)}</option>
            ))}
          </select>
        ) : null}
        <input
          className="mate-input mate-search"
          value={query}
          placeholder={t('filter.search')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className={`mate-chip${showSessions ? ' on' : ''}`}
          onClick={() => setShowSessions((value) => !value)}
          title={t('toggle.showSessionsHint')}
        >
          {t('toggle.showSessions')}
        </button>
      </div>

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
      ) : requirements.length === 0 && totalSessionCards === 0 ? (
        <EmptyState
          title={t('empty.requirements.title')}
          hint={t('empty.requirements.hint')}
          action={<Button variant="primary" onClick={() => setComposeOpen(true)}>{t('action.newRequirement')}</Button>}
        />
      ) : view === 'list' ? (
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
          {sessionCards.map((session) => (
            <button
              key={session.sessionId}
              type="button"
              className="mate-row mate-row-session"
              onClick={() => setSessionDrawerId(session.sessionId)}
            >
              <div className="mate-row-main">
                <span className="mate-row-title">{session.title}</span>
                <span className="mate-row-meta">
                  {projectLabel(session.cwd)} · {session.running ? t('status.running') : t('badge.idle')} · {formatRelative(session.updatedAt, lang)}
                </span>
              </div>
              <Badge tone="warn">{t('badge.untracked')}</Badge>
            </button>
          ))}
          {filtered.length === 0 && sessionCards.length === 0
            ? <div className="mate-empty">{t('empty.column')}</div>
            : null}
        </div>
      ) : (
        <div className="mate-board">
          {COLUMNS.map((column) => (
            <div key={column.key} className="mate-col">
              <div className="mate-col-head">
                <span>{t(`column.${column.key}`)}</span>
                <span className="mate-count">{cardsFor(column.key).length}</span>
              </div>
              {cardsFor(column.key).length === 0
                ? <div className="mate-empty">{t('empty.column')}</div>
                : cardsFor(column.key).map((card) => card.kind === 'req' ? (
                  <RequirementCard
                    key={card.requirement.id}
                    requirement={card.requirement}
                    t={t}
                    lang={lang}
                    childrenCount={snapshot.requirements.filter((item) => item.parentId === card.requirement.id).length}
                    onOpen={() => setDrawerId(card.requirement.id)}
                    onOpenSession={() => setSessionDrawerId(card.requirement.dispatch?.sessionId ?? '')}
                  />
                ) : (
                  <SessionCard
                    key={card.session.sessionId}
                    session={card.session}
                    t={t}
                    lang={lang}
                    onOpen={() => setSessionDrawerId(card.session.sessionId)}
                  />
                ))}
            </div>
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
          controller={controller}
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
            return controller.run<MateView>('mate.save', isNew ? COMMANDS.mateCreate : COMMANDS.mateUpdate, payload)
          }}
          onDistill={async (mateId, text) => {
            return controller.run<MateDistillView>('mate.distill', COMMANDS.mateDistill, { id: mateId, text })
          }}
          onRemember={async (mateId, entries) => {
            return controller.run<MateView>('mate.remember', COMMANDS.mateRemember, { id: mateId, entries })
          }}
          onForget={async (mateId, entryId) => {
            return controller.run<MateView>('mate.forget', COMMANDS.mateForget, { id: mateId, entryId })
          }}
          onEfforts={async (provider, model) => {
            return controller.run<ModelEffortsView>('model.efforts', COMMANDS.modelEfforts, { provider, model })
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
          onRestoreHidden={async (sessionId) => {
            await controller.run('restore:' + sessionId, COMMANDS.sessionHide, { sessionId, hidden: false })
          }}
        />
      ) : null}

      {sessionDrawerId !== null ? (
        <SessionDrawer
          sessionId={sessionDrawerId}
          controller={controller}
          t={t}
          lang={lang}
          onClose={() => setSessionDrawerId(null)}
          openSession={openSession}
          onAdopted={(requirementId) => {
            setSessionDrawerId(null)
            setDrawerId(requirementId)
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

function RequirementCard({ requirement, t, lang, childrenCount, onOpen, onOpenSession }: {
  requirement: RequirementView
  t: PanelContext['t']
  lang: 'zh' | 'en'
  childrenCount: number
  onOpen: () => void
  onOpenSession?: () => void
}): React.ReactElement {
  const status = requirement.status
  return (
    <div className="mate-card">
      <button type="button" className="mate-card-open" onClick={onOpen}>
        <span className="mate-card-title">#{requirement.number} {requirement.title}</span>
        <span className="mate-card-meta">
          <Badge tone={requirement.autonomy === 'auto' ? 'auto' : 'confirm'}>
            {requirement.autonomy === 'auto' ? t('badge.auto') : t('badge.confirm')}
          </Badge>
          <Badge tone="confirm">{t(projectSourceLabelKey(requirement.projectSource))}</Badge>
          {requirement.status === 'conflict' ? <Badge tone="warn">{t('status.conflict')}</Badge> : null}
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
      {requirement.dispatch !== null && onOpenSession !== undefined ? (
        <button
          type="button"
          className="mate-session-chip"
          title={requirement.dispatch.sessionId}
          onClick={(event) => { event.stopPropagation(); onOpenSession() }}
        >
          {t('card.session')} · {t(`status.${status}`)}
        </button>
      ) : null}
    </div>
  )
}

/**
 * An existing session Mate does not track yet. It is a card rather than a
 * requirement until the user adopts it, so its actions never mutate the
 * session itself.
 */
function SessionCard({ session, t, lang, onOpen }: {
  session: LiveSessionView
  t: PanelContext['t']
  lang: 'zh' | 'en'
  onOpen: () => void
}): React.ReactElement {
  return (
    <button type="button" className="mate-card mate-card-session" onClick={onOpen} title={session.sessionId}>
      <span className="mate-card-title">{session.title}</span>
      <span className="mate-card-meta">
        <Badge tone="warn">{t('badge.untracked')}</Badge>
        <span>{session.running ? t('status.running') : t('badge.idle')}</span>
        <span>·</span>
        <span>{projectLabel(session.cwd)}</span>
        <span style={{ marginLeft: 'auto' }}>{formatRelative(session.updatedAt, lang)}</span>
      </span>
    </button>
  )
}











