import { randomUUID } from 'node:crypto'
import type { MateView, ModelSelection, RequirementView } from './shared.js'

/** Minimal shape of `ctx.sessionController` that dispatch depends on. */
export interface SessionSummaryLike {
  sessionId: string
  cwd?: string
  running: boolean
  updatedAt: number
  blank?: boolean
  origin?: 'subagent'
  projections?: { values?: Record<string, unknown> }
}

export interface SessionControllerLike {
  create(request: { cwd?: string; workspaceId?: string }, signal?: AbortSignal): Promise<{ sessionId: string }>
  selectModel(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }, signal?: AbortSignal): Promise<unknown>
  rename(request: { sessionId: string; title: string }, signal?: AbortSignal): Promise<unknown>
  prompt(request: {
    requestId: string
    sessionId: string
    mode: 'queue' | 'steer'
    content: Array<{ type: 'text'; text: string }>
  }, signal?: AbortSignal): Promise<{ accepted: boolean }>
  cancel(request: { sessionId: string }, signal?: AbortSignal): Promise<unknown>
  list(request: Record<string, never>, signal?: AbortSignal): Promise<{ items: SessionSummaryLike[] }>
  state(request: { sessionId: string }, signal?: AbortSignal): Promise<{ running: boolean; pendingInput?: string[] }>
}

/** Minimal shape of the `workspaceController` service that dispatch needs. */
export interface WorkspaceViewLike {
  workspaceId: string
  path: string
  title: string
  sessionIds: readonly string[]
  createdAt: string
  updatedAt: string
}

export interface WorkspaceControllerLike {
  /** Idempotently resolve or create a Workspace over an existing directory. */
  create(request: { path: string }): Promise<{ workspace: WorkspaceViewLike; created: boolean }>
}

/** Options that tune how a dispatched session is created. */
export interface DispatchOptions {
  /**
   * When `true`, create an unattached (headless) session even when a Workspace
   * is available. Defaults to `false`, which attaches the session to the
   * project's Workspace so it appears in the sidebar.
   */
  headless?: boolean
}

/** Upper bound on Workspace-attached (interactive) creation before falling back. */
const WORKSPACE_CREATE_TIMEOUT_MS = 15_000

/** Warnings a dispatch may accumulate without failing the dispatch itself. */
export type DispatchWarning = { code: string; message: string }

export interface DispatchOutcome {
  sessionId: string
  reused: boolean
  warnings: DispatchWarning[]
}

/**
 * Build the model-facing briefing for one dispatched session. It is written to
 * be self-contained: a fresh agent receives it with no other context.
 */
export function buildBrief(requirement: RequirementView, mate: MateView, projectPath: string = requirement.projectPath): string {
  const tasks = (requirement.analysis?.subTasks ?? [])
    .map((task, index) => {
      const lines = [`${index + 1}. ${task.title}`]
      if (task.detail) lines.push(`   How: ${task.detail}`)
      if (task.acceptance) lines.push(`   Acceptance: ${task.acceptance}`)
      return lines.join('\n')
    })
    .join('\n')
  const questions = requirement.analysis?.questions ?? []
  const extra = requirement.plan?.extraInstruction?.trim()
  const projectTitle = projectPath === requirement.projectPath ? requirement.projectTitle : baseName(projectPath)

  return [
    `You are implementing one requirement on behalf of the project manager "${mate.name}".`,
    '',
    `# Requirement`,
    `Title: ${requirement.title}`,
    `Project: ${projectTitle} (${projectPath})`,
    '',
    requirement.brief.trim(),
    '',
    tasks ? `# Work items\n${tasks}` : '# Work items\n(no decomposition was recorded; decide the steps yourself)',
    questions.length > 0 ? `# Open questions from planning\n${questions.map((q) => `- ${q}`).join('\n')}` : '',
    extra ? `# Extra instruction\n${extra}` : '',
    '# Execution rules',
    '- Work in this session\'s workspace. Read the repository before changing anything.',
    '- Do not ask the user for confirmation; make a reasonable decision and state the assumption.',
    '- Keep changes scoped to this requirement. Do not commit unless the user asks.',
    '- When finished, write a final message with: what you changed, how you verified it, and what remains unfinished.',
  ].filter((line) => line !== '').join('\n')
}

/** Create, configure, and brief one session for a requirement. */
export class Dispatcher {
  constructor(
    private readonly controller: SessionControllerLike,
    private readonly workspaceController: () => WorkspaceControllerLike | null,
    private readonly log: (message: string) => void,
    private readonly signal: AbortSignal = new AbortController().signal,
  ) {}

  /** Find an idle session this plugin created earlier in the same project. */
  async findReusable(projectPath: string): Promise<string | null> {
    try {
      const { items } = await this.controller.list({}, this.signal)
      const candidate = items.find((item) =>
        item.cwd === projectPath && !item.running && titleOf(item).startsWith('Mate · '))
      return candidate?.sessionId ?? null
    } catch {
      return null
    }
  }

  async dispatch(
    requirement: RequirementView,
    mate: MateView | undefined,
    projectPath: string,
    model: ModelSelection | null,
    options: DispatchOptions = {},
  ): Promise<DispatchOutcome> {
    const warnings: DispatchWarning[] = []
    const overrides: ModelSelection | null = requirement.sessionOverrides ?? model ?? null
    const mode = requirement.plan?.dispatchMode ?? 'new'

    let sessionId: string | null = mode === 'reuse-idle' ? await this.findReusable(projectPath) : null
    const reused = sessionId !== null
    if (sessionId === null) {
      sessionId = await this.createSession(projectPath, options, warnings)
    }

    if (overrides !== null) {
      try {
        await this.controller.selectModel({
          sessionId,
          provider: overrides.provider,
          model: overrides.model,
          ...(overrides.reasoningEffort === undefined ? {} : { reasoningEffort: overrides.reasoningEffort }),
        }, this.signal)
      } catch (error) {
        warnings.push({ code: 'model-override-failed', message: String(error) })
      }
    }

    try {
      await this.controller.rename({ sessionId, title: `Mate · ${requirement.title}`.slice(0, 120) }, this.signal)
    } catch (error) {
      warnings.push({ code: 'rename-failed', message: String(error) })
    }

    await this.controller.prompt({
      requestId: `mate-dispatch-${randomUUID()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: buildBrief(requirement, mate ?? placeholderMate(), projectPath) }],
    }, this.signal)

    return { sessionId, reused, warnings }
  }

  /**
   * Create the dispatched session. The default is interactive (Workspace-attached)
   * so the conversation appears in the sidebar under its project. When that path
   * is unavailable — no workspace service, an invalid directory, or a timeout —
   * we fall back to a headless session and record a warning so callers can tell
   * the three outcomes apart in the log.
   */
  private async createSession(
    projectPath: string,
    options: DispatchOptions,
    warnings: DispatchWarning[],
  ): Promise<string> {
    if (options.headless === true) {
      this.log('[dsh-mate] headless session requested; skipping Workspace attachment')
      return this.createHeadless(projectPath)
    }
    try {
      const sessionId = await this.createInteractive(projectPath)
      this.log(`[dsh-mate] interactive session created: ${sessionId}`)
      return sessionId
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The Host mints the session id before attaching it to the Workspace; when
      // only the attach step fails it reports that id, so reuse it instead of
      // creating a duplicate headless session.
      const orphaned = extractSessionId(message)
      if (orphaned !== null) {
        warnings.push({ code: 'workspace-attach-failed', message })
        this.log(`[dsh-mate] interactive session created but Workspace attach failed (${message}); reusing ${orphaned}`)
        return orphaned
      }
      warnings.push({ code: 'workspace-attach-fallback', message })
      this.log(`[dsh-mate] interactive session creation failed (${message}); falling back to headless`)
      return this.createHeadless(projectPath)
    }
  }

  /** Resolve the project's Workspace and create a session attached to it. */
  private async createInteractive(projectPath: string): Promise<string> {
    const workspaces = this.workspaceController()
    if (workspaces === null) throw new Error('workspaceController is unavailable')
    const resolved = await withTimeout(
      workspaces.create({ path: projectPath }),
      WORKSPACE_CREATE_TIMEOUT_MS,
      `workspace resolution timed out after ${WORKSPACE_CREATE_TIMEOUT_MS}ms`,
    )
    const created = await this.controller.create({ workspaceId: resolved.workspace.workspaceId }, this.signal)
    return created.sessionId
  }

  /** Create an unattached session from a bare working directory. */
  private async createHeadless(projectPath: string): Promise<string> {
    const created = await this.controller.create({ cwd: projectPath }, this.signal)
    return created.sessionId
  }

  async cancel(sessionId: string): Promise<void> {
    try {
      await this.controller.cancel({ sessionId }, this.signal)
    } catch {
      // Cancelling an already-finished session is not an error for the board.
    }
  }
}

function placeholderMate(): MateView {
  return {
    id: 'mate_unknown',
    name: 'Mate',
    description: '',
    specialty: '',
    model: { provider: 'unknown', model: 'unknown' },
    dispatchModel: null,
    autonomy: 'confirm',
    confidenceThreshold: 0.75,
    maxParallel: 2,
    allowSplit: true,
    persona: '',
    createdAt: 0,
    updatedAt: 0,
    archived: false,
  }
}

function titleOf(summary: SessionSummaryLike): string {
  const values = summary.projections?.values
  const title = values?.title
  if (typeof title === 'string') return title
  if (title !== null && typeof title === 'object') {
    const text = (title as { text?: unknown }).text
    if (typeof text === 'string') return text
  }
  return ''
}

function baseName(path: string): string {
  if (!path) return ''
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').pop() ?? path
}

/** Reject a promise after a bounded wait, preserving the original rejection. */
function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

/**
 * Best-effort recovery of a minted session id from a Host failure message of the
 * form `session "…" was created but could not attach…`. Returns null when the
 * message carries no session identity.
 */
function extractSessionId(message: string): string | null {
  const match = /session "([^"]+)"/.exec(message)
  return match === null ? null : match[1]
}
