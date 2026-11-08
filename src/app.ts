import type { AnalyzeSessionCandidate, MateAnalyzer, ProjectOption } from './analyzer.js'
import { Dispatcher, type SessionControllerLike, type SessionSummaryLike, type WorkspaceControllerLike } from './dispatch.js'
import { randomUUID } from 'node:crypto'
import { emptyScheduleConfig, newMateId, newRequirementId, shortId, type MateStore } from './store.js'
import { planAnalysisOutcome, projectSourceOf, resolveDispatchProject } from './planning.js'
import { isDirectory, normalizeProjectPath } from './projects.js'
import type { MateGlobalRecord, ProjectRecord } from './domain.js'
import { MateQueue } from './scheduler.js'
import {
  describeWindow,
  evaluateModelRoute,
  hostTimeZone,
  isValidTimeZone,
  resolveEffectiveTimeZone,
  validateScheduleConfig,
} from './schedule.js'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  validateContextCompressionConfig,
  type CompactionOutcome,
  type ContextCompactor,
  type ContextMeasurement,
  type ContextUsageReader,
  type SessionTokenEstimator,
} from './compression.js'
import {
  COMMANDS,
  isTerminal,
  PLUGIN_VERSION,
  type AnalysisView,
  type AutonomyMode,
  type CommandRequest,
  type DispatchModelRule,
  type MateView,
  type ModelSelection,
  type PlanView,
  type ProjectResolution,
  type ProjectSource,
  type QueuePhase,
  type RequirementView,
  type MateDistillView,
  type ModelEffortsView,
  type MateMemoryEntry,
  type SessionTranscriptMessage,
  type SessionTranscriptView,
  type SettingsView,
  type Snapshot,
  type StateRequest,
  type TimeZoneView,
} from './shared.js'

export class CommandError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: unknown) {
    super(message)
    this.name = 'CommandError'
  }
}

/** Timer seam for the wake queue; tests replace it with fake timers. */
export interface AppTimers {
  set: (fire: () => void, delayMs: number) => unknown
  clear: (handle: unknown) => void
}

export interface AppDeps {
  store: MateStore
  controller: SessionControllerLike
  analyzer: MateAnalyzer | null
  reasoning: ((provider: string, model: string) => Promise<ModelEffortsView | null>) | null
  transcript: ((sessionId: string) => Promise<string>) | null
  workspaceController: WorkspaceControllerLike | null
  log: (message: string) => void
  /**
   * Route capacity from `ctx.llm.resolveModelInfo().context.contextWindow`.
   * Optional: when absent, a measurement without a provider window cannot be
   * judged and the compression branch is skipped.
   */
  contextWindow?: ((provider: string, model: string) => Promise<number | null>) | null
  /** Injected clock; defaults to `Date.now`. Every gate and queue decision uses it. */
  now?: () => number
  /** Injected queue timer functions; default to the global timers. */
  timers?: AppTimers
}

/** One model-route judgement plus the queue fields it produces. */
interface RouteGate {
  available: boolean
  /** One-line summary of the blocking window, when blocked. */
  window: string | undefined
  /** Earliest instant the route is available again, when known. */
  nextWakeAt: number | null
  /** Zone the decision was made in. */
  timezone: string
}

const DEFAULT_TARGETS = { analysis: 4000, summary: 2500 }

/** Orchestrates the requirement lifecycle, model calls, and session dispatch. */
export class MateApp {
  private language = 'zh'
  private messages: ((sessionId: string) => Promise<SessionTranscriptMessage[]>) | null = null
  /** Provider-backed occupancy reader (`ctx.tokenMeter`), when the Host resolved it. */
  private contextMeter: ContextUsageReader | null = null
  /** Durable-log estimator, used when no live session body is measurable. */
  private contextEstimator: SessionTokenEstimator | null = null
  /** Compaction service adapter (`ctx.compaction.compactNow`), when available. */
  private contextCompactor: ContextCompactor | null = null
  private readonly inflight = new Set<string>()
  private readonly background = new Set<Promise<void>>()
  private readonly requestCache = new Map<string, unknown>()
  private queueChain: Promise<unknown> = Promise.resolve()
  private readonly dispatcher: Dispatcher
  private workspaceController: WorkspaceControllerLike | null
  private readonly clock: () => number
  /** Wake timer for requirements waiting on a model availability window. */
  readonly queue: MateQueue

  constructor(private readonly deps: AppDeps) {
    this.clock = deps.now ?? (() => Date.now())
    this.workspaceController = deps.workspaceController
    this.dispatcher = new Dispatcher(
      deps.controller,
      () => this.workspaceController,
      deps.log,
      this.lifetime.signal,
      {
        config: () => this.deps.store.contextCompression(),
        measure: (sessionId, model) => this.measureContext(sessionId, model),
        compact: (sessionId) => this.compactContext(sessionId),
      },
    )
    this.queue = new MateQueue({
      now: () => this.clock(),
      list: () => this.deps.store.queuedRequirements(),
      process: (requirement) => this.processQueued(requirement),
      log: deps.log,
      ...(deps.timers === undefined
        ? {}
        : { setTimer: deps.timers.set, clearTimer: deps.timers.clear }),
    })
  }

  /** Wire the optional Workspace controller once the Host has resolved it. */
  setWorkspaceController(controller: WorkspaceControllerLike | null): void {
    this.workspaceController = controller
  }

  /** One signal for every controller call, so disposal can abort in-flight work. */
  private readonly lifetime = new AbortController()

  /** Abort outstanding controller calls and stop the wake timer on Host unload. */
  dispose(): void {
    this.lifetime.abort()
    this.queue.dispose()
  }

  setTranscriptReader(reader: ((sessionId: string) => Promise<string>) | null): void {
    this.deps.transcript = reader
  }

  setMessageReader(reader: ((sessionId: string) => Promise<SessionTranscriptMessage[]>) | null): void {
    this.messages = reader
  }

  /** Wire the optional `ctx.tokenMeter` occupancy reader. */
  setContextMeter(reader: ContextUsageReader | null): void {
    this.contextMeter = reader
  }

  /**
   * Wire the optional durable-log estimator used when a reused session has no
   * live body to meter (`sessionQuery.readSession` + the char heuristic).
   */
  setContextEstimator(estimator: SessionTokenEstimator | null): void {
    this.contextEstimator = estimator
  }

  /** Wire the optional `ctx.compaction` service adapter. */
  setContextCompactor(compactor: ContextCompactor | null): void {
    this.contextCompactor = compactor
  }

  /**
   * Record this Host process's start time. Useful in the settings dialog to
   * tell "the panel is polling a stale host" from "the plugin never loaded".
   */
  async markStarted(): Promise<void> {
    await this.deps.store.updateSettings({ lastStartedAt: Date.now() })
  }

  /**
   * Record the browser zone the DSH web client reports (used when no manual
   * override is configured) and build the snapshot. A state poll is also the
   * only place the client zone can reach the Host, so it is persisted here.
   */
  async snapshot(request?: StateRequest): Promise<{ unchanged: boolean; rev: number; snapshot?: Snapshot }> {
    const reportedZone = typeof request?.timeZone === 'string' ? request.timeZone : undefined
    if (reportedZone !== undefined && isValidTimeZone(reportedZone)) {
      const settings = this.deps.store.settings()
      if (settings.clientTimeZone !== reportedZone) {
        await this.deps.store.updateSettings({ clientTimeZone: reportedZone })
      }
    }
    const rev = typeof request?.rev === 'number' ? request.rev : undefined
    const current = this.deps.store.revision
    if (typeof rev === 'number' && rev === current) {
      return { unchanged: true, rev: current }
    }
    const snapshot = await this.deps.store.buildSnapshot({
      listLive: () => this.listLive(),
      modelCatalog: () => this.cachedCatalog,
      timezone: () => this.effectiveTimeZone(),
    })
    return { unchanged: false, rev: snapshot.rev, snapshot }
  }

  /** Serialized, idempotent command entry point. */
  async command(request: CommandRequest): Promise<unknown> {
    const requestId = typeof request.requestId === 'string' && request.requestId.length > 0 ? request.requestId : null
    if (requestId !== null && this.requestCache.has(requestId)) {
      return this.requestCache.get(requestId)
    }
    const run = this.queueChain.then(async () => {
      const value = await this.execute(request)
      if (requestId !== null) {
        this.requestCache.set(requestId, value)
        if (this.requestCache.size > 200) {
          const first = this.requestCache.keys().next()
          if (!first.done) this.requestCache.delete(first.value)
        }
      }
      return value
    })
    this.queueChain = run.catch(() => undefined)
    return run
  }

  private async execute(request: CommandRequest): Promise<unknown> {
    const args = (request.args ?? {}) as Record<string, unknown>
    if (typeof args.language === 'string' && args.language.length > 0) {
      this.language = args.language
    }
    switch (request.command) {
      case COMMANDS.requirementCreate: return this.createRequirement(args)
      case COMMANDS.requirementUpdate: return this.updateRequirement(args)
      case COMMANDS.requirementAnalyze: return this.analyzeRequirement(args)
      case COMMANDS.requirementAnswer: return this.answerRequirement(args)
      case COMMANDS.requirementConfirm: return this.confirmRequirement(args)
      case COMMANDS.requirementRework: return this.reworkRequirement(args)
      case COMMANDS.requirementAccept: return this.acceptRequirement(args)
      case COMMANDS.requirementCancel: return this.cancelRequirement(args)
      case COMMANDS.requirementRedispatch: return this.redispatchRequirement(args)
      case COMMANDS.requirementSplit: return this.splitRequirement(args)
      case COMMANDS.requirementAddChild: return this.addChild(args)
      case COMMANDS.requirementDelete: return this.deleteRequirement(args)
      case COMMANDS.requirementAdoptSession: return this.adoptSession(args)
      case COMMANDS.requirementResolveProject: return this.resolveProject(args)
      case COMMANDS.projectRegister: return this.registerProject(args)
      case COMMANDS.projectPickDirectory: return this.pickDirectory()
      case COMMANDS.projectCreate: return this.createProject(args)
      case COMMANDS.projectRemove: return this.removeProject(args)
      case COMMANDS.sessionHide: return this.hideSession(args)
      case COMMANDS.sessionTranscript: return this.sessionTranscript(args)
      case COMMANDS.mateCreate: return this.createMate(args)
      case COMMANDS.mateUpdate: return this.updateMate(args)
      case COMMANDS.mateArchive: return this.archiveMate(args)
      case COMMANDS.mateDelete: return this.deleteMate(args)
      case COMMANDS.modelEfforts: return this.modelEfforts(args)
      case COMMANDS.mateDistill: return this.distillMate(args)
      case COMMANDS.mateRemember: return this.rememberMemory(args)
      case COMMANDS.mateForget: return this.forgetMemory(args)
      case COMMANDS.mateMemoryEdit: return this.editMemory(args)
      case COMMANDS.settingsUpdate: return this.updateSettings(args)
      default: throw new CommandError('unknown-command', `unknown command: ${request.command}`)
    }
  }

  // ---------------------------------------------------------------- mates

  private requireMate(id: unknown): MateView {
    if (typeof id !== 'string') throw new CommandError('mate-required', 'a Mate is required')
    const mate = this.deps.store.getMate(id)
    if (mate === undefined) throw new CommandError('mate-not-found', `Mate not found: ${id}`)
    return mate
  }

  private async createMate(args: Record<string, unknown>): Promise<MateView> {
    const name = requiredString(args.name, 'mate-name-required', 'Mate name is required').slice(0, 60)
    const model = parseModel(args.model) ?? parseModel(args.dispatchModel)
    if (model === null) throw new CommandError('model-required', 'provider and model are required')
    const now = Date.now()
    const mate: MateView = {
      id: newMateId(),
      name,
      description: optionalString(args.description),
      specialty: optionalString(args.specialty),
      model,
      dispatchModel: parseModel(args.dispatchModel),
      autonomy: parseAutonomy(args.autonomy) ?? 'confirm',
      confidenceThreshold: clampNumber(args.confidenceThreshold, 0.5, 0.95, 0.75),
      maxParallel: Math.round(clampNumber(args.maxParallel, 1, 8, 2)),
      allowSplit: args.allowSplit !== false,
      persona: optionalString(args.persona).slice(0, 2000),
      ...(parseDispatchModels(args.dispatchModels) === undefined ? {} : { dispatchModels: parseDispatchModels(args.dispatchModels) }),
      createdAt: now,
      updatedAt: now,
      archived: false,
    }
    await this.deps.store.putMate(mate)
    const settings = this.deps.store.settings()
    if (settings.defaultMateId === null) {
      await this.deps.store.updateSettings({ defaultMateId: mate.id })
    }
    return mate
  }

  private async updateMate(args: Record<string, unknown>): Promise<MateView> {
    const mate = this.requireMate(args.id)
    const next: MateView = {
      ...mate,
      name: args.name === undefined ? mate.name : requiredString(args.name, 'mate-name-required', 'Mate name is required').slice(0, 60),
      description: args.description === undefined ? mate.description : optionalString(args.description),
      specialty: args.specialty === undefined ? mate.specialty : optionalString(args.specialty),
      model: parseModel(args.model) ?? mate.model,
      dispatchModel: args.dispatchModel === undefined ? mate.dispatchModel : parseModel(args.dispatchModel),
      autonomy: parseAutonomy(args.autonomy) ?? mate.autonomy,
      confidenceThreshold: args.confidenceThreshold === undefined
        ? mate.confidenceThreshold
        : clampNumber(args.confidenceThreshold, 0.5, 0.95, mate.confidenceThreshold),
      maxParallel: args.maxParallel === undefined
        ? mate.maxParallel
        : Math.round(clampNumber(args.maxParallel, 1, 8, mate.maxParallel)),
      allowSplit: args.allowSplit === undefined ? mate.allowSplit : args.allowSplit !== false,
      persona: args.persona === undefined ? mate.persona : optionalString(args.persona).slice(0, 2000),
      ...(args.dispatchModels === undefined ? {} : { dispatchModels: parseDispatchModels(args.dispatchModels) }),
      updatedAt: Date.now(),
    }
    return this.deps.store.putMate(next)
  }

  private async archiveMate(args: Record<string, unknown>): Promise<MateView> {
    const mate = this.requireMate(args.id)
    const next = { ...mate, archived: args.archived !== false, updatedAt: Date.now() }
    return this.deps.store.putMate(next)
  }

  private async deleteMate(args: Record<string, unknown>): Promise<{ deleted: true }> {
    const mate = this.requireMate(args.id)
    const active = this.deps.store.listRequirements()
      .filter((requirement) => requirement.mateId === mate.id && !isTerminal(requirement.status)
        && requirement.status !== 'failed')
    if (active.length > 0 && args.force !== true) {
      throw new CommandError('mate-in-use', `${active.length} active requirement(s) still use this Mate`, { count: active.length })
    }
    await this.deps.store.removeMate(mate.id)
    const settings = this.deps.store.settings()
    if (settings.defaultMateId === mate.id) {
      const fallback = this.deps.store.listMates().find((candidate) => !candidate.archived && candidate.id !== mate.id)
      await this.deps.store.updateSettings({ defaultMateId: fallback?.id ?? null })
    }
    return { deleted: true }
  }

  /** Adapter-owned reasoning levels for one model route. */
  private async modelEfforts(args: Record<string, unknown>): Promise<ModelEffortsView> {
    const provider = requiredString(args.provider, 'provider-required', 'A provider is required')
    const model = requiredString(args.model, 'model-required', 'A model is required')
    if (this.deps.reasoning === null) return { efforts: [] }
    return (await this.deps.reasoning(provider, model)) ?? { efforts: [] }
  }
  /** Let the Mate read the instruction and show what it would remember. */
  private async distillMate(args: Record<string, unknown>): Promise<MateDistillView> {
    const mate = this.requireMate(args.id)
    const text = requiredString(args.text, 'text-required', 'Tell the Mate what it should remember')
    if (this.deps.analyzer === null) {
      throw new CommandError('analyzer-unavailable', 'ctx.llm is unavailable in this profile')
    }
    const output = await this.deps.analyzer.distillMemory({
      mate,
      text,
      language: this.language,
      maxTokens: 1200,
    })
    const known = new Set((mate.memory ?? []).map((entry) => entry.text.trim().toLowerCase()))
    return { entries: output.entries.map((entry) => ({ ...entry, existing: known.has(entry.text.trim().toLowerCase()) })) }
  }

  /** Persist the entries the user approved after reading them. */
  private async rememberMemory(args: Record<string, unknown>): Promise<MateView> {
    const mate = this.requireMate(args.id)
    const raw = Array.isArray(args.entries) ? args.entries : []
    const kinds: Array<MateMemoryEntry['kind']> = ['role', 'constraint', 'preference', 'glossary', 'note']
    const entries = raw.flatMap((item) => {
      if (item === null || typeof item !== 'object') return []
      const record = item as Record<string, unknown>
      const kind = kinds.find((candidate) => candidate === record.kind)
      const text = typeof record.text === 'string' ? record.text.trim() : ''
      if (kind === undefined || text.length === 0) return []
      return [{ kind, text: text.slice(0, 500) }]
    })
    const memory = mergeMemory(mate.memory ?? [], entries)
    return this.deps.store.putMate({ ...mate, memory, updatedAt: Date.now() })
  }

  /** Rewrite one memory entry the Mate already holds. */
  private async editMemory(args: Record<string, unknown>): Promise<MateView> {
    const mate = this.requireMate(args.id)
    const entryId = requiredString(args.entryId, 'entry-required', 'A memory entry is required')
    const text = requiredString(args.text, 'text-required', 'A memory entry needs text').slice(0, 500)
    const kinds: Array<MateMemoryEntry['kind']> = ['role', 'constraint', 'preference', 'glossary', 'note']
    const kind = kinds.find((candidate) => candidate === args.kind)
    const memory = (mate.memory ?? []).map((entry) => entry.id === entryId
      ? { ...entry, text, ...(kind === undefined ? {} : { kind }) }
      : entry)
    return this.deps.store.putMate({ ...mate, memory, updatedAt: Date.now() })
  }
  private async forgetMemory(args: Record<string, unknown>): Promise<MateView> {
    const mate = this.requireMate(args.id)
    const entryId = requiredString(args.entryId, 'entry-required', 'A memory entry is required')
    const memory = (mate.memory ?? []).filter((entry) => entry.id !== entryId)
    return this.deps.store.putMate({ ...mate, memory, updatedAt: Date.now() })
  }
  // --------------------------------------------------------- requirements

  private async createRequirement(args: Record<string, unknown>): Promise<RequirementView> {
    // One input is enough: the body is the requirement, the Mate names the card.
    const brief = requiredString(args.brief, 'brief-required', 'A requirement is required')
    const title = optionalString(args.title).slice(0, 200) || firstLineTitle(brief)
    const settings = this.deps.store.settings()
    const mateId = typeof args.mateId === 'string' && args.mateId.length > 0
      ? args.mateId
      : settings.defaultMateId ?? this.deps.store.listMates().find((candidate) => !candidate.archived)?.id
    const mate = this.requireMate(mateId)

    const projectSource = parseProjectSource(args.projectSource)
    let projectPath = ''
    let projectTitle = ''
    if (projectSource !== 'auto') {
      const normalized = normalizeProjectPath(optionalString(args.projectPath))
      if (!normalized.ok) throw new CommandError(normalized.error!.code, normalized.error!.message)
      if (!isDirectory(normalized.path)) {
        throw new CommandError('project-not-found', `Project directory does not exist: ${normalized.path}`)
      }
      projectPath = normalized.path
      projectTitle = optionalString(args.projectTitle) || baseName(projectPath)
      await this.deps.store.registerProject(projectPath, projectTitle)
      await this.deps.store.updateSettings({ lastProjectPath: projectPath })
    }

    const now = Date.now()
    const requirement: RequirementView = {
      id: newRequirementId(),
      number: await this.deps.store.nextNumber(),
      title,
      brief: brief.slice(0, 20000),
      projectPath,
      projectTitle,
      priority: 'normal',
      mateId: mate.id,
      mateName: mate.name,
      mateModel: `${mate.model.provider}/${mate.model.model}`,
      parentId: typeof args.parentId === 'string' && args.parentId.length > 0 ? args.parentId : null,
      kind: 'requirement',
      status: 'draft',
      autonomy: parseAutonomy(args.autonomy) ?? mate.autonomy,
      sessionOverrides: null,
      projectSource,
      projectResolution: null,
      discussion: [],
      analysis: null,
      plan: null,
      dispatch: null,
      result: null,
      errors: [],
      createdAt: now,
      updatedAt: now,
      rev: 1,
    }
    await this.deps.store.putRequirement(requirement)
    this.scheduleAnalysis(requirement.id)
    return requirement
  }

  private async updateRequirement(args: Record<string, unknown>): Promise<RequirementView> {
    const id = requiredString(args.id, 'id-required', 'Requirement id is required')
    return this.deps.store.mutateRequirement(id, (current) => {
      if (current.status === 'running') return current
      return {
        ...current,
        title: args.title === undefined ? current.title : requiredString(args.title, 'title-required', 'Title is required').slice(0, 200),
        brief: args.brief === undefined ? current.brief : requiredString(args.brief, 'brief-required', 'Description is required').slice(0, 20000),
        projectPath: args.projectPath === undefined ? current.projectPath : optionalString(args.projectPath),
        projectTitle: args.projectTitle === undefined ? current.projectTitle : optionalString(args.projectTitle),
        priority: args.priority === undefined ? current.priority : parsePriority(args.priority),
        autonomy: parseAutonomy(args.autonomy) ?? current.autonomy,
        sessionOverrides: args.sessionOverrides === undefined ? current.sessionOverrides : parseModel(args.sessionOverrides),
      }
    })
  }

  private async analyzeRequirement(args: Record<string, unknown>): Promise<RequirementView> {
    const id = requiredString(args.id, 'id-required', 'Requirement id is required')
    const requirement = this.requireRequirement(id)
    if (requirement.status === 'running') {
      throw new CommandError('invalid-state', 'a running requirement cannot be re-analyzed')
    }
    const next = await this.deps.store.mutateRequirement(id, (current) => ({
      ...current,
      status: 'analyzing',
      errors: current.errors.filter((error) => error.phase !== 'analyze'),
    }))
    this.scheduleAnalysis(id)
    return next
  }

  private async answerRequirement(args: Record<string, unknown>): Promise<RequirementView> {
    const id = requiredString(args.id, 'id-required', 'Requirement id is required')
    const text = requiredString(args.text, 'answer-required', 'An answer is required')
    this.requireRequirement(id)
    const next = await this.deps.store.mutateRequirement(id, (current) => ({
      ...current,
      discussion: [...current.discussion, { role: 'user', text: text.slice(0, 8000), at: Date.now() }],
      status: 'analyzing',
      errors: current.errors.filter((error) => error.phase !== 'analyze'),
    }))
    this.scheduleAnalysis(id)
    return next
  }

  private async confirmRequirement(args: Record<string, unknown>): Promise<RequirementView> {
    const id = requiredString(args.id, 'id-required', 'Requirement id is required')
    const requirement = this.requireRequirement(id)
    if (!(requirement.status === 'proposed' || requirement.status === 'clarifying' || requirement.status === 'failed')) {
      throw new CommandError('invalid-state', `cannot confirm a requirement in status ${requirement.status}`)
    }
    const plan: PlanView = {
      targetProjectPath: optionalString(args.targetProjectPath)
        || resolveDispatchProject(requirement),
      dispatchMode: args.dispatchMode === 'reuse-idle'
        ? 'reuse-idle'
        : args.dispatchMode === 'new'
          ? 'new'
          : 'auto',
      extraInstruction: optionalString(args.extraInstruction).slice(0, 4000),
      at: Date.now(),
    }
    const next = await this.deps.store.mutateRequirement(id, (current) => ({
      ...current,
      plan,
      status: 'approved',
    }))
    this.scheduleDispatch(id)
    return next
  }

  private async reworkRequirement(args: Record<string, unknown>): Promise<RequirementView> {
    const id = requiredString(args.id, 'id-required', 'Requirement id is required')
    const note = optionalString(args.note)
    const requirement = this.requireRequirement(id)
    if (requirement.status === 'running') {
      throw new CommandError('invalid-state', 'cancel the running session before reworking this requirement')
    }
    const next = await this.deps.store.mutateRequirement(id, (current) => ({
      ...current,
      discussion: note.length > 0
        ? [...current.discussion, { role: 'user', text: `Rework requested: ${note}`.slice(0, 8000), at: Date.now() }]
        : current.discussion,
      result: null,
      status: 'approved',
      plan: current.plan === null ? null : { ...current.plan, at: Date.now() },
    }))
    this.scheduleDispatch(id)
    return next
  }

  private async acceptRequirement(args: Record<string, unknown>): Promise<RequirementView> {
    const id = requiredString(args.id, 'id-required', 'Requirement id is required')
    return this.deps.store.mutateRequirement(id, (current) => ({
      ...current,
      status: 'done',
      errors: current.errors.filter((error) => error.phase !== 'monitor'),
    }))
  }

  private async cancelRequirement(args: Record<string, unknown>): Promise<RequirementView> {
    const id = requiredString(args.id, 'id-required', 'Requirement id is required')
    const requirement = this.requireRequirement(id)
    const sessionId = requirement.dispatch?.sessionId
    const next = await this.deps.store.mutateRequirement(id, (current) => ({
      ...current,
      status: 'cancelled',
    }))
    if (typeof sessionId === 'string') await this.dispatcher.cancel(sessionId)
    return next
  }

  private async redispatchRequirement(args: Record<string, unknown>): Promise<RequirementView> {
    const id = requiredString(args.id, 'id-required', 'Requirement id is required')
    const requirement = this.requireRequirement(id)
    if (requirement.status === 'running') {
      throw new CommandError('invalid-state', 'this requirement is already running')
    }
    const next = await this.deps.store.mutateRequirement(id, (current) => ({
      ...current,
      status: 'approved',
      result: null,
      dispatch: null,
      errors: current.errors.filter((error) => error.phase !== 'dispatch'),
    }))
    this.scheduleDispatch(id)
    return next
  }

  private async splitRequirement(args: Record<string, unknown>): Promise<RequirementView[]> {
    const id = requiredString(args.id, 'id-required', 'Requirement id is required')
    const parent = this.requireRequirement(id)
    const items = Array.isArray(args.items) ? args.items : []
    if (items.length === 0) throw new CommandError('items-required', 'at least one child requirement is required')
    const mate = this.deps.store.getMate(parent.mateId)
    const created: RequirementView[] = []
    for (const item of items.slice(0, 8)) {
      const record = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}
      const title = optionalString(record.title).slice(0, 200)
      if (title.length === 0) continue
      const now = Date.now()
      const child: RequirementView = {
        ...parent,
        id: newRequirementId(),
        number: await this.deps.store.nextNumber(),
        title,
        brief: optionalString(record.brief) || `${parent.brief}\n\n(Child requirement: ${title})`,
        parentId: parent.id,
        kind: 'requirement',
        status: 'draft',
        analysis: null,
        plan: null,
        dispatch: null,
        result: null,
        errors: [],
        discussion: [],
        createdAt: now,
        updatedAt: now,
        rev: 1,
        mateName: mate?.name ?? parent.mateName,
        mateModel: mate ? `${mate.model.provider}/${mate.model.model}` : parent.mateModel,
      }
      await this.deps.store.putRequirement(child)
      created.push(child)
    }
    if (created.length === 0) throw new CommandError('items-required', 'no child requirement had a title')
    const updatedParent = await this.deps.store.mutateRequirement(id, (current) => ({
      ...current,
      kind: 'goal',
      status: 'running',
      dispatch: null,
    }))
    for (const child of created) this.scheduleAnalysis(child.id)
    return [updatedParent, ...created]
  }

  /** Permanently remove a requirement, its child records, and its live session. */
  private async deleteRequirement(args: Record<string, unknown>): Promise<{ deleted: number }> {
    const id = requiredString(args.id, 'id-required', 'Requirement id is required')
    const requirement = this.requireRequirement(id)
    const all = this.deps.store.listRequirements()
    const doomed = new Set<string>([id])
    let grew = true
    while (grew) {
      grew = false
      for (const item of all) {
        if (item.parentId !== null && doomed.has(item.parentId) && !doomed.has(item.id)) {
          doomed.add(item.id)
          grew = true
        }
      }
    }
    const sessionIds = all
      .filter((item) => doomed.has(item.id) && item.dispatch !== null)
      .map((item) => item.dispatch?.sessionId)
      .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0)
    for (const sessionId of sessionIds) await this.dispatcher.cancel(sessionId)
    let deleted = 0
    for (const target of doomed) {
      if (await this.deps.store.removeRequirement(target)) deleted += 1
    }
    return { deleted }
  }

  private async addChild(args: Record<string, unknown>): Promise<RequirementView[]> {
    const items = [{
      title: requiredString(args.title, 'title-required', 'Title is required'),
      brief: optionalString(args.brief),
    }]
    return this.splitRequirement({ id: args.id, items })
  }

  /** Settle a manual-vs-suggested project conflict and dispatch. */
  private async resolveProject(args: Record<string, unknown>): Promise<RequirementView> {
    const id = requiredString(args.id, 'id-required', 'Requirement id is required')
    const choice: ProjectResolution = args.choice === 'mate' ? 'mate' : 'user'
    const requirement = this.requireRequirement(id)
    if (requirement.status !== 'conflict') {
      throw new CommandError('invalid-state', `cannot resolve the project for a requirement in status ${requirement.status}`)
    }
    const next = await this.deps.store.mutateRequirement(id, (current) => ({
      ...current,
      projectResolution: choice,
      status: 'approved',
    }))
    this.scheduleDispatch(id)
    return next
  }

  /** Register a directory the user typed/picked into the project list. */
  private async registerProject(args: Record<string, unknown>): Promise<ProjectRecord> {
    const normalized = normalizeProjectPath(optionalString(args.path))
    if (!normalized.ok) throw new CommandError(normalized.error!.code, normalized.error!.message)
    if (!isDirectory(normalized.path)) {
      throw new CommandError('project-not-found', `Project directory does not exist: ${normalized.path}`)
    }
    const title = optionalString(args.title) || baseName(normalized.path)
    return this.deps.store.registerProject(normalized.path, title)
  }

  /** Unregister a project; the directory on disk is left alone. */
  private async removeProject(args: Record<string, unknown>): Promise<{ removed: boolean }> {
    const path = requiredString(args.path, 'project-path-required', 'A project path is required')
    return { removed: await this.deps.store.removeProject(path) }
  }
  /** Create a directory (recursively) and register it as a project. */
  private async createProject(args: Record<string, unknown>): Promise<ProjectRecord> {
    const normalized = normalizeProjectPath(requiredString(args.path, 'project-path-required', 'A project path is required'))
    if (!normalized.ok) throw new CommandError(normalized.error!.code, normalized.error!.message)
    if (!isDirectory(normalized.path)) {
      try {
        mkdirSync(normalized.path, { recursive: true })
      } catch (error) {
        throw new CommandError('project-create-failed', `Could not create ${normalized.path}: ${String(error)}`)
      }
    }
    if (!isDirectory(normalized.path)) {
      throw new CommandError('project-create-failed', `Project directory could not be created: ${normalized.path}`)
    }
    const title = optionalString(args.title) || baseName(normalized.path)
    return this.deps.store.registerProject(normalized.path, title)
  }
  /** Open a native directory dialog (Electron) and register the chosen path. */
  private async pickDirectory(): Promise<{ path: string | null; project: ProjectRecord | null }> {
    const dialog = electronDialog()
    if (dialog === null) {
      throw new CommandError('dialog-unavailable', 'The native directory dialog is unavailable here; enter a path manually')
    }
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    const path = Array.isArray(result?.filePaths) && result.filePaths.length > 0
      ? String(result.filePaths[0])
      : ''
    if (path.length === 0) return { path: null, project: null }
    const normalized = normalizeProjectPath(path)
    if (!normalized.ok) throw new CommandError(normalized.error!.code, normalized.error!.message)
    if (!isDirectory(normalized.path)) {
      throw new CommandError('project-not-found', `Project directory does not exist: ${normalized.path}`)
    }
    const project = await this.deps.store.registerProject(normalized.path, baseName(normalized.path))
    return { path: normalized.path, project }
  }

  private async updateSettings(args: Record<string, unknown>): Promise<SettingsView> {
    const patch: Partial<MateGlobalRecord> = {}
    if (args.defaultMateId !== undefined) {
      patch.defaultMateId = typeof args.defaultMateId === 'string' && args.defaultMateId.length > 0
        ? args.defaultMateId
        : null
    }
    if (args.pollMs !== undefined) patch.pollMs = Math.round(clampNumber(args.pollMs, 1000, 30000, 2500))
    if (args.reuseIdleSession !== undefined) patch.reuseIdleSession = args.reuseIdleSession === true
    // The browser payload is untrusted; validate strictly so a bad threshold can
    // never be persisted (old configs bypass this path and default to 80).
    if (args.contextCompression !== undefined) {
      const validation = validateContextCompressionConfig(args.contextCompression)
      if (!validation.ok) {
        throw new CommandError(
          'context-compression-invalid',
          validation.errors[0]?.message ?? 'the context compression configuration is invalid',
          { errors: validation.errors },
        )
      }
      patch.contextCompression = validation.value
    }
    let scheduleChanged = false
    if (args.schedule !== undefined) {
      // The browser config is always untrusted `unknown`; the Host is authoritative.
      const validation = validateScheduleConfig(args.schedule)
      if (!validation.ok) {
        throw new CommandError(
          'schedule-invalid',
          validation.errors[0]?.message ?? 'the schedule configuration is invalid',
          { errors: validation.errors },
        )
      }
      patch.schedule = validation.value
      scheduleChanged = true
    }
    await this.deps.store.updateSettings(patch)
    // A newly-opened window must be re-evaluated now, not at the stale stored
    // wake instant: judge every queued requirement with the edited schedule.
    if (scheduleChanged) await this.reevaluateQueue()
    const settings = this.deps.store.settings()
    return {
      defaultMateId: settings.defaultMateId,
      pollMs: settings.pollMs,
      reuseIdleSession: settings.reuseIdleSession,
      version: PLUGIN_VERSION,
      lastStartedAt: settings.lastStartedAt ?? null,
      lastProjectPath: settings.lastProjectPath ?? null,
      modelCatalog: this.cachedCatalog,
      schedule: settings.schedule ?? emptyScheduleConfig(),
      timezone: this.effectiveTimeZone(),
      contextCompression: this.deps.store.contextCompression(),
    }
  }

  /** The zone availability is judged in: manual override, then client, then Host. */
  private effectiveTimeZone(): TimeZoneView {
    const settings = this.deps.store.settings()
    return resolveEffectiveTimeZone({
      manual: settings.schedule?.timezone ?? null,
      client: settings.clientTimeZone ?? null,
      host: hostTimeZone(),
    })
  }

  /** Current injected instant (epoch ms). Never read the system clock directly. */
  private now(): number {
    return this.clock()
  }

  // ------------------------------------------------------------ background

  private scheduleAnalysis(id: string): void {
    this.schedule(`analyze:${id}`, async () => this.runAnalysis(id))
  }

  private scheduleDispatch(id: string): void {
    this.schedule(`dispatch:${id}`, async () => this.runDispatch(id))
  }

  private scheduleSummary(id: string): void {
    this.schedule(`summary:${id}`, async () => this.runSummary(id))
  }

  private schedule(key: string, task: () => Promise<void>): void {
    if (this.inflight.has(key)) return
    this.inflight.add(key)
    const run = (async () => {
      try {
        await task()
      } catch (error) {
        this.deps.log(`[dsh-mate] ${key} failed: ${String(error)}`)
      } finally {
        this.inflight.delete(key)
      }
    })()
    this.background.add(run)
    void run.then(() => { this.background.delete(run) })
  }

  /**
   * Await every scheduled background task that is still in flight (a test
   * synchronization seam; the Host itself never awaits this on the hot path).
   * Tasks scheduled by a task being awaited are drained too.
   */
  async waitForBackground(): Promise<void> {
    while (this.background.size > 0) {
      const pending = [...this.background]
      await Promise.allSettled(pending)
      for (const promise of pending) this.background.delete(promise)
    }
  }

  private async runAnalysis(id: string): Promise<void> {
    const requirement = this.deps.store.getRequirement(id)
    if (requirement === undefined) return
    if (isTerminal(requirement.status)) return
    const mate = this.deps.store.getMate(requirement.mateId)
    if (mate === undefined) {
      await this.failRequirement(id, 'analyze', new CommandError('mate-missing', 'the requirement Mate no longer exists'))
      return
    }
    if (this.deps.analyzer === null) {
      await this.failRequirement(id, 'analyze', new CommandError('analyzer-unavailable', 'ctx.llm is unavailable in this profile'))
      return
    }
    try {
      // Availability gate: never call the model route while a schedule window
      // disables it. The requirement is persisted as queued instead and the
      // wake timer is re-armed; there is no fallback to another model.
      const gate = this.evaluateRoute(mate.model)
      if (!gate.available) {
        await this.queueForWindow(requirement, 'analyze', mate.model, gate)
        return
      }
      const projects = await this.projects()
      const candidatePath = resolveDispatchProject(requirement)
      const candidates = await this.reuseCandidates(candidatePath)
      const output = await this.deps.analyzer.analyze({
        requirement,
        mate,
        projects,
        models: this.cachedCatalog,
        sessions: candidates,
        language: this.language,
        maxTokens: DEFAULT_TARGETS.analysis,
      })
      const auto = requirement.autonomy === 'auto'
      const analysis = output.analysis
      // A reused session must be one the Host actually offered to the model.
      analysis.reuseSessionId = validateReuseSession(candidates, analysis.reuseSessionId)
      // A restricted Mate may only hand the session a model it was allowed.
      if (mate.dispatchModels !== undefined && mate.dispatchModels.length > 0) {
        analysis.sessionModel = resolveDispatchModel(mate.dispatchModels, analysis.sessionModel)
      }
      const questions = analysis.questions
      const outcome = planAnalysisOutcome({
        projectSource: requirement.projectSource,
        projectPath: requirement.projectPath,
        projectResolution: requirement.projectResolution,
        autonomy: requirement.autonomy,
        analysis,
      })
      // The Mate owns the decision now: no confidence threshold and no manual
      // confirm gate unless this requirement or its Mate is set to confirm.
      const discussion = auto && analysis.needsClarification && questions.length > 0
        ? [...requirement.discussion, {
          role: 'mate' as const,
          text: questions.map((question) => `• ${question}`).join('\n'),
          at: Date.now(),
          model: mate.model.model,
        }]
        : requirement.discussion
      const title = analysis.title !== undefined && analysis.title.length > 0
        ? analysis.title.slice(0, 80)
        : requirement.title
      const priority = analysis.priority ?? requirement.priority
      // In auto mode the card's project follows the Mate's suggestion; a manual
      // selection is left untouched so the conflict resolution can tell them apart.
      const source = projectSourceOf(requirement.projectSource)
      const resolvedProjectPath = source === 'auto' && analysis.suggestedProjectPath
        ? analysis.suggestedProjectPath
        : requirement.projectPath
      const resolvedProjectTitle = resolvedProjectPath === requirement.projectPath
        ? requirement.projectTitle
        : (resolvedProjectPath ? baseName(resolvedProjectPath) : requirement.projectTitle)
      if (source === 'auto' && analysis.suggestedProjectPath) {
        await this.deps.store.rememberProject(analysis.suggestedProjectPath, baseName(analysis.suggestedProjectPath))
      }
      await this.deps.store.mutateRequirement(id, (current) => ({
        ...current,
        title,
        priority,
        analysis,
        status: outcome.status,
        projectResolution: outcome.projectResolution,
        projectPath: resolvedProjectPath,
        projectTitle: resolvedProjectTitle,
        discussion,
        errors: current.errors.filter((error) => error.phase !== 'analyze'),
      }))
      if (outcome.status === 'approved') this.scheduleDispatch(id)
    } catch (error) {
      await this.failRequirement(id, 'analyze', error)
    }
  }

  private async runDispatch(id: string): Promise<void> {
    const requirement = this.deps.store.getRequirement(id)
    if (requirement === undefined || requirement.status !== 'approved') return
    if (requirement.kind === 'goal') return
    const mate = this.deps.store.getMate(requirement.mateId)
    if (mate === undefined) {
      await this.failRequirement(id, 'dispatch', new CommandError('mate-missing', 'the requirement Mate no longer exists'))
      return
    }
    const projectPath = resolveDispatchProject(requirement)
    if (!projectPath) {
      await this.failRequirement(id, 'dispatch', new CommandError('project-required', 'no target project is known for this requirement'))
      return
    }
    // The Mate picked the session model during analysis; the user never sets it.
    // A dispatch-model restriction still wins over a manual override. The gate
    // judges this final route, so a queued dispatch can never escape its window.
    const requested = requirement.sessionOverrides ?? requirement.analysis?.sessionModel ?? mate.dispatchModel ?? mate.model
    const model = mate.dispatchModels === undefined || mate.dispatchModels.length === 0
      ? requested
      : resolveDispatchModel(mate.dispatchModels, requested)
    // Availability gate: the exact route that would be used must be available.
    const gate = this.evaluateRoute(model)
    if (!gate.available) {
      await this.queueForWindow(requirement, 'dispatch', model, gate)
      return
    }
    // A reuse the Mate chose is re-checked here: the session may have started
    // running or moved since the analysis, in which case a new one is created.
    const dispatchMode = requirement.plan?.dispatchMode ?? 'auto'
    const wantedReuse = dispatchMode === 'new' ? null : requirement.analysis?.reuseSessionId ?? null
    const reuseSessionId = wantedReuse === null ? null : await this.reusableSession(wantedReuse, projectPath)
    try {
      const outcome = await this.dispatcher.dispatch(requirement, mate, projectPath, model, {
        ...(reuseSessionId === null ? {} : { reuseSessionId }),
      })
      const now = Date.now()
      await this.deps.store.mutateRequirement(id, (current) => ({
        ...current,
        status: 'running',
        dispatch: {
          sessionId: outcome.sessionId,
          requestedAt: now,
          lastRunningAt: now,
          reused: outcome.reused,
          pendingInput: [],
        },
        errors: [
          ...current.errors.filter((error) => error.phase !== 'dispatch'),
          ...outcome.warnings.map((warning) => ({
            at: now, phase: 'dispatch', code: warning.code, message: warning.message,
          })),
        ],
      }))
    } catch (error) {
      await this.failRequirement(id, 'dispatch', error)
    }
  }

  /**
   * Summary is intentionally NOT gated: the availability schedule only governs
   * the two model-call starts (requirement analysis and dispatch). A session
   * that already ran must stay summarizable outside its window.
   */
  private async runSummary(id: string): Promise<void> {
    const requirement = this.deps.store.getRequirement(id)
    if (requirement === undefined || requirement.dispatch === null) return
    const mate = this.deps.store.getMate(requirement.mateId)
    if (mate === undefined || this.deps.analyzer === null) return
    try {
      const transcript = this.deps.transcript === null
        ? ''
        : await this.deps.transcript(requirement.dispatch.sessionId)
      const output = await this.deps.analyzer.summarize({
        requirement,
        mate,
        transcript,
        language: this.language,
        maxTokens: DEFAULT_TARGETS.summary,
      })
      await this.deps.store.mutateRequirement(id, (current) => ({
        ...current,
        result: output.result,
        status: 'awaiting_review',
      }))
    } catch (error) {
      await this.failRequirement(id, 'summarize', error)
    }
  }

  // -------------------------------------------------- context compression

  /**
   * Resolve one reused session's occupancy for the pre-dispatch gate.
   *
   * Order of preference (see docs/context-compression.md):
   * 1. `sessionController.projections()` — complete projection face, live AND
   *    cold, yields the provider-anchored `contextPressure` sample;
   * 2. `ctx.tokenMeter` over a live session body, when projections are absent;
   * 3. the durable surface char heuristic (`sessionQuery.readSurface`).
   *
   * The destination dispatch route's window wins over the window stored with
   * an older request (the session may have been used with another model).
   * Returning null means "not measurable in this profile": the gate then keeps
   * the original dispatch path instead of guessing.
   */
  private async measureContext(sessionId: string, model: ModelSelection | null): Promise<ContextMeasurement | null> {
    const routeWindow = await this.modelWindow(model)

    const projection = await this.projectionPressure(sessionId)
    if (projection !== null) {
      return {
        usedTokens: projection.usedTokens,
        windowTokens: routeWindow ?? projection.windowTokens,
        source: projection.source,
      }
    }

    if (this.contextMeter !== null) {
      try {
        const sample = await this.contextMeter(sessionId)
        if (sample !== null) {
          return {
            usedTokens: sample.usedTokens,
            windowTokens: routeWindow ?? sample.windowTokens,
            source: 'provider',
          }
        }
      } catch (error) {
        this.deps.log(`[dsh-mate] context meter failed for ${sessionId}: ${String(error)}`)
      }
    }
    if (this.contextEstimator !== null) {
      try {
        const usedTokens = await this.contextEstimator(sessionId)
        if (usedTokens !== null) {
          return {
            usedTokens,
            windowTokens: routeWindow,
            source: 'estimate',
          }
        }
      } catch (error) {
        this.deps.log(`[dsh-mate] context estimate failed for ${sessionId}: ${String(error)}`)
      }
    }
    return null
  }

  /**
   * Read `contextPressure` from the session-controller projection face. Works
   * for live and cold sessions; `projectedTokens` (what the next request would
   * carry) is preferred over the last prompt's `pressureTokens` when present.
   */
  private async projectionPressure(sessionId: string): Promise<ContextMeasurement | null> {
    const projections = this.deps.controller.projections
    if (typeof projections !== 'function') return null
    try {
      const result = await projections.call(this.deps.controller, { sessionId }, this.lifetime.signal)
      const values = result?.values
      const raw = values === undefined ? undefined : values.contextPressure
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
      const pressure = raw as { pressureTokens?: unknown; projectedTokens?: unknown; contextWindow?: unknown }
      const usedTokens = typeof pressure.projectedTokens === 'number'
        ? pressure.projectedTokens
        : typeof pressure.pressureTokens === 'number'
          ? pressure.pressureTokens
          : null
      if (usedTokens === null || !Number.isFinite(usedTokens)) return null
      const windowTokens = typeof pressure.contextWindow === 'number' && pressure.contextWindow > 0
        ? pressure.contextWindow
        : null
      return {
        usedTokens,
        windowTokens,
        // A provider-reported prompt size anchors this sample; `projectedTokens`
        // alone (no provider usage) is the meter's own heuristic.
        source: typeof pressure.pressureTokens === 'number' ? 'provider' : 'estimate',
      }
    } catch {
      return null
    }
  }

  /** Route capacity for the dispatch model, from the LLM adapter's metadata. */
  private async modelWindow(model: ModelSelection | null): Promise<number | null> {
    if (model === null || this.deps.contextWindow === undefined || this.deps.contextWindow === null) return null
    try {
      const window = await this.deps.contextWindow(model.provider, model.model)
      return typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : null
    } catch {
      return null
    }
  }

  /** Condense one idle session through the optional compaction service. */
  private async compactContext(sessionId: string): Promise<CompactionOutcome> {
    if (this.contextCompactor === null) return { ok: false, reason: 'compaction-service-unavailable' }
    try {
      return await this.contextCompactor(sessionId, this.lifetime.signal)
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  // ------------------------------------------------- model availability gate

  /**
   * Judge one model route at the current injected instant against the persisted
   * schedule. A `null` route means nothing is pinned yet, so nothing is gated.
   */
  private evaluateRoute(model: ModelSelection | null): RouteGate {
    const settings = this.deps.store.settings()
    const schedule = settings.schedule ?? null
    const timezone = resolveEffectiveTimeZone({
      manual: schedule?.timezone ?? null,
      client: settings.clientTimeZone ?? null,
      host: hostTimeZone(),
    })
    if (model === null) {
      return { available: true, window: undefined, nextWakeAt: null, timezone: timezone.id }
    }
    const result = evaluateModelRoute({
      nowMs: this.now(),
      schedule,
      provider: model.provider,
      model: model.model,
      timezone: timezone.id,
      ...(schedule === null ? {} : { holidays: schedule.holidays }),
    })
    return {
      available: result.available,
      window: result.window === null ? undefined : describeWindow(result.window),
      nextWakeAt: result.nextAvailableAt,
      timezone: result.timezone,
    }
  }

  /** Persist one requirement as queued for the blocking window and re-arm the wake timer. */
  private async queueForWindow(
    requirement: RequirementView,
    phase: QueuePhase,
    model: ModelSelection | null,
    gate: RouteGate,
  ): Promise<void> {
    const now = this.now()
    const queued = await this.deps.store.mutateRequirement(requirement.id, (current) => {
      // An in-flight session is never altered by the schedule.
      if (current.status === 'running') return current
      const previous = current.queue ?? null
      return {
        ...current,
        status: 'queued',
        queue: {
          phase,
          reason: 'model-window',
          model: model === null ? null : { ...model },
          ...(gate.window === undefined ? {} : { window: gate.window }),
          enqueuedAt: previous?.enqueuedAt ?? now,
          nextWakeAt: gate.nextWakeAt,
          timezone: gate.timezone,
          attempts: previous?.attempts ?? 0,
        },
      }
    })
    if (queued.status !== 'queued') return
    const route = model === null ? '(session default)' : `${model.provider}/${model.model}`
    const wake = gate.nextWakeAt === null ? 'unknown' : new Date(gate.nextWakeAt).toISOString()
    this.deps.log(
      `[dsh-mate] gate: requirement #${requirement.number} (${shortId(requirement.id)}) `
      + `${phase} blocked by model window ${gate.window ?? 'unknown'} on ${route} (tz ${gate.timezone}) `
      + `until ${wake}; queued`,
    )
    this.queue.refresh()
  }

  /** The final dispatch route for one requirement, after the Mate allow-list. */
  private dispatchRouteFor(requirement: RequirementView, mate: MateView): ModelSelection | null {
    const requested = requirement.sessionOverrides ?? requirement.analysis?.sessionModel ?? mate.dispatchModel ?? mate.model
    return mate.dispatchModels === undefined || mate.dispatchModels.length === 0
      ? requested
      : resolveDispatchModel(mate.dispatchModels, requested)
  }

  /**
   * Wake handler for one queued requirement: re-judge its route with the current
   * clock. Still blocked → store the fresh `nextWakeAt` (bumping attempts) and
   * re-arm; available → clear the queue entry, restore the phase's entry status
   * and run that phase again. A requirement whose status is no longer `queued`
   * (including `running`) is left untouched.
   */
  async processQueued(queued: RequirementView): Promise<void> {
    if (this.lifetime.signal.aborted) return
    const requirement = this.deps.store.getRequirement(queued.id)
    if (requirement === undefined || requirement.queue == null) return
    if (requirement.status !== 'queued') return
    const entry = requirement.queue
    const mate = this.deps.store.getMate(requirement.mateId)
    if (mate === undefined) {
      // A queued requirement whose Mate vanished cannot resume; record the
      // failure and drop the queue entry in one atomic write.
      await this.deps.store.mutateRequirement(requirement.id, (current) => ({
        ...current,
        status: current.status === 'running' ? current.status : 'failed',
        queue: null,
        errors: [...current.errors, {
          at: this.now(),
          phase: entry.phase,
          code: 'mate-missing',
          message: 'the requirement Mate no longer exists',
        }].slice(-20),
      }))
      this.queue.refresh()
      return
    }
    const model = entry.phase === 'analyze' ? mate.model : this.dispatchRouteFor(requirement, mate)
    const gate = this.evaluateRoute(model)
    if (!gate.available) {
      const attempts = entry.attempts + 1
      await this.deps.store.mutateRequirement(requirement.id, (current) => {
        if (current.status !== 'queued' || current.queue == null) return current
        return {
          ...current,
          queue: {
            ...current.queue,
            model: model === null ? current.queue.model : { ...model },
            ...(gate.window === undefined ? {} : { window: gate.window }),
            nextWakeAt: gate.nextWakeAt,
            timezone: gate.timezone,
            attempts,
          },
        }
      })
      const wake = gate.nextWakeAt === null ? 'unknown' : new Date(gate.nextWakeAt).toISOString()
      this.deps.log(
        `[dsh-mate] queue: requirement #${requirement.number} (${shortId(requirement.id)}) still in model window `
        + `${gate.window ?? 'unknown'} (attempt ${attempts}); next wake ${wake}`,
      )
      this.queue.refresh()
      return
    }
    const resumed = await this.deps.store.mutateRequirement(requirement.id, (current) => {
      if (current.status !== 'queued') return current
      return {
        ...current,
        status: entry.phase === 'analyze' ? 'analyzing' : 'approved',
        queue: null,
      }
    })
    if (resumed.status === 'analyzing') {
      this.deps.log(`[dsh-mate] queue: requirement #${requirement.number} (${shortId(requirement.id)}) dequeued for analyze`)
      this.scheduleAnalysis(resumed.id)
    } else if (resumed.status === 'approved') {
      this.deps.log(`[dsh-mate] queue: requirement #${requirement.number} (${shortId(requirement.id)}) dequeued for dispatch`)
      this.scheduleDispatch(resumed.id)
    }
    this.queue.refresh()
  }

  /**
   * Re-judge every queued requirement against the current clock, regardless of
   * its stored wake instant. Used when the schedule itself changes: an edited
   * window can open early (or close late), so a stored `nextWakeAt` is stale.
   */
  private async reevaluateQueue(): Promise<void> {
    if (this.lifetime.signal.aborted) return
    for (const requirement of this.deps.store.queuedRequirements()) {
      try {
        await this.processQueued(requirement)
      } catch (error) {
        this.deps.log(`[dsh-mate] queue: re-evaluating requirement ${requirement.id} failed: ${String(error)}`)
      }
    }
    this.queue.refresh()
  }

  /**
   * Startup recovery: re-read the persisted FIFO queue after a Host restart and
   * resume every entry whose wake instant already passed (or is unknown); arm
   * the timer for the rest. Called once after `markStarted()`.
   */
  async resume(): Promise<void> {
    if (this.lifetime.signal.aborted) return
    const now = this.now()
    for (const requirement of this.deps.store.queuedRequirements()) {
      const entry = requirement.queue
      if (entry == null) continue
      if (entry.nextWakeAt === null || entry.nextWakeAt <= now) {
        try {
          await this.processQueued(requirement)
        } catch (error) {
          // A broken queue entry must not abort Host startup; the rest is tried.
          this.deps.log(`[dsh-mate] queue: resuming requirement ${requirement.id} failed: ${String(error)}`)
        }
      }
    }
    this.queue.refresh()
  }

  /** One monitor pass: reconcile dispatched sessions and nudge blocked dispatches. */
  async reconcile(): Promise<void> {
    const requirements = this.deps.store.listRequirements()
    const dispatched = requirements.filter((item) => item.dispatch !== null && item.status === 'running')
    if (dispatched.length > 0) {
      let summaries: SessionSummaryLike[] = []
      try {
        summaries = (await this.deps.controller.list({}, this.lifetime.signal)).items
      } catch (error) {
        this.deps.log(`[dsh-mate] session list failed: ${String(error)}`)
      }
      const byId = new Map(summaries.map((summary) => [summary.sessionId, summary]))
      for (const requirement of dispatched) {
        const dispatch = requirement.dispatch
        if (dispatch === null) continue
        const summary = byId.get(dispatch.sessionId)
        if (summary === undefined) {
          if (Date.now() - dispatch.requestedAt > 120_000) {
            await this.deps.store.mutateRequirement(requirement.id, (current) => ({
              ...current,
              status: 'failed',
              errors: [...current.errors, {
                at: Date.now(), phase: 'monitor', code: 'session-missing',
                message: 'the dispatched session no longer exists; redispatch or cancel',
              }],
            }))
          }
          continue
        }
        if (summary.running) {
          if (dispatch.lastRunningAt === null) {
            await this.deps.store.mutateRequirement(requirement.id, (current) => (
              current.dispatch === null ? current : { ...current, dispatch: { ...current.dispatch, lastRunningAt: Date.now() } }
            ))
          }
          continue
        }
        if (Date.now() - dispatch.requestedAt < 20_000) continue
        let pendingInput: string[] = []
        try {
          const state = await this.deps.controller.state({ sessionId: dispatch.sessionId }, this.lifetime.signal)
          pendingInput = Array.isArray(state.pendingInput) ? state.pendingInput : []
        } catch {
          // State is best-effort; a finished session is still reviewable.
        }
        await this.deps.store.mutateRequirement(requirement.id, (current) => ({
          ...current,
          status: current.result === null ? 'awaiting_review' : current.status,
          dispatch: current.dispatch === null
            ? null
            : { ...current.dispatch, pendingInput },
        }))
        this.scheduleSummary(requirement.id)
      }
    }

    const approved = requirements.filter((item) => item.status === 'approved' && item.kind === 'requirement')
    for (const requirement of approved) this.scheduleDispatch(requirement.id)
  }

  /** Record one session status transition (called from the Host event feed). */
  async onSessionStatus(sessionId: string, running: boolean): Promise<void> {
    const requirement = this.deps.store.listRequirements()
      .find((item) => item.dispatch?.sessionId === sessionId && item.status === 'running')
    if (requirement === undefined || requirement.dispatch === null) return
    if (running) {
      await this.deps.store.mutateRequirement(requirement.id, (current) => (
        current.dispatch === null ? current : { ...current, dispatch: { ...current.dispatch, lastRunningAt: Date.now() } }
      ))
      return
    }
    this.schedule(`reconcile-once`, async () => this.reconcile())
  }

  async onSessionError(sessionId: string, message: string): Promise<void> {
    const requirement = this.deps.store.listRequirements()
      .find((item) => item.dispatch?.sessionId === sessionId)
    if (requirement === undefined) return
    await this.deps.store.mutateRequirement(requirement.id, (current) => ({
      ...current,
      errors: [...current.errors, {
        at: Date.now(), phase: 'monitor', code: 'session-error', message,
      }].slice(-20),
    }))
  }

  // -------------------------------------------------------------- helpers

  private async failRequirement(id: string, phase: string, error: unknown): Promise<void> {
    const code = error instanceof CommandError ? error.code : 'internal'
    const message = error instanceof Error ? error.message : String(error)
    try {
      await this.deps.store.mutateRequirement(id, (current) => ({
        ...current,
        status: current.status === 'running' ? current.status : 'failed',
        errors: [...current.errors, { at: Date.now(), phase, code, message: message.slice(0, 1000) }].slice(-20),
      }))
    } catch (inner) {
      this.deps.log(`[dsh-mate] failed to record ${phase} failure: ${String(inner)}`)
    }
  }

  private requireRequirement(id: string): RequirementView {
    const requirement = this.deps.store.getRequirement(id)
    if (requirement === undefined) throw new CommandError('requirement-not-found', `Requirement not found: ${id}`)
    return requirement
  }

  private async listLive() {
    const items = (await this.deps.controller.list({}, this.lifetime.signal)).items
    const hidden = this.deps.store.hiddenSessionIds()
    const linked = new Map<string, string>()
    for (const requirement of this.deps.store.listRequirements()) {
      if (requirement.dispatch !== null) linked.set(requirement.dispatch.sessionId, requirement.id)
    }
    return items.slice(0, 60).map((item) => ({
      sessionId: item.sessionId,
      title: sessionTitle(item),
      cwd: typeof item.cwd === 'string' ? item.cwd : '',
      running: item.running === true,
      pendingInput: [] as string[],
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
      blank: item.blank === true,
      origin: item.origin === 'subagent' ? 'subagent' as const : null,
      linkedRequirementId: linked.get(item.sessionId) ?? null,
      hidden: hidden.has(item.sessionId),
    }))
  }

  /** Idle Mate sessions in one project a new requirement could continue. */
  private async reuseCandidates(projectPath: string): Promise<AnalyzeSessionCandidate[]> {
    if (projectPath.length === 0) return []
    try {
      const items = (await this.deps.controller.list({}, this.lifetime.signal)).items
      const linked = new Set<string>()
      for (const requirement of this.deps.store.listRequirements()) {
        if (requirement.dispatch !== null) linked.add(requirement.dispatch.sessionId)
      }
      return items
        .filter((item) => typeof item.cwd === 'string' && item.cwd === projectPath && item.running !== true && item.blank !== true)
        .map((item) => ({
          sessionId: item.sessionId,
          title: sessionTitle(item),
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
        }))
        .filter((item) => item.title.startsWith('Mate · ') || linked.has(item.sessionId))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 8)
    } catch {
      return []
    }
  }

  /** Confirm a Mate-chosen session is still idle and still in this project. */
  private async reusableSession(sessionId: string, projectPath: string): Promise<string | null> {
    try {
      const items = (await this.deps.controller.list({}, this.lifetime.signal)).items
      const found = items.find((item) => item.sessionId === sessionId)
      if (found === undefined || found.running === true) return null
      if (typeof found.cwd === 'string' && projectPath.length > 0 && found.cwd !== projectPath) return null
      return sessionId
    } catch {
      return null
    }
  }
  /** Track one existing session as a requirement without dispatching anything. */
  private async adoptSession(args: Record<string, unknown>): Promise<RequirementView> {
    const sessionId = requiredString(args.sessionId, 'session-required', 'A session id is required')
    const existing = this.deps.store.listRequirements()
      .find((item) => item.dispatch?.sessionId === sessionId)
    if (existing !== undefined) return existing
    const items = (await this.deps.controller.list({}, this.lifetime.signal)).items
    const summary = items.find((item) => item.sessionId === sessionId)
    if (summary === undefined) throw new CommandError('session-not-found', `Session not found: ${sessionId}`)
    const settings = this.deps.store.settings()
    const mateId = typeof args.mateId === 'string' && args.mateId.length > 0
      ? args.mateId
      : settings.defaultMateId ?? this.deps.store.listMates().find((candidate) => !candidate.archived)?.id
    const mate = this.requireMate(mateId)
    const projectPath = typeof summary.cwd === 'string' ? summary.cwd : ''
    const now = Date.now()
    const title = (optionalString(args.title) || sessionTitle(summary) || `会话 ${sessionId.slice(0, 8)}`).slice(0, 200)
    const requirement: RequirementView = {
      id: newRequirementId(),
      number: await this.deps.store.nextNumber(),
      title,
      brief: `Adopted from existing session ${sessionId}.`,
      projectPath,
      projectTitle: baseName(projectPath),
      priority: 'normal',
      mateId: mate.id,
      mateName: mate.name,
      mateModel: `${mate.model.provider}/${mate.model.model}`,
      parentId: null,
      kind: 'requirement',
      status: summary.running ? 'running' : 'awaiting_review',
      autonomy: mate.autonomy,
      sessionOverrides: null,
      discussion: [],
      analysis: null,
      plan: null,
      dispatch: {
        sessionId,
        requestedAt: now,
        lastRunningAt: summary.running ? now : null,
        reused: true,
        pendingInput: [],
      },
      result: null,
      errors: [],
      createdAt: now,
      updatedAt: now,
      rev: 1,
    }
    await this.deps.store.putRequirement(requirement)
    if (!summary.running) this.scheduleSummary(requirement.id)
    return requirement
  }

  private async hideSession(args: Record<string, unknown>): Promise<{ hidden: boolean }> {
    const sessionId = requiredString(args.sessionId, 'session-required', 'A session id is required')
    if (args.hidden === false) {
      await this.deps.store.unhideSession(sessionId)
      return { hidden: false }
    }
    await this.deps.store.hideSession(sessionId)
    return { hidden: true }
  }

  /** Read one existing session's transcript for the preview drawer. */
  private async sessionTranscript(args: Record<string, unknown>): Promise<SessionTranscriptView> {
    const sessionId = requiredString(args.sessionId, 'session-required', 'A session id is required')
    let title = ''
    let cwd = ''
    let running = false
    let updatedAt = 0
    try {
      const items = (await this.deps.controller.list({}, this.lifetime.signal)).items
      const summary = items.find((item) => item.sessionId === sessionId)
      if (summary !== undefined) {
        title = sessionTitle(summary)
        cwd = typeof summary.cwd === 'string' ? summary.cwd : ''
        running = summary.running === true
        updatedAt = typeof summary.updatedAt === 'number' ? summary.updatedAt : 0
      }
    } catch {
      // The header stays minimal when the list read fails; the transcript may still load.
    }
    if (this.messages === null) {
      return { sessionId, title, cwd, running, updatedAt, messages: [], unavailable: 'sessionQuery is unavailable in this profile' }
    }
    try {
      const messages = await this.messages(sessionId)
      return { sessionId, title, cwd, running, updatedAt, messages }
    } catch (error) {
      return {
        sessionId,
        title,
        cwd,
        running,
        updatedAt,
        messages: [],
        unavailable: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async projects(): Promise<ProjectOption[]> {
    const found = new Map<string, string>()
    for (const project of this.deps.store.storedProjects()) found.set(project.path, project.title)
    try {
      const { items } = await this.deps.controller.list({}, this.lifetime.signal)
      for (const item of items) {
        if (typeof item.cwd === 'string' && item.cwd.length > 0 && !found.has(item.cwd)) {
          found.set(item.cwd, baseName(item.cwd))
        }
      }
    } catch {
      // Project options are advisory; analysis can proceed from stored projects.
    }
    return [...found.entries()].map(([path, title]) => ({ path, title }))
  }

  private cachedCatalog: SettingsView['modelCatalog'] = []

  async refreshModelCatalog(): Promise<void> {
    const controller = this.deps.controller as SessionControllerLike & {
      modelCatalog?: () => Promise<{ groups?: Array<{ id: string; name: string; models: Array<{ id: string; name?: string }> }> }>
    }
    if (typeof controller.modelCatalog !== 'function') return
    try {
      const catalog = await controller.modelCatalog()
      this.cachedCatalog = (catalog.groups ?? []).map((group) => ({
        provider: group.id,
        name: group.name,
        models: group.models.map((model) => ({ id: model.id, name: model.name ?? model.id })),
      }))
    } catch {
      // A catalog failure only narrows the model picker.
    }
  }
}

function sessionTitle(summary: SessionSummaryLike): string {
  const values = summary.projections?.values
  const title = values?.title
  if (typeof title === 'string' && title.length > 0) return title
  if (title !== null && typeof title === 'object') {
    const text = (title as { text?: unknown }).text
    if (typeof text === 'string' && text.length > 0) return text
  }
  return summary.sessionId.slice(0, 12)
}

/** Fold distilled facts into the stored memory, de-duplicating and capping. */
export function mergeMemory(
  current: MateMemoryEntry[],
  distilled: Array<{ kind: MateMemoryEntry['kind']; text: string }>,
  now = Date.now(),
): MateMemoryEntry[] {
  const byText = new Map<string, MateMemoryEntry>()
  for (const entry of current) byText.set(entry.text.toLowerCase(), entry)
  for (const entry of distilled) {
    const key = entry.text.toLowerCase()
    if (byText.has(key)) continue
    byText.set(key, { id: randomUUID(), kind: entry.kind, text: entry.text, createdAt: now })
  }
  return [...byText.values()].slice(-60)
}
function baseName(path: string): string {
  if (!path) return ''
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').pop() ?? path
}

/** First meaningful line of a requirement body, used until the Mate names it. */
function firstLineTitle(brief: string): string {
  const line = brief.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0) ?? brief.trim()
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

function requiredString(value: unknown, code: string, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new CommandError(code, message)
  return value.trim()
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseModel(value: unknown): ModelSelection | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const provider = optionalString(record.provider)
  const model = optionalString(record.model)
  if (provider.length === 0 || model.length === 0) return null
  const effort = optionalString(record.reasoningEffort)
  return effort.length > 0 ? { provider, model, reasoningEffort: effort } : { provider, model }
}

function parseAutonomy(value: unknown): AutonomyMode | null {
  return value === 'auto' ? 'auto' : value === 'confirm' ? 'confirm' : null
}

function parsePriority(value: unknown): RequirementView['priority'] {
  return value === 'low' || value === 'high' ? value : 'normal'
}

/** Keep the Mate's reuse choice only when the Host offered that session. */
export function validateReuseSession(
  candidates: AnalyzeSessionCandidate[],
  candidate: string | null | undefined,
): string | null {
  if (candidate === null || candidate === undefined) return null
  return candidates.some((item) => item.sessionId === candidate) ? candidate : null
}
/** Normalise the dispatch-model allowlist; an empty list means no restriction. */
export function parseDispatchModels(value: unknown): DispatchModelRule[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const rules: DispatchModelRule[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
    const model = typeof record.model === 'string' ? record.model.trim() : ''
    const effort = typeof record.reasoningEffort === 'string' ? record.reasoningEffort.trim() : ''
    if (provider.length === 0 || model.length === 0) continue
    const key = `${provider}/${model}/${effort}`
    if (seen.has(key)) continue
    seen.add(key)
    rules.push({ provider, model, ...(effort.length > 0 ? { reasoningEffort: effort } : {}) })
    if (rules.length >= 20) break
  }
  return rules.length === 0 ? undefined : rules
}

/** Map the Mate's pick onto the allowlist, keeping the effort of the match. */
export function resolveDispatchModel(
  rules: DispatchModelRule[] | undefined,
  candidate: ModelSelection | null | undefined,
): ModelSelection | null {
  const allowed = rules ?? []
  if (allowed.length === 0) return candidate ?? null
  const toSelection = (rule: DispatchModelRule): ModelSelection => ({
    provider: rule.provider,
    model: rule.model,
    ...(rule.reasoningEffort === undefined ? {} : { reasoningEffort: rule.reasoningEffort }),
  })
  if (candidate !== null && candidate !== undefined) {
    const sameRoute = allowed.filter((rule) => rule.provider === candidate.provider && rule.model === candidate.model)
    if (sameRoute.length > 0) {
      const exact = sameRoute.find((rule) => (rule.reasoningEffort ?? '') === (candidate.reasoningEffort ?? ''))
      return toSelection(exact ?? sameRoute[0])
    }
  }
  return toSelection(allowed[0])
}

function parseProjectSource(value: unknown): ProjectSource {
  return value === 'user' ? 'user' : value === 'user-new' ? 'user-new' : 'auto'
}

/** Best-effort native dialog handle; null when Electron is unavailable. */
function electronDialog(): { showOpenDialog(options: Record<string, unknown>): Promise<{ filePaths?: string[] }> } | null {
  try {
    const require = createRequire(import.meta.url)
    const electron = require('electron') as { dialog?: unknown } | undefined
    const dialog = electron?.dialog as { showOpenDialog?: unknown } | undefined
    if (dialog === undefined || typeof dialog.showOpenDialog !== 'function') return null
    return dialog as { showOpenDialog(options: Record<string, unknown>): Promise<{ filePaths?: string[] }> }
  } catch {
    return null
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

export type { AnalysisView }
