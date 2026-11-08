import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { DEFAULT_CONTEXT_COMPRESSION } from './compression.js'
import type {
  AnalysisView,
  ContextCompressionConfig,
  DiscussionEntryView,
  DispatchView,
  MateView,
  ModelSelection,
  PlanView,
  QueueEntryView,
  RequirementErrorView,
  RequirementView,
  ResultView,
  ScheduleConfig,
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
  /** Model availability windows + holiday dates; absent on pre-feature records. */
  schedule?: ScheduleConfig
  /** Pre-dispatch context compression policy; absent on pre-feature records. */
  contextCompression?: ContextCompressionConfig
  /** Browser IANA zone last reported by the DSH web client. */
  clientTimeZone?: string | null
}

const ModelSelectionSchema: z.ZodType<ModelSelection> = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
})

const DisabledWindowSchema = z.object({
  kind: z.union([
    z.enum(['weekday', 'weekend', 'holiday']),
    z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])),
  ]),
  start: z.string(),
  end: z.string(),
})

const ScheduleSchema: z.ZodType<ScheduleConfig> = z.object({
  models: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    disabledWindows: z.array(DisabledWindowSchema),
  })),
  holidays: z.array(z.string()),
  // Defaults keep a pre-feature `mate.json` readable: manual overrides empty,
  // built-in China holiday data on.
  workdays: z.array(z.string()).default([]),
  useBuiltinHolidays: z.boolean().default(true),
  timezone: z.string().nullable(),
})

/** Optional so a pre-feature `mate.json` (without the section) still validates. */
const ContextCompressionSchema: z.ZodType<ContextCompressionConfig> = z.object({
  enabled: z.boolean(),
  threshold: z.number(),
})

const QueueEntrySchema: z.ZodType<QueueEntryView> = z.object({
  phase: z.enum(['analyze', 'dispatch']),
  reason: z.string(),
  model: ModelSelectionSchema.nullable(),
  window: z.string().optional(),
  enqueuedAt: z.number(),
  nextWakeAt: z.number().nullable(),
  timezone: z.string(),
  attempts: z.number(),
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
  dispatchModels: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().optional(),
  })).optional(),
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
  reuseSessionId: z.string().nullable().optional(),
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
  dispatchMode: z.enum(['auto', 'new', 'reuse-idle']),
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
    'draft', 'analyzing', 'clarifying', 'proposed', 'approved', 'queued',
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
  queue: QueueEntrySchema.nullable().optional(),
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
  schedule: ScheduleSchema.optional(),
  contextCompression: ContextCompressionSchema.optional(),
  clientTimeZone: z.string().nullable().optional(),
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
  global: {
    schema: GlobalSchema,
    initial: {
      seq: 0,
      defaultMateId: null,
      pollMs: 2500,
      reuseIdleSession: false,
      lastProjectPath: null,
      schedule: { models: [], holidays: [], workdays: [], useBuiltinHolidays: true, timezone: null },
      contextCompression: { ...DEFAULT_CONTEXT_COMPRESSION },
      clientTimeZone: null,
    },
  },
  tables: {
    mates: domainTable<string, MateView>(MateSchema),
    requirements: domainTable<string, RequirementView>(RequirementSchema),
    projects: domainTable<string, ProjectRecord>(ProjectSchema),
    hidden_sessions: domainTable<string, HiddenSessionRecord>(HiddenSessionSchema),
  },
})

export type MateDomain = typeof mateDomain
