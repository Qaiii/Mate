import React from 'react'
import { COMMANDS, type DispatchMode, type RequirementView, type Snapshot } from '../shared.js'
import type { MateController } from './controller.js'
import type { Translator } from './locales.js'
import { formatRelative, projectLabel, projectSourceLabelKey, queueDetail, userAttention } from './types.js'
import { Badge, Button, Field } from './ui.js'

export interface DrawerProps {
  requirement: RequirementView
  snapshot: Snapshot
  controller: MateController
  t: Translator
  lang: 'zh' | 'en'
  openSession: (sessionId: string) => void
  onOpenRequirement: (requirementId: string) => void
  onClose: () => void
}

/** Full requirement detail: analysis, discussion, plan, execution, review. */
export function RequirementDrawer(props: DrawerProps): React.ReactElement {
  const { requirement, snapshot, controller, t, lang, openSession, onOpenRequirement, onClose } = props
  const [answer, setAnswer] = React.useState('')
  const [extra, setExtra] = React.useState(requirement.plan?.extraInstruction ?? '')
  const [target, setTarget] = React.useState(requirement.plan?.targetProjectPath ?? requirement.projectPath)
  const [mode, setMode] = React.useState<DispatchMode>(requirement.plan?.dispatchMode ?? 'auto')
  const [childTitle, setChildTitle] = React.useState('')
  const busy = (key: string): boolean => controller.getSnapshot().busy[key] === true

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [onClose])

  const analysis = requirement.analysis
  const result = requirement.result
  const children = snapshot.requirements.filter((item) => item.parentId === requirement.id)
  // Only a confirm-mode requirement needs the user's gate; auto-mode Mates dispatch themselves.
  const canConfirm = requirement.autonomy === 'confirm'
    && (requirement.status === 'proposed' || requirement.status === 'clarifying' || requirement.status === 'failed')
  const canReview = requirement.status === 'awaiting_review'

  const run = (key: string, command: string, args: Record<string, unknown>): void => {
    void controller.run(key, command, { id: requirement.id, ...args })
  }

  return (
    <div className="mate-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <aside className="mate-drawer" role="dialog" aria-modal="true" aria-label={requirement.title}>
        <div className="mate-dialog-head">
          <h2>#{requirement.number} {requirement.title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="close">✕</Button>
        </div>

        {userAttention(requirement) !== null ? (
          <div className="mate-attention-banner">
            <strong>{t(userAttention(requirement) === 'reply' ? 'attention.reply' : 'attention.confirm')}</strong>
            <span>{t(userAttention(requirement) === 'reply' ? 'attention.replyHint' : 'attention.confirmHint')}</span>
          </div>
        ) : null}

        {requirement.status === 'queued' ? (
          <div className="mate-attention-banner">
            <strong>{t('queue.banner')}</strong>
            <span>
              {requirement.queue == null ? t('queue.badge') : queueDetail(requirement.queue, t, lang)}
            </span>
          </div>
        ) : null}

        <div className="mate-kv">
          <Badge tone={requirement.autonomy === 'auto' ? 'auto' : 'confirm'}>
            {requirement.autonomy === 'auto' ? t('badge.auto') : t('badge.confirm')}
          </Badge>
          <Badge tone="confirm">{t(projectSourceLabelKey(requirement.projectSource))}</Badge>
          {requirement.status === 'conflict' ? <Badge tone="warn">{t('status.conflict')}</Badge> : null}
          {requirement.kind === 'goal' ? <Badge tone="goal">{t('badge.goal')}</Badge> : null}
          <Badge tone={requirement.status === 'failed' ? 'error' : requirement.status === 'awaiting_review' || requirement.status === 'queued' ? 'warn' : ''}>
            {t(`status.${requirement.status}`)}
          </Badge>
          {requirement.dispatch?.pendingInput.length ? <Badge tone="warn">{t('badge.needsInput')}</Badge> : null}
          <span>{requirement.mateName}</span>
          <span>·</span>
          <span>{projectLabel(requirement.projectPath)}</span>
          <span>·</span>
          <span className="mate-mono">{requirement.mateModel}</span>
          <span>·</span>
          <span>{formatRelative(requirement.updatedAt, lang)}</span>
        </div>

        <div className="mate-dialog-foot" style={{ justifyContent: 'flex-start' }}>
          <Button
            busy={busy('requirement.analyze')}
            disabled={requirement.status === 'running' || requirement.status === 'analyzing'}
            onClick={() => run('requirement.analyze', COMMANDS.requirementAnalyze, {})}
          >
            {t('action.analyze')}
          </Button>
          {requirement.status !== 'done' && requirement.status !== 'cancelled' ? (
            <Button
              variant="danger"
              busy={busy('requirement.cancel')}
              onClick={() => {
                if (window.confirm(t('action.cancelRequirement') + '?')) {
                  run('requirement.cancel', COMMANDS.requirementCancel, {})
                }
              }}
            >
              {t('action.cancelRequirement')}
            </Button>
          ) : (
            <Button
              busy={busy('requirement.redispatch')}
              onClick={() => run('requirement.redispatch', COMMANDS.requirementRedispatch, {})}
            >
              {t('action.redispatch')}
            </Button>
          )}
          <Button
            variant="ghost"
            busy={busy('requirement.delete')}
            onClick={() => {
              if (window.confirm(`${t('action.delete')} #${requirement.number}?`)) {
                void controller
                  .run('requirement.delete', COMMANDS.requirementDelete, { id: requirement.id })
                  .then((value) => { if (value !== null) onClose() })
              }
            }}
          >
            {t('action.delete')}
          </Button>
        </div>

        {requirement.status === 'conflict' ? (
          <section className="mate-section">
            <h3>{t('drawer.projectConflict')}</h3>
            <div className="mate-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="mate-prose">
                {t('drawer.projectConflictText', {
                  suggested: projectLabel(requirement.analysis?.suggestedProjectPath ?? '') || '—',
                  chosen: projectLabel(requirement.projectPath) || '—',
                })}
              </div>
              <div className="mate-kv">
                <span className="mate-mono">{requirement.analysis?.suggestedProjectPath ?? '—'}</span>
                <span>vs</span>
                <span className="mate-mono">{requirement.projectPath || '—'}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button
                  variant="primary"
                  busy={busy('requirement.resolveProject')}
                  onClick={() => run('requirement.resolveProject', COMMANDS.requirementResolveProject, { choice: 'mate' })}
                >
                  {t('drawer.adoptMate')}
                </Button>
                <Button
                  busy={busy('requirement.resolveProject')}
                  onClick={() => run('requirement.resolveProject', COMMANDS.requirementResolveProject, { choice: 'user' })}
                >
                  {t('drawer.keepMine')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => run('requirement.resolveProject', COMMANDS.requirementResolveProject, { choice: 'user' })}
                >
                  {t('drawer.continueMine')}
                </Button>
              </div>
            </div>
          </section>
        ) : null}

        <section className="mate-section">
          <h3>{t('drawer.analysis')}</h3>
          {analysis === null ? (
            <div className="mate-panel mate-prose">
              {requirement.dispatch?.reused === true ? t('drawer.adoptedHint') : t('error.starting')}
            </div>
          ) : (
            <div className="mate-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="mate-prose">{analysis.summary}</div>
              <div className="mate-kv">
                <span>{t('meta.confidence', { n: Math.round(analysis.confidence * 100) })}</span>
                {analysis.provider !== undefined ? <span className="mate-mono">{analysis.provider}/{analysis.model}</span> : null}
              </div>
              {analysis.subTasks.length > 0 ? (
                <div>
                  <div className="mate-kv" style={{ marginBottom: 4 }}>{t('drawer.subTasks')}</div>
                  <ol className="mate-items">
                    {analysis.subTasks.map((task) => (
                      <li key={task.id}>
                        <strong>{task.title}</strong>
                        {task.detail ? <div style={{ opacity: 0.8 }}>{task.detail}</div> : null}
                        {task.acceptance ? <div style={{ opacity: 0.66 }}>✓ {task.acceptance}</div> : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
              {analysis.risks.length > 0 ? (
                <div>
                  <div className="mate-kv" style={{ marginBottom: 4 }}>{t('drawer.risks')}</div>
                  <ul className="mate-items">{analysis.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul>
                </div>
              ) : null}
            </div>
          )}
        </section>

        {analysis !== null && analysis.splitSuggestion.length > 0 && requirement.kind !== 'goal' ? (
          <section className="mate-section">
            <h3>{t('drawer.splitSuggestion')}</h3>
            <div className="mate-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <ol className="mate-items">
                {analysis.splitSuggestion.map((item, index) => (
                  <li key={index}>
                    <strong>{item.title}</strong>
                    {item.brief ? <div style={{ opacity: 0.8 }}>{item.brief}</div> : null}
                  </li>
                ))}
              </ol>
              <div>
                <Button
                  variant="primary"
                  busy={busy('requirement.split')}
                  onClick={() => run('requirement.split', COMMANDS.requirementSplit, {
                    items: analysis.splitSuggestion.map((item) => ({
                      title: item.title,
                      brief: item.brief,
                      acceptance: item.acceptance,
                    })),
                  })}
                >
                  {t('action.split', { n: analysis.splitSuggestion.length })}
                </Button>
              </div>
            </div>
          </section>
        ) : null}

        {analysis !== null && analysis.questions.length > 0 ? (
          <section className="mate-section">
            <h3>{t('drawer.questions')}</h3>
            <div className="mate-panel">
              <ul className="mate-items">{analysis.questions.map((question, index) => <li key={index}>{question}</li>)}</ul>
            </div>
          </section>
        ) : null}

        <section className="mate-section">
          <h3>{t('drawer.discussion')}</h3>
          <div className="mate-thread">
            {requirement.discussion.length === 0
              ? <div className="mate-empty">{t('drawer.noDiscussion')}</div>
              : requirement.discussion.map((entry, index) => (
                <div key={index} className={`mate-msg ${entry.role}`}>
                  <div className="mate-msg-role">{entry.role === 'user' ? (lang === 'zh' ? '我' : 'me') : requirement.mateName}</div>
                  {entry.text}
                </div>
              ))}
          </div>
          <textarea
            className="mate-textarea"
            value={answer}
            placeholder={t('drawer.answerPlaceholder')}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <div>
            <Button
              busy={busy('requirement.answer')}
              disabled={answer.trim().length === 0}
              onClick={() => {
                const text = answer.trim()
                if (text.length === 0) return
                setAnswer('')
                run('requirement.answer', COMMANDS.requirementAnswer, { text })
              }}
            >
              {t('action.answer')}
            </Button>
          </div>
        </section>

        {canConfirm ? (
          <section className="mate-section">
            <h3>{t('drawer.plan')}</h3>
            <div className="mate-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Field label={t('drawer.targetProject')}>
                <select className="mate-select" value={target} onChange={(event) => setTarget(event.target.value)}>
                  {snapshot.projects.map((project) => (
                    <option key={project.path} value={project.path}>{projectLabel(project.path)} — {project.path}</option>
                  ))}
                  {snapshot.projects.every((project) => project.path !== target) ? (
                    <option value={target}>{target || '—'}</option>
                  ) : null}
                </select>
              </Field>
              <Field label={t('drawer.dispatchMode')}>
                <select className="mate-select" value={mode} onChange={(event) => setMode(event.target.value as DispatchMode)}>
                  <option value="auto">{t('drawer.dispatchAuto')}</option>
                  <option value="new">{t('drawer.dispatchNew')}</option>
                  <option value="reuse-idle">{t('drawer.dispatchReuse')}</option>
                </select>
                <span className="hint">
                  {mode === 'auto'
                    ? requirement.analysis?.reuseSessionId
                      ? t('drawer.reuseHint')
                      : t('drawer.dispatchAutoHint')
                    : mode === 'reuse-idle'
                      ? t('drawer.reuseIdleHint')
                      : t('drawer.dispatchNewHint')}
                </span>
              </Field>
              <Field label={t('drawer.extra')}>
                <textarea className="mate-textarea" value={extra} onChange={(event) => setExtra(event.target.value)} />
              </Field>
              <div>
                <Button
                  variant="primary"
                  busy={busy('requirement.confirm')}
                  onClick={() => run('requirement.confirm', COMMANDS.requirementConfirm, {
                    targetProjectPath: target,
                    dispatchMode: mode,
                    extraInstruction: extra,
                  })}
                >
                  {t('action.confirmDispatch')}
                </Button>
              </div>
            </div>
          </section>
        ) : null}

        {requirement.dispatch !== null ? (
          <section className="mate-section">
            <h3>{t('drawer.execution')}</h3>
            <div className="mate-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="mate-kv">
                <span>{t('drawer.session')}:</span>
                <span className="mate-mono">{requirement.dispatch.sessionId}</span>
                <span>·</span>
                <span>{requirement.dispatch.reused ? t('drawer.dispatchReuse') : t('drawer.dispatchNew')}</span>
              </div>
              <div className="mate-kv">
                <span>{formatRelative(requirement.dispatch.requestedAt, lang)}</span>
                {requirement.dispatch.pendingInput.length > 0 ? (
                  <Badge tone="warn">{t('badge.needsInput')}: {requirement.dispatch.pendingInput.join(', ')}</Badge>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button onClick={() => openSession(requirement.dispatch?.sessionId ?? '')}>{t('action.openSession')}</Button>
                <Button onClick={() => { void navigator.clipboard.writeText(requirement.dispatch?.sessionId ?? '') }}>{t('action.copy')}</Button>
                {requirement.status === 'running' ? (
                  <Button variant="danger" busy={busy('requirement.cancel')} onClick={() => run('requirement.cancel', COMMANDS.requirementCancel, {})}>
                    {t('action.cancel')}
                  </Button>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        <section className="mate-section">
          <h3>{t('drawer.result')}</h3>
          {result === null ? (
            <div className="mate-empty">{t('drawer.resultEmpty')}</div>
          ) : (
            <div className="mate-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="mate-prose">{result.doneSummary}</div>
              {result.acceptance.length > 0 ? (
                <div>
                  <div className="mate-kv" style={{ marginBottom: 4 }}>{t('drawer.acceptance')}</div>
                  <ul className="mate-items">
                    {result.acceptance.map((item, index) => (
                      <li key={index}>{item.met ? '✓' : '✗'} {item.item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {result.remaining.length > 0 ? (
                <div>
                  <div className="mate-kv" style={{ marginBottom: 4 }}>{t('drawer.remaining')}</div>
                  <ul className="mate-items">{result.remaining.map((item, index) => <li key={index}>{item}</li>)}</ul>
                </div>
              ) : null}
              {result.followUps.length > 0 ? (
                <div>
                  <div className="mate-kv" style={{ marginBottom: 4 }}>{t('drawer.followUps')}</div>
                  <ul className="mate-items">{result.followUps.map((item, index) => <li key={index}>{item}</li>)}</ul>
                </div>
              ) : null}
              {canReview ? (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button variant="primary" busy={busy('requirement.accept')} onClick={() => run('requirement.accept', COMMANDS.requirementAccept, {})}>
                    {t('action.accept')}
                  </Button>
                  <Button busy={busy('requirement.rework')} onClick={() => run('requirement.rework', COMMANDS.requirementRework, {})}>
                    {t('action.rework')}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </section>

        {children.length > 0 || requirement.kind === 'goal' ? (
          <section className="mate-section">
            <h3>{t('drawer.children')}</h3>
            <div className="mate-panel" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {children.map((child) => (
                <button
                  key={child.id}
                  type="button"
                  className="mate-row"
                  onClick={() => onOpenRequirement(child.id)}
                  title={child.brief}
                >
                  <span className="mate-row-main">
                    <span className="mate-row-title">#{child.number} {child.title}</span>
                    <span className="mate-row-meta">{child.mateName} · {formatRelative(child.updatedAt, lang)}</span>
                  </span>
                  <Badge tone={child.status === 'failed' ? 'error' : child.status === 'awaiting_review' ? 'warn' : ''}>
                    {t(`status.${child.status}`)}
                  </Badge>
                </button>
              ))}
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="mate-input"
                  value={childTitle}
                  placeholder={t('action.addChild')}
                  onChange={(event) => setChildTitle(event.target.value)}
                />
                <Button
                  busy={busy('requirement.addChild')}
                  disabled={childTitle.trim().length === 0}
                  onClick={() => {
                    const title = childTitle.trim()
                    if (title.length === 0) return
                    setChildTitle('')
                    run('requirement.addChild', COMMANDS.requirementAddChild, { title })
                  }}
                >
                  {t('action.addChild')}
                </Button>
              </div>
            </div>
          </section>
        ) : null}

        {requirement.errors.length > 0 ? (
          <section className="mate-section">
            <h3>{t('drawer.errors')}</h3>
            <div className="mate-errors">
              {requirement.errors.slice(-6).map((error, index) => (
                <div key={index} className="mate-error-line">
                  [{error.phase}/{error.code}] {error.message}
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </aside>
    </div>
  )
}



