import type {
  AnalysisView,
  PlanView,
  ProjectResolution,
  ProjectSource,
  RequirementStatus,
} from './shared.js'

/** Normalize `projectSource` so pre-feature rows (undefined) behave as auto. */
export function projectSourceOf(source: ProjectSource | undefined): ProjectSource {
  return source === 'user' || source === 'user-new' ? source : 'auto'
}

/** Case-insensitive, separator- and trailing-slash-insensitive path equality. */
export function sameProjectPath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b)
}

function normalizeForCompare(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * The project a dispatch should actually target, in priority order:
 * an explicit plan target, then (for a manual selection) the user's project —
 * or the Mate's suggestion when the user adopted it — and finally the Mate's
 * suggestion for auto mode.
 */
export function resolveDispatchProject(req: {
  plan?: PlanView | null
  analysis?: AnalysisView | null
  projectSource?: ProjectSource
  projectPath?: string
  projectResolution?: ProjectResolution | null
}): string {
  if (req.plan?.targetProjectPath) return req.plan.targetProjectPath
  const source = projectSourceOf(req.projectSource)
  if (source !== 'auto') {
    if (req.projectResolution === 'mate' && req.analysis?.suggestedProjectPath) {
      return req.analysis.suggestedProjectPath
    }
    return req.projectPath ?? ''
  }
  return req.analysis?.suggestedProjectPath ?? req.projectPath ?? ''
}

export interface AnalysisOutcome {
  status: RequirementStatus
  projectResolution: ProjectResolution | null
  conflict: boolean
}

/**
 * Decide the post-analysis status and project resolution for one requirement.
 * A manual project that disagrees with the Mate's suggestion and has not been
 * settled yet lands in `conflict`, which the client surfaces as a confirmation.
 */
export function planAnalysisOutcome(input: {
  projectSource?: ProjectSource
  projectPath?: string
  projectResolution?: ProjectResolution | null
  autonomy: 'confirm' | 'auto'
  analysis: AnalysisView
}): AnalysisOutcome {
  const source = projectSourceOf(input.projectSource)
  const suggested = input.analysis.suggestedProjectPath
  const manualPath = source !== 'auto' ? (input.projectPath ?? '') : ''
  const conflict = manualPath.length > 0
    && suggested !== null
    && suggested.length > 0
    && !sameProjectPath(manualPath, suggested)
  const current = input.projectResolution ?? null

  if (source !== 'auto' && conflict && current === null) {
    return { status: 'conflict', projectResolution: null, conflict: true }
  }

  const projectResolution: ProjectResolution | null = source !== 'auto' ? (current ?? 'user') : null
  const status: RequirementStatus = input.autonomy === 'auto'
    ? (input.analysis.needsClarification ? 'clarifying' : 'approved')
    : 'proposed'
  return { status, projectResolution, conflict }
}
