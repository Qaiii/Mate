import { describe, expect, it } from 'vitest'
import {
  CONTEXT_COMPRESSION_LOG_PREFIX,
  CONTEXT_COMPRESSION_THRESHOLD_MAX,
  CONTEXT_COMPRESSION_THRESHOLD_MIN,
  DEFAULT_CONTEXT_COMPRESSION,
  HANDOFF_BRIEF_MAX_CHARS,
  HANDOFF_ITEM_MAX_CHARS,
  HANDOFF_MAX_CHARS,
  buildHandoffSummary,
  decideContextAction,
  defaultContextCompression,
  estimateTokensFromSessionSnapshot,
  estimateTokensFromText,
  formatContextDecisionLog,
  formatUsagePercent,
  occupancyPercent,
  resolveContextCompressionConfig,
  validateContextCompressionConfig,
  type ContextDecision,
  type ContextMeasurement,
} from './compression.js'

const providerMeasurement = (usedTokens: number, windowTokens: number | null): ContextMeasurement => ({
  usedTokens,
  windowTokens,
  source: 'provider',
})

function decisionOf(config: { enabled: boolean; threshold: number }, measurement: ContextMeasurement | null): ContextDecision {
  return decideContextAction({ config, measurement })
}

describe('context compression config', () => {
  it('defaults to disabled with an 80 percent threshold', () => {
    expect(DEFAULT_CONTEXT_COMPRESSION).toEqual({ enabled: false, threshold: 80 })
    expect(defaultContextCompression()).toEqual({ enabled: false, threshold: 80 })
    // A fresh copy, never the shared constant.
    const copy = defaultContextCompression()
    copy.enabled = true
    expect(DEFAULT_CONTEXT_COMPRESSION.enabled).toBe(false)
  })

  it('tolerates a missing or legacy section (backward compatibility)', () => {
    expect(resolveContextCompressionConfig(undefined)).toEqual({ enabled: false, threshold: 80 })
    expect(resolveContextCompressionConfig(null)).toEqual({ enabled: false, threshold: 80 })
    expect(resolveContextCompressionConfig('nope')).toEqual({ enabled: false, threshold: 80 })
    expect(resolveContextCompressionConfig({})).toEqual({ enabled: false, threshold: 80 })
    expect(resolveContextCompressionConfig({ enabled: 'yes', threshold: 0 })).toEqual({ enabled: false, threshold: 80 })
    expect(resolveContextCompressionConfig({ enabled: true, threshold: 65 })).toEqual({ enabled: true, threshold: 65 })
  })

  it('validates an untrusted settings payload strictly', () => {
    // Missing fields fall back to the documented defaults.
    expect(validateContextCompressionConfig({})).toEqual({ ok: true, value: { enabled: false, threshold: 80 } })
    expect(validateContextCompressionConfig({ enabled: true, threshold: 60 })).toEqual({
      ok: true,
      value: { enabled: true, threshold: 60 },
    })

    for (const threshold of [0, 101, -5, 80.5]) {
      const result = validateContextCompressionConfig({ enabled: true, threshold })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors[0]?.path).toBe('threshold')
    }
    const decimals = validateContextCompressionConfig({ enabled: true, threshold: 80.5 })
    expect(decimals.ok).toBe(false)
    if (!decimals.ok) expect(decimals.errors[0]?.code).toBe('threshold-integer')

    const range = validateContextCompressionConfig({ enabled: true, threshold: 0 })
    expect(range.ok).toBe(false)
    if (!range.ok) expect(range.errors[0]?.code).toBe('threshold-range')

    const nonNumber = validateContextCompressionConfig({ enabled: true, threshold: '80' })
    expect(nonNumber.ok).toBe(false)
    if (!nonNumber.ok) expect(nonNumber.errors[0]?.code).toBe('threshold')

    const badEnabled = validateContextCompressionConfig({ enabled: 'true', threshold: 80 })
    expect(badEnabled.ok).toBe(false)
    if (!badEnabled.ok) expect(badEnabled.errors[0]?.code).toBe('enabled')

    const shape = validateContextCompressionConfig(null)
    expect(shape.ok).toBe(false)
    if (!shape.ok) expect(shape.errors[0]?.code).toBe('shape')

    // Boundary values are valid.
    const min = validateContextCompressionConfig({ enabled: true, threshold: CONTEXT_COMPRESSION_THRESHOLD_MIN })
    const max = validateContextCompressionConfig({ enabled: true, threshold: CONTEXT_COMPRESSION_THRESHOLD_MAX })
    expect(min.ok).toBe(true)
    expect(max.ok).toBe(true)
  })
})

describe('occupancy decision', () => {
  it('compresses only when enabled and at or above the threshold', () => {
    const over = providerMeasurement(900, 1000)
    const under = providerMeasurement(500, 1000)

    expect(decisionOf({ enabled: true, threshold: 80 }, over)).toMatchObject({
      action: 'compress',
      reason: 'threshold-reached',
      usagePercent: 90,
      threshold: 80,
    })
    expect(decisionOf({ enabled: true, threshold: 80 }, under)).toMatchObject({
      action: 'none',
      reason: 'below-threshold',
      usagePercent: 50,
    })
    // The disabled switch wins over the measurement.
    expect(decisionOf({ enabled: false, threshold: 80 }, over)).toMatchObject({
      action: 'none',
      reason: 'disabled',
    })
    expect(decisionOf({ enabled: false, threshold: 80 }, under)).toMatchObject({
      action: 'none',
      reason: 'disabled',
    })
    // Exactly at the threshold triggers (>= semantics).
    expect(decisionOf({ enabled: true, threshold: 80 }, providerMeasurement(800, 1000)).action).toBe('compress')
    // A custom manual threshold changes the boundary.
    expect(decisionOf({ enabled: true, threshold: 95 }, over).action).toBe('none')
    expect(decisionOf({ enabled: true, threshold: 65 }, providerMeasurement(650, 1000)).action).toBe('compress')
  })

  it('keeps the original path when the sample or the window is unknown', () => {
    expect(decisionOf({ enabled: true, threshold: 80 }, null)).toMatchObject({
      action: 'none',
      reason: 'measurement-unavailable',
      usagePercent: null,
    })
    expect(decisionOf({ enabled: true, threshold: 80 }, providerMeasurement(900, null))).toMatchObject({
      action: 'none',
      reason: 'window-unknown',
    })
    expect(occupancyPercent(900, 0)).toBe(0)
  })
})

describe('decision log line', () => {
  it('carries trigger reason, threshold, actual occupancy and final strategy', () => {
    const decision = decisionOf({ enabled: true, threshold: 80 }, providerMeasurement(900, 1000))
    const compress = formatContextDecisionLog({ decision, strategy: 'compress', sessionId: 'session-1', requirementNumber: 17 })
    expect(compress.startsWith(CONTEXT_COMPRESSION_LOG_PREFIX)).toBe(true)
    expect(compress).toContain('reason=threshold-reached')
    expect(compress).toContain('threshold=80%')
    expect(compress).toContain('usage=90.0%')
    expect(compress).toContain('tokens=900/1000')
    expect(compress).toContain('strategy=compress')
    expect(compress).toContain('session=session-1')
    expect(compress).toContain('req=#17')

    const fallback = formatContextDecisionLog({
      decision,
      strategy: 'new-session',
      sessionId: 'session-1',
      failure: 'busy',
    })
    expect(fallback).toContain('reason=threshold-reached')
    expect(fallback).toContain('threshold=80%')
    expect(fallback).toContain('usage=90.0%')
    expect(fallback).toContain('strategy=new-session')
    expect(fallback).toContain('failure=busy')

    const unknown = formatContextDecisionLog({
      decision: decisionOf({ enabled: true, threshold: 80 }, null),
      strategy: 'none',
    })
    expect(unknown).toContain('reason=measurement-unavailable')
    expect(unknown).toContain('usage=unknown%')
    expect(unknown).toContain('strategy=none')
  })

  it('formats percentages with one decimal or unknown', () => {
    expect(formatUsagePercent(87.34)).toBe('87.3')
    expect(formatUsagePercent(null)).toBe('unknown')
    expect(formatUsagePercent(Number.NaN)).toBe('unknown')
  })
})

describe('handoff summary', () => {
  it('carries the three required elements', () => {
    const summary = buildHandoffSummary({
      projectPath: 'D:\\repo\\Mate',
      projectTitle: 'Mate',
      requirementTitle: '派发前上下文压缩与回退',
      requirementBrief: '启用上下文压缩',
      completedWorkItems: ['调用链梳理', '配置项落盘'],
      remainingWorkItems: ['设置界面'],
      previousSessionId: 'session-old',
    })
    expect(summary).toContain('Target project: Mate (D:\\repo\\Mate)')
    expect(summary).toContain('Current task: 派发前上下文压缩与回退')
    expect(summary).toContain('Completed work items:')
    expect(summary).toContain('- 调用链梳理')
    expect(summary).toContain('- 配置项落盘')
    expect(summary).toContain('Remaining work items:')
    expect(summary).toContain('Previous session: session-old')
    expect(summary.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS)
  })

  it('degrades to a minimal summary without history', () => {
    const summary = buildHandoffSummary({
      projectPath: 'D:\\repo',
      requirementTitle: 'Only a title',
    })
    expect(summary).toContain('Target project: repo (D:\\repo)')
    expect(summary).toContain('Current task: Only a title')
    expect(summary).toContain('Completed work items: (none recorded yet; start from the current task)')
    expect(summary).not.toContain('Remaining work items:')
  })

  it('bounds the summary length and per-field copy', () => {
    const longBrief = 'brief '.repeat(500)
    const longItem = 'item '.repeat(500)
    const summary = buildHandoffSummary({
      projectPath: 'D:\\repo',
      projectTitle: 'Repo',
      requirementTitle: 'T',
      requirementBrief: longBrief,
      completedWorkItems: [longItem, longItem, ...Array.from({ length: 40 }, (_, index) => `done ${index}`)],
      maxChars: 900,
    })
    expect(summary.length).toBeLessThanOrEqual(900)
    // The brief is truncated before it is embedded.
    expect(summary).not.toContain(longBrief.slice(0, HANDOFF_BRIEF_MAX_CHARS + 50))
    expect(summary.indexOf('\n')).toBeGreaterThan(-1)
    // One over-long item is truncated to the per-item cap.
    const firstItemLine = summary.split('\n').find((line) => line.trimStart().startsWith('- item'))
    expect(firstItemLine).toBeDefined()
    expect((firstItemLine ?? '').trim().length).toBeLessThanOrEqual(HANDOFF_ITEM_MAX_CHARS + 2)
  })

  it('never throws on odd values and de-duplicates work items', () => {
    const summary = buildHandoffSummary({
      projectPath: '',
      requirementTitle: '',
      completedWorkItems: ['same', 'same', '  ', 12 as unknown as string],
      maxChars: 0,
    })
    expect(typeof summary).toBe('string')
    expect(summary.length).toBe(0)
    const deduped = buildHandoffSummary({
      projectPath: 'D:\\repo',
      requirementTitle: 'T',
      completedWorkItems: ['same', 'same', ' other '],
    })
    expect(deduped.match(/- same/g)?.length).toBe(1)
    expect(deduped).toContain('- other')
  })
})

describe('token estimate fallback', () => {
  it('prices CJK near one token per character and ASCII near four chars per token', () => {
    expect(estimateTokensFromText('abcdefgh')).toBe(2)
    expect(estimateTokensFromText('中文四个字')).toBe(5)
    expect(estimateTokensFromText('')).toBe(0)
  })

  it('estimates a session snapshot and rejects unknown shapes', () => {
    const snapshot = {
      events: [
        { type: 'session', data: {} },
        { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] } } },
        { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '你好世界' }] } } },
        { type: 'tool/result', data: { content: [{ type: 'text', text: 'tool output' }] } },
      ],
    }
    const tokens = estimateTokensFromSessionSnapshot(snapshot)
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBe(estimateTokensFromText('hello world\n') + estimateTokensFromText('你好世界\n') + estimateTokensFromText('tool output\n'))
    expect(estimateTokensFromSessionSnapshot(undefined)).toBeNull()
    expect(estimateTokensFromSessionSnapshot({})).toBeNull()
    expect(estimateTokensFromSessionSnapshot({ events: 'nope' })).toBeNull()
    expect(estimateTokensFromSessionSnapshot({ events: [] })).toBe(0)
  })
})
