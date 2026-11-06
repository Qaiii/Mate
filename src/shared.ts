/** Wire vocabulary shared by the Host half and the browser half. */

export type AutonomyMode = 'confirm' | 'auto'
export type RequirementKind = 'requirement' | 'goal'
export type Priority = 'low' | 'normal' | 'high'

/** Where a requirement's dispatch project came from (for the card badge). */
export type ProjectSource = 'auto' | 'user' | 'user-new'

/** The user's final call when a manual project disagrees with the Mate's suggestion. */
export type ProjectResolution = 'user' | 'mate'

export type RequirementStatus =
  | 'draft'
  | 'analyzing'
  | 'clarifying'
  | 'proposed'
  | 'approved'
  | 'conflict'
  | 'running'
  | 'awaiting_review'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export type MateMemoryKind = 'role' | 'constraint' | 'preference' | 'glossary' | 'note'

/** One durable fact the Mate distilled from the user's instructions. */
export interface MateMemoryEntry {
  id: string
  kind: MateMemoryKind
  text: string
  createdAt: number
}

export interface MateView {
  id: string
  name: string
  description: string
  specialty: string
  model: ModelSelection
  dispatchModel: ModelSelection | null
  autonomy: AutonomyMode
  confidenceThreshold: number
  maxParallel: number
  allowSplit: boolean
  persona: string
  /** Long-term memory the Mate distilled from the user's own words. */
  memory?: MateMemoryEntry[]
  createdAt: number
  updatedAt: number
  archived: boolean
}

export interface ModelEffortOption {
  id: string
  name: string
  description?: string
}

export interface ModelEffortsView {
  efforts: ModelEffortOption[]
  defaultEffort?: string
}

export interface MateDistillView {
  entries: Array<{ kind: MateMemoryKind; text: string; existing: boolean }>
}

export interface SubTaskView {
  id: string
  title: string
  detail: string
  acceptance: string
}

export interface SplitItemView {
  title: string
  brief: string
  acceptance: string
}

export interface AnalysisView {
  provider?: string
  model?: string
  /** Card title proposed by the Mate; the user only types the request body. */
  title?: string
  /** Model the Mate picked for the implementing session, or null for default. */
  sessionModel?: ModelSelection | null
  /** Priority the Mate judged from the request itself. */
  priority?: Priority
  summary: string
  confidence: number
  needsClarification: boolean
  subTasks: SubTaskView[]
  risks: string[]
  questions: string[]
  splitSuggestion: SplitItemView[]
  suggestedProjectPath: string | null
  at: number
}

export interface PlanView {
  targetProjectPath: string | null
  dispatchMode: 'new' | 'reuse-idle'
  extraInstruction: string
  at: number
}

export interface DispatchView {
  sessionId: string
  requestedAt: number
  lastRunningAt: number | null
  reused: boolean
  pendingInput: string[]
}

export interface ResultView {
  provider?: string
  model?: string
  doneSummary: string
  acceptance: Array<{ item: string; met: boolean }>
  remaining: string[]
  followUps: string[]
  at: number
}

export interface DiscussionEntryView {
  role: 'user' | 'mate'
  text: string
  at: number
  model?: string
}

export interface RequirementErrorView {
  at: number
  phase: string
  code: string
  message: string
}

export interface RequirementView {
  id: string
  number: number
  title: string
  brief: string
  projectPath: string
  projectTitle: string
  priority: Priority
  mateId: string
  mateName: string
  mateModel: string
  parentId: string | null
  kind: RequirementKind
  status: RequirementStatus
  autonomy: AutonomyMode
  sessionOverrides: ModelSelection | null
  /** Where the dispatch project came from; absent on pre-feature rows (treated as 'auto'). */
  projectSource?: ProjectSource
  /** The user's conflict resolution; null until a manual-vs-suggested conflict is settled. */
  projectResolution?: ProjectResolution | null
  discussion: DiscussionEntryView[]
  analysis: AnalysisView | null
  plan: PlanView | null
  dispatch: DispatchView | null
  result: ResultView | null
  errors: RequirementErrorView[]
  createdAt: number
  updatedAt: number
  rev: number
}

export interface ProjectView {
  path: string
  title: string
  sessionCount: number
  running: number
  awaitingInput: number
  lastActiveAt: number
}

export interface LiveSessionView {
  sessionId: string
  title: string
  cwd: string
  running: boolean
  pendingInput: string[]
  updatedAt: number
  /** A session that has never produced a turn; shown nowhere on the board. */
  blank: boolean
  /** Subagent children belong to a parent session and are not board cards. */
  origin: 'subagent' | null
  /** Requirement this session was dispatched for, when Mate already tracks it. */
  linkedRequirementId: string | null
  /** The user asked this session not to appear as an untracked board card. */
  hidden: boolean
}

/** Client-visible plugin release, kept in step with package.json by hand. */
export const PLUGIN_VERSION = '0.1.0'

export interface SettingsView {
  defaultMateId: string | null
  pollMs: number
  reuseIdleSession: boolean
  version: string
  /** Host-half start time of the process serving this snapshot. */
  lastStartedAt: number | null
  /** Last manually selected project path, used to prefill the project-list mode. */
  lastProjectPath: string | null
  modelCatalog: Array<{ provider: string; name: string; models: Array<{ id: string; name: string }> }>
}

export interface Snapshot {
  rev: number
  mates: MateView[]
  requirements: RequirementView[]
  projects: ProjectView[]
  liveSessions: LiveSessionView[]
  settings: SettingsView
  serverTime: number
}

export interface StateRequest {
  rev?: number
}

/** One readable turn of an existing session, loaded for the preview drawer. */
export interface SessionTranscriptMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface SessionTranscriptView {
  sessionId: string
  title: string
  cwd: string
  running: boolean
  updatedAt: number
  messages: SessionTranscriptMessage[]
  /** Present when the transcript could not be read in this profile. */
  unavailable?: string
}

export interface StateResponse {
  unchanged: boolean
  rev: number
  snapshot?: Snapshot
}

export interface CommandRequest {
  command: string
  args?: Record<string, unknown>
  requestId?: string
}

export interface CommandResponse {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string; detail?: unknown }
}

/** Exact Fetch routes registered on the `connection` service. */
export const API = {
  ping: 'api/dsh-mate/ping',
  state: 'api/dsh-mate/state',
  command: 'api/dsh-mate/command',
} as const

export const COMMANDS = {
  requirementCreate: 'requirement.create',
  requirementUpdate: 'requirement.update',
  requirementAnalyze: 'requirement.analyze',
  requirementAnswer: 'requirement.answer',
  requirementConfirm: 'requirement.confirm',
  requirementRework: 'requirement.rework',
  requirementAccept: 'requirement.accept',
  requirementCancel: 'requirement.cancel',
  requirementRedispatch: 'requirement.redispatch',
  requirementSplit: 'requirement.split',
  requirementAddChild: 'requirement.addChild',
  requirementDelete: 'requirement.delete',
  requirementAdoptSession: 'requirement.adoptSession',
  requirementResolveProject: 'requirement.resolveProject',
  projectRegister: 'project.register',
  projectPickDirectory: 'project.pickDirectory',
  sessionHide: 'session.hide',
  sessionTranscript: 'session.transcript',
  mateCreate: 'mate.create',
  mateUpdate: 'mate.update',
  mateArchive: 'mate.archive',
  mateDelete: 'mate.delete',
  modelEfforts: 'model.efforts',
  mateDistill: 'mate.distill',
  mateRemember: 'mate.remember',
  mateForget: 'mate.forget',
  mateMemoryEdit: 'mate.memory.edit',
  settingsUpdate: 'settings.update',
} as const

export type CommandKey = (typeof COMMANDS)[keyof typeof COMMANDS]

export function isTerminal(status: RequirementStatus): boolean {
  return status === 'done' || status === 'cancelled'
}

export function statusLabel(status: RequirementStatus): string {
  switch (status) {
    case 'draft': return '草稿'
    case 'analyzing': return '分析中'
    case 'clarifying': return '澄清中'
    case 'proposed': return '待确认'
    case 'approved': return '已确认'
    case 'conflict': return '待确认项目'
    case 'running': return '进行中'
    case 'awaiting_review': return '待验收'
    case 'done': return '已完成'
    case 'failed': return '异常'
    case 'cancelled': return '已取消'
  }
}






