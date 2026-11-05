import type { MateAnalyzer, ProjectOption } from './analyzer.js'
import { Dispatcher, type SessionControllerLike, type SessionSummaryLike } from './dispatch.js'
import { newMateId, newRequirementId, type MateStore } from './store.js'
import {
  COMMANDS,
  isTerminal,
  PLUGIN_VERSION,
  type AnalysisView,
  type AutonomyMode,
  type CommandRequest,
  type MateView,
  type ModelSelection,
  type PlanView,
  type RequirementStatus,
  type RequirementView,
  type SettingsView,
  type Snapshot,
} from './shared.js'

export class CommandError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: unknown) {
    super(message)
    this.name = 'CommandError'
  }
}

export interface AppDeps {
  store: MateStore
  controller: SessionControllerLike
  analyzer: MateAnalyzer | null
  transcript: ((sessionId: string) => Promise<string>) | null
  log: (message: string) => void
}

const DEFAULT_TARGETS = { analysis: 4000, summary: 2500 }

/** Orchestrates the requirement lifecycle, model calls, and session dispatch. */
export class MateApp {
  private language = 'zh'
  private readonly inflight = new Set<string>()
  private readonly requestCache = new Map<string, unknown>()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly dispatcher: Dispatcher

  constructor(private readonly deps: AppDeps) {
    this.dispatcher = new Dispatcher(deps.controller, this.lifetime.signal)
  }

  /** One signal for every controller call, so disposal can abort in-flight work. */
  private readonly lifetime = new AbortController()

  /** Abort outstanding controller calls when the Host half unloads. */
  dispose(): void {
    this.lifetime.abort()
  }

  setTranscriptReader(reader: ((sessionId: string) => Promise<string>) | null): void {
    this.deps.transcript = reader
  }

  /**
   * Record this Host process's start time. Useful in the settings dialog to
   * tell "the panel is polling a stale host" from "the plugin never loaded".
   */
  async markStarted(): Promise<void> {
    await this.deps.store.updateSettings({ lastStartedAt: Date.now() })
  }

  async snapshot(rev?: number): Promise<{ unchanged: boolean; rev: number; snapshot?: Snapshot }> {
    const current = this.deps.store.revision
    if (typeof rev === 'number' && rev === current) {
      return { unchanged: true, rev: current }
    }
    const snapshot = await this.deps.store.buildSnapshot({
      listLive: () => this.listLive(),
      modelCatalog: () => this.cachedCatalog,
    })
    return { unchanged: false, rev: snapshot.rev, snapshot }
  }

  /** Serialized, idempotent command entry point. */
  async command(request: CommandRequest): Promise<unknown> {
    const requestId = typeof request.requestId === 'string' && request.requestId.length > 0 ? request.requestId : null
    if (requestId !== null && this.requestCache.has(requestId)) {
      return this.requestCache.get(requestId)
    }
    const run = this.queue.then(async () => {
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
    this.queue = run.catch(() => undefined)
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
      case COMMANDS.mateCreate: return this.createMate(args)
      case COMMANDS.mateUpdate: return this.updateMate(args)
      case COMMANDS.mateArchive: return this.archiveMate(args)
      case COMMANDS.mateDelete: return this.deleteMate(args)
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

  // --------------------------------------------------------- requirements

  private async createRequirement(args: Record<string, unknown>): Promise<RequirementView> {
    const title = requiredString(args.title, 'title-required', 'Title is required').slice(0, 200)
    const brief = requiredString(args.brief, 'brief-required', 'Description is required')
    const settings = this.deps.store.settings()
    const mateId = typeof args.mateId === 'string' && args.mateId.length > 0
      ? args.mateId
      : settings.defaultMateId ?? this.deps.store.listMates().find((candidate) => !candidate.archived)?.id
    const mate = this.requireMate(mateId)
    const projectPath = optionalString(args.projectPath) || this.defaultProjectPath()
    const now = Date.now()
    const requirement: RequirementView = {
      id: newRequirementId(),
      number: await this.deps.store.nextNumber(),
      title,
      brief: brief.slice(0, 20000),
      projectPath,
      projectTitle: optionalString(args.projectTitle) || baseName(projectPath),
      priority: parsePriority(args.priority),
      mateId: mate.id,
      mateName: mate.name,
      mateModel: `${mate.model.provider}/${mate.model.model}`,
      parentId: typeof args.parentId === 'string' && args.parentId.length > 0 ? args.parentId : null,
      kind: 'requirement',
      status: 'draft',
      autonomy: parseAutonomy(args.autonomy) ?? mate.autonomy,
      sessionOverrides: parseModel(args.sessionOverrides),
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
        || requirement.analysis?.suggestedProjectPath
        || requirement.projectPath,
      dispatchMode: args.dispatchMode === 'reuse-idle' ? 'reuse-idle' : 'new',
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

  private async updateSettings(args: Record<string, unknown>): Promise<SettingsView> {
    const patch: Record<string, unknown> = {}
    if (args.defaultMateId !== undefined) {
      patch.defaultMateId = typeof args.defaultMateId === 'string' && args.defaultMateId.length > 0
        ? args.defaultMateId
        : null
    }
    if (args.pollMs !== undefined) patch.pollMs = Math.round(clampNumber(args.pollMs, 1000, 30000, 2500))
    if (args.reuseIdleSession !== undefined) patch.reuseIdleSession = args.reuseIdleSession === true
    await this.deps.store.updateSettings(patch)
    const settings = this.deps.store.settings()
    return {
      defaultMateId: settings.defaultMateId,
      pollMs: settings.pollMs,
      reuseIdleSession: settings.reuseIdleSession,
      version: PLUGIN_VERSION,
      lastStartedAt: settings.lastStartedAt ?? null,
      modelCatalog: this.cachedCatalog,
    }
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
    void task()
      .catch((error: unknown) => { this.deps.log(`[dsh-mate] ${key} failed: ${String(error)}`) })
      .finally(() => { this.inflight.delete(key) })
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
      const projects = await this.projects()
      const output = await this.deps.analyzer.analyze({
        requirement,
        mate,
        projects,
        language: this.language,
        maxTokens: DEFAULT_TARGETS.analysis,
      })
      const auto = requirement.autonomy === 'auto'
      const analysis = output.analysis
      const questions = analysis.questions
      const status: RequirementStatus = auto
        ? (analysis.needsClarification
          ? 'clarifying'
          : (analysis.confidence >= mate.confidenceThreshold ? 'approved' : 'proposed'))
        : 'proposed'
      const discussion = auto && analysis.needsClarification && questions.length > 0
        ? [...requirement.discussion, {
          role: 'mate' as const,
          text: questions.map((question) => `• ${question}`).join('\n'),
          at: Date.now(),
          model: mate.model.model,
        }]
        : requirement.discussion
      await this.deps.store.mutateRequirement(id, (current) => ({
        ...current,
        analysis,
        status,
        discussion,
        errors: current.errors.filter((error) => error.phase !== 'analyze'),
      }))
      if (status === 'approved') this.scheduleDispatch(id)
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
    const running = this.deps.store.listRequirements()
      .filter((item) => item.mateId === mate.id && item.status === 'running').length
    if (running >= mate.maxParallel) {
      // Leave it approved; the monitor retries when a sibling finishes.
      return
    }
    const projectPath = requirement.plan?.targetProjectPath
      || requirement.analysis?.suggestedProjectPath
      || requirement.projectPath
    if (!projectPath) {
      await this.failRequirement(id, 'dispatch', new CommandError('project-required', 'no target project is known for this requirement'))
      return
    }
    try {
      const outcome = await this.dispatcher.dispatch(requirement, mate, projectPath)
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

  private defaultProjectPath(): string {
    const first = this.deps.store.storedProjects()[0]
    return first?.path ?? ''
  }

  private async listLive() {
    const items = (await this.deps.controller.list({}, this.lifetime.signal)).items
    return items.slice(0, 40).map((item) => ({
      sessionId: item.sessionId,
      title: sessionTitle(item),
      cwd: typeof item.cwd === 'string' ? item.cwd : '',
      running: item.running === true,
      pendingInput: [] as string[],
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
    }))
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

function baseName(path: string): string {
  if (!path) return ''
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').pop() ?? path
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

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

export type { AnalysisView }
