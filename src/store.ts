import { randomUUID } from 'node:crypto'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { resolveContextCompressionConfig } from './compression.js'
import type { MateDomain, MateGlobalRecord, ProjectRecord } from './domain.js'
import { PLUGIN_VERSION } from './shared.js'
import type {
  ContextCompressionConfig,
  MateView,
  ProjectView,
  RequirementView,
  ScheduleConfig,
  SettingsView,
  Snapshot,
  TimeZoneView,
} from './shared.js'

/** One live session row the Host controller reports. */
export interface LiveSessionInfo {
  sessionId: string
  title: string
  cwd: string
  running: boolean
  pendingInput: string[]
  updatedAt: number
  blank: boolean
  origin: 'subagent' | null
  linkedRequirementId: string | null
  hidden: boolean
}

/** Everything the snapshot needs from outside the store. */
export interface SnapshotSource {
  listLive(): Promise<LiveSessionInfo[]>
  modelCatalog(): SettingsView['modelCatalog']
  timezone(): TimeZoneView
}

/** The no-config schedule: no disabled windows, no manual holidays, no zone override. */
export function emptyScheduleConfig(): ScheduleConfig {
  return { models: [], holidays: [], workdays: [], useBuiltinHolidays: true, timezone: null }
}

export function newRequirementId(): string {
  return `req_${randomUUID()}`
}

export function newMateId(): string {
  return `mate_${randomUUID()}`
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/**
 * Typed façade over the `mate` storage domain. Reads are synchronous from the
 * domain's in-memory state; every write awaits durability and bumps the
 * snapshot revision so the browser can poll cheaply.
 */
export class MateStore {
  private rev = 0

  constructor(private readonly domain: Domain<MateDomain>) {}

  get revision(): number {
    return this.rev
  }

  bumpRevision(): number {
    this.rev += 1
    return this.rev
  }

  settings(): MateGlobalRecord {
    return this.domain.global.get()
  }

  /**
   * The effective context-compression policy. A missing or legacy section
   * resolves to `{ enabled: false, threshold: 80 }` so old storage keeps working.
   */
  contextCompression(): ContextCompressionConfig {
    return resolveContextCompressionConfig(this.settings().contextCompression)
  }

  async updateSettings(patch: Partial<MateGlobalRecord>): Promise<MateGlobalRecord> {
    const next: MateGlobalRecord = { ...this.settings(), ...patch }
    await this.domain.global.set(next)
    this.bumpRevision()
    return next
  }

  listMates(): MateView[] {
    return [...this.domain.table('mates').entries()].map(([, value]) => value)
  }

  getMate(id: string): MateView | undefined {
    return this.domain.table('mates').get(id)
  }

  async putMate(mate: MateView): Promise<MateView> {
    await this.domain.table('mates').put(mate.id, mate)
    this.bumpRevision()
    return mate
  }

  async removeMate(id: string): Promise<void> {
    await this.domain.table('mates').delete(id)
    this.bumpRevision()
  }

  listRequirements(): RequirementView[] {
    return [...this.domain.table('requirements').entries()].map(([, value]) => value)
  }

  /**
   * Requirements waiting for a model availability window, oldest first. The
   * FIFO order is the persisted insertion instant, so a Host restart keeps the
   * same queue order.
   */
  queuedRequirements(): RequirementView[] {
    return this.listRequirements()
      .filter((requirement) => requirement.status === 'queued' && requirement.queue != null)
      .sort((a, b) => (a.queue?.enqueuedAt ?? 0) - (b.queue?.enqueuedAt ?? 0) || a.number - b.number)
  }

  getRequirement(id: string): RequirementView | undefined {
    return this.domain.table('requirements').get(id)
  }

  async putRequirement(requirement: RequirementView): Promise<RequirementView> {
    await this.domain.table('requirements').put(requirement.id, requirement)
    this.bumpRevision()
    return requirement
  }

  /**
   * Atomic read-modify-write of one requirement. The transform sees the value
   * current at this write's queue slot, so concurrent commands cannot interleave.
   */
  async mutateRequirement(
    id: string,
    transform: (current: RequirementView) => RequirementView,
  ): Promise<RequirementView> {
    const next = await this.domain.table('requirements').update(id, (current) => {
      const updated = transform(current)
      return { ...updated, rev: current.rev + 1, updatedAt: Date.now() }
    })
    this.bumpRevision()
    return next
  }

  /** Unregister one project without touching its directory on disk. */
  async removeProject(path: string): Promise<boolean> {
    const removed = await this.domain.table('projects').delete(path)
    if (removed) this.bumpRevision()
    return removed
  }
  /** Remove one requirement record; callers own child and session cleanup. */
  async removeRequirement(id: string): Promise<boolean> {
    const removed = await this.domain.table('requirements').delete(id)
    if (removed) this.bumpRevision()
    return removed
  }

  async nextNumber(): Promise<number> {
    const current = this.settings()
    const next = current.seq + 1
    await this.domain.global.set({ ...current, seq: next })
    return next
  }

  async rememberProject(path: string, title: string): Promise<void> {
    if (!path) return
    const table = this.domain.table('projects')
    const existing = table.get(path)
    if (existing !== undefined) {
      if (existing.title === title) return
      await table.put(path, { ...existing, title, lastSeenAt: Date.now() })
      return
    }
    await table.put(path, { path, title, lastSeenAt: Date.now() })
  }

  /**
   * Register a directory the user explicitly chose (new-project flow). This
   * marks the row so `buildSnapshot` keeps it visible even before a session or
   * requirement references it, and it survives the snapshot rebuild.
   */
  async registerProject(path: string, title: string): Promise<ProjectRecord> {
    const table = this.domain.table('projects')
    const existing = table.get(path)
    if (existing !== undefined) {
      const next: ProjectRecord = { ...existing, registered: true, lastSeenAt: Date.now() }
      if (existing.registered !== true) {
        await table.put(path, next)
        this.bumpRevision()
      }
      return next
    }
    const record: ProjectRecord = { path, title, lastSeenAt: Date.now(), registered: true }
    await table.put(path, record)
    this.bumpRevision()
    return record
  }

  storedProjects(): ProjectRecord[] {
    return [...this.domain.table('projects').entries()].map(([, value]) => value)
  }

  hiddenSessionIds(): Set<string> {
    return new Set([...this.domain.table('hidden_sessions').entries()].map(([key]) => key))
  }

  async hideSession(sessionId: string): Promise<void> {
    await this.domain.table('hidden_sessions').put(sessionId, { sessionId, hiddenAt: Date.now() })
    this.bumpRevision()
  }

  async unhideSession(sessionId: string): Promise<void> {
    const removed = await this.domain.table('hidden_sessions').delete(sessionId)
    if (removed) this.bumpRevision()
  }

  async buildSnapshot(source: SnapshotSource): Promise<Snapshot> {
    const live = await source.listLive()
    const settings = this.settings()

    const byPath = new Map<string, ProjectView>()
    const remember: Array<{ path: string; title: string }> = []
    for (const session of live) {
      if (!session.cwd) continue
      const title = this.titleFor(session.cwd)
      remember.push({ path: session.cwd, title })
      const row = byPath.get(session.cwd) ?? {
        path: session.cwd,
        title,
        sessionCount: 0,
        running: 0,
        awaitingInput: 0,
        lastActiveAt: 0,
      }
      row.sessionCount += 1
      if (session.running) row.running += 1
      if (session.pendingInput.length > 0) row.awaitingInput += 1
      row.lastActiveAt = Math.max(row.lastActiveAt, session.updatedAt)
      byPath.set(session.cwd, row)
    }
    // Live projects and those still referenced by a requirement reach the
    // filter, plus directories the user explicitly registered. Stored rows are
    // otherwise a cache and can outlive their sessions.
    const requirementPaths = new Set(this.listRequirements().map((item) => item.projectPath))
    for (const project of this.storedProjects()) {
      if (byPath.has(project.path)) continue
      const keep = project.registered === true || requirementPaths.has(project.path)
      if (!keep) continue
      byPath.set(project.path, {
        path: project.path,
        title: project.title,
        sessionCount: 0,
        running: 0,
        awaitingInput: 0,
        lastActiveAt: project.lastSeenAt,
      })
    }
    for (const item of remember) {
      if (this.domain.table('projects').get(item.path) === undefined) {
        // Fire and forget: a snapshot must not fail because a cache write lagged.
        void this.domain.table('projects').put(item.path, { ...item, lastSeenAt: Date.now() })
          .then(() => { this.bumpRevision() })
          .catch(() => {})
      }
    }

    return {
      rev: this.rev,
      mates: this.listMates().sort((a, b) => a.createdAt - b.createdAt),
      requirements: this.listRequirements().sort((a, b) => b.updatedAt - a.updatedAt),
      projects: [...byPath.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt),
      liveSessions: live.slice().sort((a, b) => b.updatedAt - a.updatedAt),
      settings: {
        defaultMateId: settings.defaultMateId,
        pollMs: settings.pollMs,
        reuseIdleSession: settings.reuseIdleSession,
        version: PLUGIN_VERSION,
        lastStartedAt: settings.lastStartedAt ?? null,
        lastProjectPath: settings.lastProjectPath ?? null,
        modelCatalog: source.modelCatalog(),
        schedule: settings.schedule ?? emptyScheduleConfig(),
        timezone: source.timezone(),
        contextCompression: resolveContextCompressionConfig(settings.contextCompression),
      },
      serverTime: Date.now(),
    }
  }

  private titleFor(path: string): string {
    const stored = this.domain.table('projects').get(path)
    if (stored !== undefined) return stored.title
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
    const segment = normalized.split('/').pop()
    return segment && segment.length > 0 ? segment : path
  }
}
