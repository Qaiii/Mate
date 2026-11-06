import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type {
  AnalysisView,
  DiscussionEntryView,
  DispatchView,
  MateView,
  ModelSelection,
  PlanView,
  RequirementErrorView,
  RequirementView,
  ResultView,
  SplitItemView,
  SubTaskView,
} from './shared.js'

/** Cached project row; the workspace registry (or session cwd) is the real source. */
export interface ProjectRecord {
  path: string
  title: string
  lastSeenAt: number
  /** True when the user explicitly registered this directory; stays visible with no live session. */
  registered?: boolean
}

/** Plugin-wide counters and deployment tunables. */
export interface MateGlobalRecord {
  seq: number
  defaultMateId: string | null
  pollMs: number
  reuseIdleSession: boolean
  /** The last manually selected project path, prefill for the project-list mode. */
  lastProjectPath?: string | null
  /** Diagnostics: when the Host half last initialized. */
  lastStartedAt?: number
}

const ModelSelectionSchema: z.ZodType<ModelSelection> = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
})

const MateSchema: z.ZodType<MateView> = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  specialty: z.string(),
  model: ModelSelectionSchema,
  dispatchModel: ModelSelectionSchema.nullable(),
  autonomy: z.enum(['confirm', 'auto']),
  confidenceThreshold: z.number(),
  maxParallel: z.number(),
  allowSplit: z.boolean(),
  persona: z.string(),
  memory: z.array(z.object({
    id: z.string(),
    kind: z.enum(['role', 'constraint', 'preference', 'glossary', 'note']),
    text: z.string(),
    createdAt: z.number(),
  })).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archived: z.boolean(),
})

const SubTaskSchema: z.ZodType<SubTaskView> = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  acceptance: z.string(),
})

const SplitItemSchema: z.ZodType<SplitItemView> = z.object({
  title: z.string(),
  brief: z.string(),
  acceptance: z.string(),
})

const AnalysisSchema: z.ZodType<AnalysisView> = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  title: z.string().optional(),
  sessionModel: ModelSelectionSchema.nullable().optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  summary: z.string(),
  confidence: z.number(),
  needsClarification: z.boolean(),
  subTasks: z.array(SubTaskSchema),
  risks: z.array(z.string()),
  questions: z.array(z.string()),
  splitSuggestion: z.array(SplitItemSchema),
  suggestedProjectPath: z.string().nullable(),
  at: z.number(),
})

const PlanSchema: z.ZodType<PlanView> = z.object({
  targetProjectPath: z.string().nullable(),
  dispatchMode: z.enum(['new', 'reuse-idle']),
  extraInstruction: z.string(),
  at: z.number(),
})

const DispatchSchema: z.ZodType<DispatchView> = z.object({
  sessionId: z.string(),
  requestedAt: z.number(),
  lastRunningAt: z.number().nullable(),
  reused: z.boolean(),
  pendingInput: z.array(z.string()),
})

const ResultSchema: z.ZodType<ResultView> = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  doneSummary: z.string(),
  acceptance: z.array(z.object({ item: z.string(), met: z.boolean() })),
  remaining: z.array(z.string()),
  followUps: z.array(z.string()),
  at: z.number(),
})

const DiscussionSchema: z.ZodType<DiscussionEntryView> = z.object({
  role: z.enum(['user', 'mate']),
  text: z.string(),
  at: z.number(),
  model: z.string().optional(),
})

const RequirementErrorSchema: z.ZodType<RequirementErrorView> = z.object({
  at: z.number(),
  phase: z.string(),
  code: z.string(),
  message: z.string(),
})

const RequirementSchema: z.ZodType<RequirementView> = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  brief: z.string(),
  projectPath: z.string(),
  projectTitle: z.string(),
  priority: z.enum(['low', 'normal', 'high']),
  mateId: z.string(),
  mateName: z.string(),
  mateModel: z.string(),
  parentId: z.string().nullable(),
  kind: z.enum(['requirement', 'goal']),
  status: z.enum([
    'draft', 'analyzing', 'clarifying', 'proposed', 'approved',
    'conflict', 'running', 'awaiting_review', 'done', 'failed', 'cancelled',
  ]),
  autonomy: z.enum(['confirm', 'auto']),
  sessionOverrides: ModelSelectionSchema.nullable(),
  projectSource: z.enum(['auto', 'user', 'user-new']).optional(),
  projectResolution: z.enum(['user', 'mate']).nullable().optional(),
  discussion: z.array(DiscussionSchema),
  analysis: AnalysisSchema.nullable(),
  plan: PlanSchema.nullable(),
  dispatch: DispatchSchema.nullable(),
  result: ResultSchema.nullable(),
  errors: z.array(RequirementErrorSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
  rev: z.number(),
})

const ProjectSchema: z.ZodType<ProjectRecord> = z.object({
  path: z.string(),
  title: z.string(),
  lastSeenAt: z.number(),
  registered: z.boolean().optional(),
})

const GlobalSchema: z.ZodType<MateGlobalRecord> = z.object({
  seq: z.number(),
  defaultMateId: z.string().nullable(),
  pollMs: z.number(),
  reuseIdleSession: z.boolean(),
  lastProjectPath: z.string().nullable().optional(),
  lastStartedAt: z.number().optional(),
})

/** A session the user chose not to show as an untracked board card. */
export interface HiddenSessionRecord {
  sessionId: string
  hiddenAt: number
}

const HiddenSessionSchema: z.ZodType<HiddenSessionRecord> = z.object({
  sessionId: z.string(),
  hiddenAt: z.number(),
})

/** Storage domain declaration: one unit file under `$DSH_HOME/storages/mate.json`. */
export const mateDomain = defineDomain({
  name: 'mate',
  version: 1,
  global: { schema: GlobalSchema, initial: { seq: 0, defaultMateId: null, pollMs: 2500, reuseIdleSession: false, lastProjectPath: null } },
  tables: {
    mates: domainTable<string, MateView>(MateSchema),
    requirements: domainTable<string, RequirementView>(RequirementSchema),
    projects: domainTable<string, ProjectRecord>(ProjectSchema),
    hidden_sessions: domainTable<string, HiddenSessionRecord>(HiddenSessionSchema),
  },
})

export type MateDomain = typeof mateDomain



