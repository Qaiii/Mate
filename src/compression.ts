/**
 * Pre-dispatch context compression: the persisted policy, its validation, the
 * occupancy decision, the decision log line, and the handoff summary injected
 * when compaction is unavailable and a fresh session takes over.
 *
 * CONTRACT (owner: context-core). Keep every export below: the Host dispatch
 * gate, the settings page, the documentation and the tests import these names.
 * This module is pure and isomorphic — it must not import `node:*`, read the
 * system clock, or perform I/O — so the browser bundle can reuse validation and
 * defaults exactly as it does for `schedule.ts`.
 */
import type { ContextCompressionConfig } from './shared.js'

/** Policy applied when the stored config has no `contextCompression` section. */
export const DEFAULT_CONTEXT_COMPRESSION: ContextCompressionConfig = { enabled: false, threshold: 80 }

/** Smallest allowed occupancy threshold (percent). */
export const CONTEXT_COMPRESSION_THRESHOLD_MIN = 1
/** Largest allowed occupancy threshold (percent). */
export const CONTEXT_COMPRESSION_THRESHOLD_MAX = 100

/** Upper bound on the handoff summary injected into a fallback session. */
export const HANDOFF_MAX_CHARS = 4000
/** Upper bound on the current-task detail copied into a handoff summary. */
export const HANDOFF_BRIEF_MAX_CHARS = 600
/** Upper bound on one completed/remaining work item line. */
export const HANDOFF_ITEM_MAX_CHARS = 200
/** Upper bound on the number of work items copied into one handoff summary. */
export const HANDOFF_MAX_ITEMS = 20

/** A fresh copy of the default policy (never hand out the shared object). */
export function defaultContextCompression(): ContextCompressionConfig {
  return { ...DEFAULT_CONTEXT_COMPRESSION }
}

/** One validation issue, addressed by a dotted path into the submitted config. */
export interface ContextCompressionIssue {
  /** Stable machine code the settings page maps onto localized copy. */
  code: 'shape' | 'enabled' | 'threshold' | 'threshold-integer' | 'threshold-range'
  /** Dotted path, e.g. `threshold`. */
  path: string
  /** English developer-facing detail; the UI prefers the localized code. */
  message: string
}

/** Validation result: either the normalized policy or every issue found. */
export type ContextCompressionValidation =
  | { ok: true; value: ContextCompressionConfig }
  | { ok: false; errors: ContextCompressionIssue[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isThreshold(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= CONTEXT_COMPRESSION_THRESHOLD_MIN
    && value <= CONTEXT_COMPRESSION_THRESHOLD_MAX
}

/**
 * Tolerant read used by the Host snapshot and the dispatch gate. A missing,
 * malformed or legacy value degrades to the documented defaults instead of
 * throwing, so a pre-feature `mate.json` keeps working: `enabled=false`,
 * `threshold=80`.
 */
export function resolveContextCompressionConfig(raw: unknown): ContextCompressionConfig {
  if (!isRecord(raw)) return defaultContextCompression()
  return {
    enabled: raw.enabled === true,
    threshold: isThreshold(raw.threshold) ? raw.threshold : DEFAULT_CONTEXT_COMPRESSION.threshold,
  }
}

/**
 * Strict validation for an untrusted `settings.update` payload. Unlike
 * {@link resolveContextCompressionConfig} this reports issues instead of
 * silently repairing them, so the settings page can keep the dialog open and
 * the Host never persists a bad value.
 *
 * Rules: the value must be an object; `enabled` (when present) must be a
 * boolean; `threshold` (when present) must be an integer in
 * [{@link CONTEXT_COMPRESSION_THRESHOLD_MIN}, {@link CONTEXT_COMPRESSION_THRESHOLD_MAX}].
 * Missing fields fall back to the defaults.
 */
export function validateContextCompressionConfig(raw: unknown): ContextCompressionValidation {
  if (!isRecord(raw)) {
    return {
      ok: false,
      errors: [{ code: 'shape', path: '', message: 'contextCompression must be an object' }],
    }
  }
  const errors: ContextCompressionIssue[] = []

  let enabled = DEFAULT_CONTEXT_COMPRESSION.enabled
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      errors.push({ code: 'enabled', path: 'enabled', message: 'enabled must be a boolean' })
    } else {
      enabled = raw.enabled
    }
  }

  let threshold = DEFAULT_CONTEXT_COMPRESSION.threshold
  if (raw.threshold !== undefined) {
    if (typeof raw.threshold !== 'number' || !Number.isFinite(raw.threshold)) {
      errors.push({ code: 'threshold', path: 'threshold', message: 'threshold must be a number' })
    } else if (!Number.isInteger(raw.threshold)) {
      errors.push({ code: 'threshold-integer', path: 'threshold', message: 'threshold must be an integer' })
    } else if (raw.threshold < CONTEXT_COMPRESSION_THRESHOLD_MIN || raw.threshold > CONTEXT_COMPRESSION_THRESHOLD_MAX) {
      errors.push({
        code: 'threshold-range',
        path: 'threshold',
        message: `threshold must be between ${CONTEXT_COMPRESSION_THRESHOLD_MIN} and ${CONTEXT_COMPRESSION_THRESHOLD_MAX}`,
      })
    } else {
      threshold = raw.threshold
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { enabled, threshold } }
}

/** Where one occupancy sample came from; drives the documented error margin. */
export type ContextMeasurementSource =
  /** Provider-anchored sample: session-controller `contextPressure` or token-meter provider usage. */
  | 'provider'
  /** Local surface estimate: the fixed CJK-aware character heuristic (approximate). */
  | 'estimate'

/** One occupancy sample for a session, in tokens. */
export interface ContextMeasurement {
  /** Tokens the next request would carry (provider-anchored sample, or an estimate). */
  usedTokens: number
  /** Combined context window of the routed model; null when no capacity is known. */
  windowTokens: number | null
  /** Provider-anchored usage is near-exact; the local estimate is approximate. */
  source: ContextMeasurementSource
}

/** A raw sample a Host-side meter can produce. */
export interface ContextUsageSample {
  usedTokens: number
  windowTokens: number | null
}

/** Read one session's occupancy; null means "not measurable in this profile". */
export type ContextUsageReader = (sessionId: string) => Promise<ContextUsageSample | null>

/** Estimate one session's token usage from its durable log; null when unreadable. */
export type SessionTokenEstimator = (sessionId: string) => Promise<number | null>

/** Result of asking the compaction service to condense one session. */
export type CompactionOutcome =
  | { ok: true; tokensFreed?: number }
  | { ok: false; reason: string }

/** Condense one idle session; the Host adapter wires `ctx.compaction.compactNow`. */
export type ContextCompactor = (sessionId: string, signal: AbortSignal) => Promise<CompactionOutcome>

/** Why the decision ended where it did (the `reason` written to the log). */
export type ContextDecisionReason =
  | 'disabled'
  | 'measurement-unavailable'
  | 'window-unknown'
  | 'below-threshold'
  | 'threshold-reached'

/** What the dispatcher must do with the candidate session. */
export type ContextDecisionAction = 'none' | 'compress'

/** Final strategy reported in the log (compress or fall back to a new session). */
export type ContextStrategy = 'none' | 'compress' | 'new-session'

/** Pure occupancy decision for one candidate session. */
export interface ContextDecision {
  action: ContextDecisionAction
  reason: ContextDecisionReason
  /** Configured occupancy threshold in percent. */
  threshold: number
  /** Occupancy in percent (0-∞); null when no sample/capacity is available. */
  usagePercent: number | null
  usedTokens: number | null
  windowTokens: number | null
  source: ContextMeasurementSource | null
}

/** Occupancy of `usedTokens` against `windowTokens`, in percent. */
export function occupancyPercent(usedTokens: number, windowTokens: number): number {
  if (!Number.isFinite(usedTokens) || !Number.isFinite(windowTokens) || windowTokens <= 0) return 0
  return (usedTokens / windowTokens) * 100
}

/**
 * Decide whether a dispatch into an existing session must compress first.
 *
 * Only `enabled && usage >= threshold` enters the compression branch. Every
 * other outcome returns `action: 'none'` so the caller can keep the original
 * dispatch path untouched (no compaction call, no new session).
 */
export function decideContextAction(input: {
  config: ContextCompressionConfig
  measurement: ContextMeasurement | null | undefined
}): ContextDecision {
  const { config, measurement } = input
  const base = {
    threshold: config.threshold,
    usedTokens: measurement?.usedTokens ?? null,
    windowTokens: measurement?.windowTokens ?? null,
    source: measurement?.source ?? null,
  }
  if (!config.enabled) {
    return { action: 'none', reason: 'disabled', usagePercent: null, ...base }
  }
  if (measurement === null || measurement === undefined) {
    return { action: 'none', reason: 'measurement-unavailable', usagePercent: null, ...base }
  }
  if (
    measurement.windowTokens === null
    || !Number.isFinite(measurement.windowTokens)
    || measurement.windowTokens <= 0
  ) {
    return { action: 'none', reason: 'window-unknown', usagePercent: null, ...base }
  }
  const usagePercent = occupancyPercent(measurement.usedTokens, measurement.windowTokens)
  if (usagePercent >= config.threshold) {
    return { action: 'compress', reason: 'threshold-reached', usagePercent: usagePercent, ...base }
  }
  return { action: 'none', reason: 'below-threshold', usagePercent: usagePercent, ...base }
}

/** One percentage rendered for the log (`87.3`), or `unknown`. */
export function formatUsagePercent(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return 'unknown'
  return percent.toFixed(1)
}

/** Stable prefix every context-compression log line starts with. */
export const CONTEXT_COMPRESSION_LOG_PREFIX = '[dsh-mate] context-compression:'

/**
 * Render the decision log line. It always carries the four diagnosability
 * fields the requirement asks for: trigger reason, threshold, actual occupancy
 * and the final strategy.
 */
export function formatContextDecisionLog(input: {
  decision: ContextDecision
  strategy: ContextStrategy
  sessionId?: string | null
  requirementNumber?: number | null
  requirementId?: string | null
  /** Compaction failure detail, when the strategy fell back to a new session. */
  failure?: string | null
}): string {
  const { decision, strategy } = input
  const parts = [
    `reason=${decision.reason}`,
    `threshold=${decision.threshold}%`,
    `usage=${formatUsagePercent(decision.usagePercent)}%`,
    `tokens=${decision.usedTokens === null ? 'unknown' : decision.usedTokens}/${decision.windowTokens === null ? 'unknown' : decision.windowTokens}`,
    `strategy=${strategy}`,
  ]
  if (input.sessionId !== undefined && input.sessionId !== null) parts.push(`session=${input.sessionId}`)
  if (input.requirementNumber !== undefined && input.requirementNumber !== null) parts.push(`req=#${input.requirementNumber}`)
  if (input.requirementId !== undefined && input.requirementId !== null) parts.push(`id=${input.requirementId}`)
  if (input.failure !== undefined && input.failure !== null && input.failure.length > 0) {
    parts.push(`failure=${input.failure.replace(/\s+/g, ' ').slice(0, 240)}`)
  }
  return `${CONTEXT_COMPRESSION_LOG_PREFIX} ${parts.join(' ')}`
}

/** Input for the fresh-session handoff summary. */
export interface HandoffSummaryInput {
  /** Absolute target project path (the required "目标项目"). */
  projectPath: string
  /** Project display title; falls back to the path's last segment. */
  projectTitle?: string
  /** The requirement title (the required "当前任务"). */
  requirementTitle: string
  /** Optional requirement brief, bounded by {@link HANDOFF_BRIEF_MAX_CHARS}. */
  requirementBrief?: string
  /** Work already finished (the required "已完成工作项"); empty degrades to a minimal summary. */
  completedWorkItems?: readonly string[]
  /** Work that still needs to be done. */
  remainingWorkItems?: readonly string[]
  /** The session being left behind, for traceability. */
  previousSessionId?: string | null
  /** Hard cap on the returned text length; defaults to {@link HANDOFF_MAX_CHARS}. */
  maxChars?: number
}

function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars))
  return `${text.slice(0, maxChars - 1).trimEnd()}…`
}

function projectLabelOf(path: string, title: string | undefined): string {
  const clean = (title ?? '').trim()
  if (clean.length > 0) return clean
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').pop() ?? path
}

function cleanItems(items: readonly string[] | undefined): string[] {
  if (items === undefined) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const text = truncateChars(item.trim().replace(/\s+/g, ' '), HANDOFF_ITEM_MAX_CHARS)
    if (text.length === 0 || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= HANDOFF_MAX_ITEMS) break
  }
  return out
}

/**
 * Build the handoff summary prepended to a fresh session's first prompt when
 * compaction could not run. It always contains the three required elements —
 * target project, current task, completed work items — and degrades to a
 * minimal summary when no history is available. The result never exceeds
 * `maxChars` (default {@link HANDOFF_MAX_CHARS}) and never throws.
 */
export function buildHandoffSummary(input: HandoffSummaryInput): string {
  const maxChars = input.maxChars === undefined ? HANDOFF_MAX_CHARS : Math.max(0, Math.floor(input.maxChars))
  const projectLabel = projectLabelOf(input.projectPath, input.projectTitle)
  const brief = truncateChars((input.requirementBrief ?? '').trim(), HANDOFF_BRIEF_MAX_CHARS)
  const completed = cleanItems(input.completedWorkItems)
  const remaining = cleanItems(input.remainingWorkItems)

  const lines: string[] = [
    '# Handoff summary (fresh session)',
    'The previous session could not be compacted before dispatch, so this task continues in a new session. Re-read the recent work before changing anything.',
    '',
    `- Target project: ${projectLabel} (${input.projectPath})`,
    `- Current task: ${input.requirementTitle}`,
  ]
  if (brief.length > 0) lines.push(`- Current task detail: ${brief}`)
  if (completed.length > 0) {
    lines.push('- Completed work items:')
    for (const item of completed) lines.push(`  - ${item}`)
  } else {
    lines.push('- Completed work items: (none recorded yet; start from the current task)')
  }
  if (remaining.length > 0) {
    lines.push('- Remaining work items:')
    for (const item of remaining) lines.push(`  - ${item}`)
  }
  if (input.previousSessionId !== undefined && input.previousSessionId !== null && input.previousSessionId.length > 0) {
    lines.push(`- Previous session: ${input.previousSessionId}`)
  }
  return truncateChars(lines.join('\n'), maxChars)
}

/** Approximate one character span as tokens: CJK ~1 token/char, else ~4 chars/token. */
export function estimateTokensFromText(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    if (isCjkCodePoint(codePoint)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 4)
}

/** East-Asian wide / CJK ranges priced near one token per character. */
function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff)   // Hangul Jamo
    || (codePoint >= 0x2e80 && codePoint <= 0x2fff) // CJK radicals
    || (codePoint >= 0x3000 && codePoint <= 0x30ff) // CJK punctuation + kana
    || (codePoint >= 0x3400 && codePoint <= 0x4dbf) // CJK ext A
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff) // CJK unified
    || (codePoint >= 0xf900 && codePoint <= 0xfaff) // CJK compatibility
    || (codePoint >= 0xff00 && codePoint <= 0xffef) // full-width forms
    || (codePoint >= 0x20000 && codePoint <= 0x2fa1f) // CJK ext B-F
  )
}

const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

function textOfContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((block) => blockText(block)).filter((text) => text.length > 0).join('\n')
  }
  if (!isRecord(value)) return ''
  if (typeof value.text === 'string') return value.text
  if (typeof value.arguments === 'string') return value.arguments
  const blocks = value.content
  if (typeof blocks === 'string') return blocks
  if (Array.isArray(blocks)) {
    return blocks.map((block) => blockText(block)).filter((text) => text.length > 0).join('\n')
  }
  return ''
}

/** Text carried by one model content block (`text` or compact tool-call JSON). */
function blockText(block: unknown): string {
  if (!isRecord(block)) return ''
  if (typeof block.text === 'string') return block.text
  if (typeof block.arguments === 'string') return block.arguments
  return ''
}

/**
 * Estimate one session log's token weight with the fixed heuristic above. The
 * snapshot shape is the one `sessionQuery.readSession()` returns (`{ events }`);
 * unknown shapes return null so the caller can skip the compression branch.
 *
 * Error statement: this is an approximation, not a tokenizer. The 4-chars/token
 * rule underprices CJK when the character is not in the ranges above, JSON and
 * code (dense punctuation), and any command output trimmed by the caller's cap;
 * it overprices short id-heavy text. Use it only as a fallback when provider
 * usage is unavailable.
 */
export function estimateTokensFromSessionSnapshot(snapshot: unknown, maxChars = 2_000_000): number | null {
  if (!isRecord(snapshot)) return null
  const events = snapshot.events
  if (!Array.isArray(events)) return null
  let tokens = 0
  let budget = maxChars
  for (const event of events) {
    if (!isRecord(event) || typeof event.type !== 'string' || !SURFACE_EVENT_TYPES.has(event.type)) continue
    const data = isRecord(event.data) ? event.data : {}
    let text = ''
    if (data.message !== undefined) text += `${textOfContent(data.message)}\n`
    if (data.content !== undefined) text += `${textOfContent(data.content)}\n`
    if (text.length === 0) continue
    const slice = budget >= text.length ? text : text.slice(0, Math.max(0, budget))
    if (slice.length === 0) break
    tokens += estimateTokensFromText(slice)
    budget -= slice.length
    if (budget <= 0) break
  }
  return tokens
}
