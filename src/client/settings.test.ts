import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ContextCompressionConfig, RequirementView, ScheduleConfig, Snapshot } from '../shared.js'
import { SettingsDialog, validateContextCompressionDraft } from './dialogs.js'
import { createTranslator } from './locales.js'
import { formatCountdown, queueDetail, queueHint } from './types.js'

function snapshotWith(
  schedule: ScheduleConfig,
  timezone: { id: string; source: 'manual' | 'client' | 'host' } = {
    id: 'Asia/Shanghai',
    source: 'client',
  },
  contextCompression: ContextCompressionConfig = { enabled: false, threshold: 80 },
): Snapshot {
  return {
    rev: 7,
    mates: [],
    requirements: [],
    projects: [],
    liveSessions: [],
    settings: {
      defaultMateId: null,
      pollMs: 2500,
      reuseIdleSession: false,
      version: '0.1.0',
      lastStartedAt: 0,
      lastProjectPath: null,
      modelCatalog: [
        { provider: 'alpha', name: 'Alpha', models: [{ id: 'm1', name: 'M One' }, { id: 'm2', name: 'M Two' }] },
      ],
      schedule,
      timezone,
      contextCompression,
    },
    serverTime: 0,
  }
}

function renderSettings(snapshot: Snapshot, lang: 'zh' | 'en' = 'zh'): string {
  return renderToStaticMarkup(
    React.createElement(SettingsDialog, {
      snapshot,
      t: createTranslator(lang),
      busy: false,
      onClose: (): void => { /* noop in SSR */ },
      onSubmit: (): void => { /* noop in SSR */ },
      onTest: (): void => { /* noop in SSR */ },
      onRestoreHidden: (): void => { /* noop in SSR */ },
    }),
  )
}

/** The rendered `<input type="checkbox">` whose `aria-label` is `label`. */
function checkboxWithAria(markup: string, label: string): string {
  const tags = [...markup.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) => match[0] ?? '')
  return tags.find((tag) => tag.includes(`aria-label="${label}"`)) ?? ''
}

const windowed: ScheduleConfig = {
  models: [
    { provider: 'alpha', model: 'm1', disabledWindows: [{ kind: 'weekday', start: '22:00', end: '06:00' }] },
    { provider: 'alpha', model: 'm2', disabledWindows: [] },
  ],
  holidays: ['2026-10-01', '2026-01-01'],
  workdays: [],
  useBuiltinHolidays: true,
  timezone: null,
}

/** A schedule that never blocks; keeps the compression tests focused. */
const emptySchedule: ScheduleConfig = {
  models: [],
  holidays: [],
  workdays: [],
  useBuiltinHolidays: true,
  timezone: null,
}

describe('SettingsDialog scheduling sections', () => {
  it('shows the effective zone, its source and the override field', () => {
    const markup = renderSettings(snapshotWith(windowed))
    expect(markup).toContain('生效时区')
    expect(markup).toContain('Asia/Shanghai')
    expect(markup).toContain('DSH 客户端')
    expect(markup).toContain('手动覆盖（IANA 时区）')
  })

  it('renders each configured model with its windows and time inputs', () => {
    const markup = renderSettings(snapshotWith(windowed))
    expect(markup).toContain('alpha / m1')
    expect(markup).toContain('alpha / m2')
    expect(markup).toContain('工作日')
    expect(markup).toContain('value="22:00"')
    expect(markup).toContain('value="06:00"')
    // A model entry with no windows is always available; the empty config state
    // uses the same copy.
    expect(markup).toContain('全天可用')
    expect(markup).toMatch(/当前(可用|禁用)/)
  })

  it('shows both versions of the always-available copy for an empty schedule', () => {
    const markup = renderSettings(snapshotWith(emptySchedule))
    expect(markup).toContain('还没有配置模型时段')
    expect(markup).toContain('全天可用')
    const en = renderSettings(snapshotWith(emptySchedule), 'en')
    expect(en).toContain('Always available')
    expect(en).toContain('No model windows configured')
  })

  it('lists holidays grouped by year with per-year and per-date delete controls', () => {
    const markup = renderSettings(snapshotWith(windowed))
    expect(markup).toContain('节假日')
    expect(markup).toContain('2026-01-01')
    expect(markup).toContain('2026-10-01')
    expect(markup).toContain('删除 2026 年')
    expect(markup).toContain('删除 2026-01-01')
    expect(markup).toContain('按年份批量')
  })

  it('renders the built-in holiday toggle checked by default', () => {
    const markup = renderSettings(snapshotWith(emptySchedule))
    expect(markup).toContain('启用内置中国法定节假日（含调休）')
    expect(markup).toContain('内置数据按年份覆盖')
    expect(checkboxWithAria(markup, '启用内置中国法定节假日（含调休）')).toContain('checked=""')

    const off = renderSettings(snapshotWith({ ...emptySchedule, useBuiltinHolidays: false }))
    expect(checkboxWithAria(off, '启用内置中国法定节假日（含调休）')).not.toContain('checked')

    const en = renderSettings(snapshotWith(emptySchedule), 'en')
    expect(en).toContain('Use built-in Chinese statutory holidays (incl. makeup workdays)')
  })

  it('offers the makeup-workday editor with grouped per-year/per-date delete controls', () => {
    const markup = renderSettings(snapshotWith({ ...windowed, workdays: ['2026-02-14', '2026-10-10'] }))
    expect(markup).toContain('调休上班日')
    expect(markup).toContain('调休上班日按工作日判定')
    expect(markup).toContain('2026-02-14')
    expect(markup).toContain('2026-10-10')
    expect(markup).toContain('删除 2026-02-14')
    expect(markup).toContain('删除 2026 年')
    const en = renderSettings(snapshotWith({ ...windowed, workdays: ['2026-02-14'] }), 'en')
    expect(en).toContain('Makeup workdays')
    expect(en).toContain('Delete 2026-02-14')
  })

  it('blocks saving with a localized error for an invalid makeup workday', () => {
    const markup = renderSettings(snapshotWith({ ...windowed, workdays: ['2026-02-30'] }))
    expect(markup).toContain('调休上班日应为 YYYY-MM-DD 且真实存在')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>保存<\/button>/)
  })

  it('localizes the new schedule validation codes', () => {
    const zh = createTranslator('zh')
    expect(zh('schedule.err.workday-format')).toContain('调休上班日')
    expect(zh('schedule.err.holiday-toggle')).toContain('内置节假日开关')
    const en = createTranslator('en')
    expect(en('schedule.err.workday-format')).toContain('Makeup workday')
    expect(en('schedule.err.holiday-toggle')).toContain('built-in holidays toggle')
  })

  it('blocks saving with a localized error for a zero-length window', () => {
    const markup = renderSettings(snapshotWith({
      models: [{ provider: 'alpha', model: 'm1', disabledWindows: [{ kind: 'weekday', start: '22:00', end: '22:00' }] }],
      holidays: [],
      workdays: [],
      useBuiltinHolidays: true,
      timezone: null,
    }))
    expect(markup).toContain('开始时间和结束时间不能相同')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>保存<\/button>/)
  })

  it('blocks saving and explains an invalid manual time zone', () => {
    const markup = renderSettings(snapshotWith({
      models: [],
      holidays: [],
      workdays: [],
      useBuiltinHolidays: true,
      timezone: 'Not/AZone',
    }))
    expect(markup).toContain('无效的 IANA 时区')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>保存<\/button>/)
  })

  it('allows saving a valid empty schedule', () => {
    const markup = renderSettings(snapshotWith(emptySchedule))
    expect(markup).toMatch(/<button[^>]*>保存<\/button>/)
  })
})

describe('SettingsDialog context compression section', () => {
  it('renders the section with a locked threshold input while compression is off', () => {
    const markup = renderSettings(snapshotWith(emptySchedule))
    expect(markup).toContain('上下文压缩')
    expect(markup).toContain('启用上下文压缩')
    expect(markup).toContain('阈值（%）')
    expect(markup).toContain('当派发要复用的会话上下文占用 ≥ 阈值时，先压缩')
    // Default policy: disabled, threshold 80, and the threshold cannot be edited.
    expect(checkboxWithAria(markup, '启用上下文压缩')).not.toContain('checked')
    expect(markup).toMatch(/<input[^>]*type="number"[^>]*disabled=""[^>]*value="80"/)

    const en = renderSettings(snapshotWith(emptySchedule), 'en')
    expect(en).toContain('Context compression')
    expect(en).toContain('Enable context compression')
    expect(en).toContain('Threshold (%)')
  })

  it('renders the saved values with an editable threshold when compression is on', () => {
    const markup = renderSettings(snapshotWith(emptySchedule, undefined, { enabled: true, threshold: 42 }))
    expect(checkboxWithAria(markup, '启用上下文压缩')).toContain('checked=""')
    const threshold = markup.match(/<input[^>]*type="number"[^>]*>/)?.[0] ?? ''
    expect(threshold).toContain('value="42"')
    expect(threshold).not.toContain('disabled')
  })

  it('tolerates a pre-feature Host snapshot without the compression block', () => {
    const snapshot = snapshotWith(emptySchedule)
    const legacy = {
      ...snapshot,
      settings: { ...snapshot.settings, contextCompression: undefined },
    } as unknown as Snapshot
    const markup = renderSettings(legacy)
    expect(markup).toContain('启用上下文压缩')
    expect(markup).toMatch(/<input[^>]*type="number"[^>]*disabled=""[^>]*value="80"/)
    expect(markup).toMatch(/<button[^>]*>保存<\/button>/)
  })

  it('shows a localized error and keeps Save disabled for an out-of-range value from the Host', () => {
    const markup = renderSettings(snapshotWith(emptySchedule, undefined, { enabled: true, threshold: 0 }))
    expect(markup).toContain('阈值必须在 1 到 100 之间')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>保存<\/button>/)
    const en = renderSettings(snapshotWith(emptySchedule, undefined, { enabled: true, threshold: 0 }), 'en')
    expect(en).toContain('The threshold must be between 1 and 100')
  })
})

describe('validateContextCompressionDraft', () => {
  it('accepts integers in 1..100 and trims surrounding whitespace', () => {
    expect(validateContextCompressionDraft({ enabled: true, threshold: ' 80 ' }))
      .toEqual({ ok: true, value: { enabled: true, threshold: 80 } })
    expect(validateContextCompressionDraft({ enabled: false, threshold: '1' }))
      .toEqual({ ok: true, value: { enabled: false, threshold: 1 } })
    expect(validateContextCompressionDraft({ enabled: true, threshold: '100' }))
      .toEqual({ ok: true, value: { enabled: true, threshold: 100 } })
  })

  it('rejects empty, non-numeric, decimal and out-of-range input', () => {
    expect(validateContextCompressionDraft({ enabled: true, threshold: '' }))
      .toEqual({ ok: false, error: 'number' })
    expect(validateContextCompressionDraft({ enabled: true, threshold: '   ' }))
      .toEqual({ ok: false, error: 'number' })
    expect(validateContextCompressionDraft({ enabled: true, threshold: 'abc' }))
      .toEqual({ ok: false, error: 'number' })
    expect(validateContextCompressionDraft({ enabled: true, threshold: '80.5' }))
      .toEqual({ ok: false, error: 'integer' })
    expect(validateContextCompressionDraft({ enabled: true, threshold: '0' }))
      .toEqual({ ok: false, error: 'range' })
    expect(validateContextCompressionDraft({ enabled: true, threshold: '101' }))
      .toEqual({ ok: false, error: 'range' })
  })
})

describe('queued requirement hints', () => {
  function queuedRequirement(overrides: Partial<RequirementView> = {}): RequirementView {
    return {
      id: 'req_1',
      number: 1,
      title: 'Ship it',
      brief: '',
      projectPath: '',
      projectTitle: '',
      priority: 'normal',
      mateId: 'mate_1',
      mateName: 'Mate',
      mateModel: 'alpha / m1',
      parentId: null,
      kind: 'requirement',
      status: 'queued',
      autonomy: 'auto',
      sessionOverrides: null,
      discussion: [],
      analysis: null,
      plan: null,
      dispatch: null,
      result: null,
      errors: [],
      queue: {
        phase: 'analyze',
        reason: 'model-window',
        model: null,
        window: 'weekday 22:00-06:00',
        enqueuedAt: 0,
        nextWakeAt: 0,
        timezone: 'Asia/Shanghai',
        attempts: 0,
      },
      createdAt: 0,
      updatedAt: 0,
      rev: 1,
      ...overrides,
    }
  }

  it('formats a future countdown compactly', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0)
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      expect(formatCountdown(now + 2 * 3_600_000 + 5 * 60_000, 'zh')).toBe('2 小时 5 分钟')
      expect(formatCountdown(now + 90_000, 'zh')).toBe('2 分钟')
      expect(formatCountdown(now + 90_000, 'en')).toBe('2m')
    } finally {
      spy.mockRestore()
    }
  })

  it('shows the expected start clock in the effective scheduling zone', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0)
    const nextWakeAt = now + 2 * 3_600_000 + 5 * 60_000 // 2026-01-01 10:05 in Asia/Shanghai
    const hint = queueHint(
      queuedRequirement({ queue: { ...queuedRequirement().queue!, nextWakeAt } }),
      createTranslator('zh'),
      'zh',
      'Asia/Shanghai',
    )
    expect(hint).toBe('排队等待 · 预计 10:05 开始')
    const en = queueHint(
      queuedRequirement({ queue: { ...queuedRequirement().queue!, nextWakeAt } }),
      createTranslator('en'),
      'en',
      'Asia/Shanghai',
    )
    expect(en).toBe('Queued · starts ~10:05')
  })

  it('falls back to the queue entry zone when no effective zone is passed', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0)
    const hint = queueHint(
      queuedRequirement({ queue: { ...queuedRequirement().queue!, nextWakeAt: now + 90_000 } }),
      createTranslator('zh'),
      'zh',
    )
    expect(hint).toBe('排队等待 · 预计 08:01 开始')
  })

  it('still renders a badge when the queue entry is missing or unknown', () => {
    const zh = createTranslator('zh')
    expect(queueHint(queuedRequirement({ queue: null }), zh, 'zh')).toBe('等待模型时段')
    expect(queueHint(queuedRequirement({ status: 'running', queue: null }), zh, 'zh')).toBeNull()
  })

  it('describes phase, window, wake time, zone and retries', () => {
    const queue = queuedRequirement().queue!
    const detail = queueDetail({ ...queue, nextWakeAt: 0, attempts: 3 }, createTranslator('zh'), 'zh')
    expect(detail).toContain('分析')
    expect(detail).toContain('weekday 22:00-06:00')
    expect(detail).toContain('Asia/Shanghai')
    expect(detail).toContain('已重试 3 次')
  })
})
