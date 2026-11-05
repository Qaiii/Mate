import { randomUUID } from 'node:crypto'
import type { MateView, ModelSelection, RequirementView } from './shared.js'

/** Minimal shape of `ctx.sessionController` that dispatch depends on. */
export interface SessionSummaryLike {
  sessionId: string
  cwd?: string
  running: boolean
  updatedAt: number
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
export function buildBrief(requirement: RequirementView, mate: MateView): string {
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

  return [
    `You are implementing one requirement on behalf of the project manager "${mate.name}".`,
    '',
    `# Requirement`,
    `Title: ${requirement.title}`,
    `Project: ${requirement.projectTitle} (${requirement.projectPath})`,
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
  ): Promise<DispatchOutcome> {
    const warnings: DispatchWarning[] = []
    const overrides: ModelSelection | null = requirement.sessionOverrides
      ?? mate?.dispatchModel
      ?? null
    const mode = requirement.plan?.dispatchMode ?? 'new'

    let sessionId: string | null = mode === 'reuse-idle' ? await this.findReusable(projectPath) : null
    const reused = sessionId !== null
    if (sessionId === null) {
      const created = await this.controller.create({ cwd: projectPath }, this.signal)
      sessionId = created.sessionId
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
      content: [{ type: 'text', text: buildBrief(requirement, mate ?? placeholderMate()) }],
    }, this.signal)

    return { sessionId, reused, warnings }
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
