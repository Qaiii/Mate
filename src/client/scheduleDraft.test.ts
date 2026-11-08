import { describe, expect, it } from 'vitest'
import type { ScheduleConfig } from '../shared.js'
import { createTranslator } from './locales.js'
import {
  catalogAvailability,
  cloneSchedule,
  emptyScheduleDraft,
  expandHolidayRange,
  expandYearHolidays,
  formatZonedClock,
  groupHolidays,
  isRealDateKey,
  issueMessage,
  issuesFor,
  mergeHolidays,
  parseHolidayYear,
  removeHolidayDates,
  removeHolidayYear,
  toggleWeekday,
  tryResolveHolidayCalendar,
  windowKindChoice,
  withWindowKind,
} from './scheduleDraft.js'

describe('holiday range expansion', () => {
  it('includes both ends and crosses month/year boundaries', () => {
    expect(expandHolidayRange('2026-01-30', '2026-02-02')).toEqual({
      dates: ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02'],
      error: null,
    })
    expect(expandHolidayRange('2026-12-31', '2027-01-01').dates).toEqual(['2026-12-31', '2027-01-01'])
  })

  it('handles leap days and rejects impossible dates', () => {
    expect(expandHolidayRange('2028-02-28', '2028-03-01').dates).toEqual(['2028-02-28', '2028-02-29', '2028-03-01'])
    expect(expandHolidayRange('2026-02-29', '2026-03-01')).toEqual({ dates: [], error: 'invalid' })
    expect(isRealDateKey('2026-13-01')).toBe(false)
    expect(isRealDateKey('2026-00-10')).toBe(false)
  })

  it('reports a reversed or over-long range instead of expanding it', () => {
    expect(expandHolidayRange('2026-05-02', '2026-05-01')).toEqual({ dates: [], error: 'invalid' })
    expect(expandHolidayRange('1000-01-01', '9999-12-31')).toEqual({ dates: [], error: 'too-long' })
  })

  it('returns one day when both ends match', () => {
    expect(expandHolidayRange('2026-10-01', '2026-10-01')).toEqual({ dates: ['2026-10-01'], error: null })
  })
})

describe('bulk year expansion', () => {
  it('pads month/day tokens and splits on mixed separators', () => {
    expect(expandYearHolidays('2026', '1-1, 05-01 10-1\n12-31')).toEqual({
      dates: ['2026-01-01', '2026-05-01', '2026-10-01', '2026-12-31'],
      invalid: [],
    })
  })

  it('lists invalid tokens separately and keeps the valid ones', () => {
    expect(expandYearHolidays('2026', '02-30, 13-01, nope, 01-02')).toEqual({
      dates: ['2026-01-02'],
      invalid: ['02-30', '13-01', 'nope'],
    })
  })

  it('rejects a bad year and reports the tokens', () => {
    expect(parseHolidayYear('26')).toBeNull()
    expect(parseHolidayYear(' 2026 ')).toBe(2026)
    expect(expandYearHolidays('26', '01-01')).toEqual({ dates: [], invalid: ['01-01'] })
  })
})

describe('holiday list maintenance', () => {
  it('merges, de-duplicates and sorts ascending', () => {
    expect(mergeHolidays(['2026-10-01', '2026-05-01'], ['2026-01-01', '2026-10-01']))
      .toEqual(['2026-01-01', '2026-05-01', '2026-10-01'])
  })

  it('drops entries that are not real calendar dates', () => {
    expect(mergeHolidays([], ['2026-02-30', '2026-02-28'])).toEqual(['2026-02-28'])
  })

  it('deletes single dates and whole years', () => {
    expect(removeHolidayDates(['2026-01-01', '2026-01-02'], ['2026-01-01'])).toEqual(['2026-01-02'])
    expect(removeHolidayYear(['2026-01-01', '2027-01-01', '2026-12-31'], '2026')).toEqual(['2027-01-01'])
  })

  it('groups by year in ascending order', () => {
    expect(groupHolidays(['2027-01-02', '2026-10-01', '2026-01-01'])).toEqual([
      { year: '2026', dates: ['2026-01-01', '2026-10-01'] },
      { year: '2027', dates: ['2027-01-02'] },
    ])
  })
})

describe('window kind editing', () => {
  it('maps stored kinds onto selector choices', () => {
    expect(windowKindChoice('weekday')).toBe('weekday')
    expect(windowKindChoice('weekend')).toBe('weekend')
    expect(windowKindChoice('holiday')).toBe('holiday')
    expect(windowKindChoice(['mon', 'wed'])).toBe('weekdays')
  })

  it('seeds an implied weekday list when switching to specific days', () => {
    const window = { kind: 'weekday' as const, start: '22:00', end: '06:00' }
    expect(withWindowKind(window, 'weekdays')).toEqual({
      kind: ['mon', 'tue', 'wed', 'thu', 'fri'],
      start: '22:00',
      end: '06:00',
    })
    expect(withWindowKind({ kind: 'weekend', start: '00:00', end: '12:00' }, 'weekdays').kind)
      .toEqual(['sat', 'sun'])
  })

  it('keeps explicit weekdays in ISO order and allows an empty selection', () => {
    const window = { kind: ['mon'] as Array<'mon' | 'tue'>, start: '09:00', end: '10:00' }
    const withWed = toggleWeekday({ ...window, kind: ['mon', 'tue'] }, 'wed')
    expect(withWed.kind).toEqual(['mon', 'tue', 'wed'])
    expect(toggleWeekday({ ...window, kind: ['mon'] }, 'mon').kind).toEqual([])
  })

  it('does not mutate the edited window', () => {
    const window = { kind: 'weekday' as const, start: '22:00', end: '06:00' }
    withWindowKind(window, 'weekend')
    expect(window.kind).toBe('weekday')
  })
})

describe('draft cloning', () => {
  it('deep-copies so editing cannot mutate the snapshot', () => {
    const source: ScheduleConfig = {
      models: [{ provider: 'p', model: 'm', disabledWindows: [{ kind: ['mon'], start: '22:00', end: '06:00' }] }],
      holidays: ['2026-01-01'],
      workdays: ['2026-01-04'],
      useBuiltinHolidays: false,
      timezone: 'Asia/Shanghai',
    }
    const copy = cloneSchedule(source)
    const kind = copy.models[0]?.disabledWindows[0]?.kind
    if (Array.isArray(kind)) kind.push('tue')
    copy.holidays.push('2026-02-01')
    copy.workdays.push('2026-02-08')
    expect(source.models[0]?.disabledWindows[0]?.kind).toEqual(['mon'])
    expect(source.holidays).toEqual(['2026-01-01'])
    expect(source.workdays).toEqual(['2026-01-04'])
    expect(copy.useBuiltinHolidays).toBe(false)
  })

  it('tolerates a missing schedule from an older Host', () => {
    expect(cloneSchedule(undefined)).toEqual(emptyScheduleDraft())
  })

  it('fills the new fields for a pre-feature schedule', () => {
    const legacy = { models: [], holidays: ['2026-01-01'], timezone: null } as unknown as ScheduleConfig
    const copy = cloneSchedule(legacy)
    expect(copy.workdays).toEqual([])
    // The built-in statutory-holiday data is on unless the snapshot says otherwise.
    expect(copy.useBuiltinHolidays).toBe(true)
  })
})

describe('formatZonedClock', () => {
  it('formats the instant in the scheduling zone with a 24h clock', () => {
    // 2026-01-01T16:30Z is 2026-01-02 00:30 in Shanghai (UTC+8).
    expect(formatZonedClock(Date.UTC(2026, 0, 1, 16, 30), 'Asia/Shanghai')).toBe('00:30')
    expect(formatZonedClock(Date.UTC(2026, 0, 1, 16, 30), 'UTC')).toBe('16:30')
    expect(formatZonedClock(Date.UTC(2026, 0, 1, 0, 5), 'Asia/Shanghai', 'zh')).toBe('08:05')
  })

  it('returns an empty string for an unusable timestamp', () => {
    expect(formatZonedClock(0, 'Asia/Shanghai')).toBe('')
    expect(formatZonedClock(-1, 'UTC')).toBe('')
    expect(formatZonedClock(Number.NaN, 'UTC')).toBe('')
  })

  it('falls back gracefully for an unknown zone instead of throwing', () => {
    expect(formatZonedClock(Date.UTC(2026, 0, 1, 16, 30), 'Not/AZone')).toMatch(/^\d{2}:\d{2}$/)
    expect(formatZonedClock(Date.UTC(2026, 0, 1, 16, 30), '')).toMatch(/^\d{2}:\d{2}$/)
  })
})

describe('catalog availability summary', () => {
  const catalog = [{ provider: 'alpha', models: [{ id: 'm1' }, { id: 'm2' }] }]

  it('returns null with nothing to judge', () => {
    expect(catalogAvailability({ nowMs: 1, schedule: emptyScheduleDraft(), catalog: [], timezone: 'UTC' })).toBeNull()
    expect(catalogAvailability({
      nowMs: 0,
      schedule: emptyScheduleDraft(),
      catalog,
      timezone: 'UTC',
    })).toBeNull()
  })

  it('counts available routes and the unknown state is silent', () => {
    const summary = catalogAvailability({ nowMs: 1, schedule: emptyScheduleDraft(), catalog, timezone: 'UTC' })
    expect(summary).toEqual({ total: 2, available: 2, earliestStart: null })
  })

  it('reports the earliest next start when every route is blocked', () => {
    const nowMs = Date.UTC(2026, 9, 1, 4, 0) // 2026-10-01 12:00 Asia/Shanghai, a built-in holiday
    // Two holiday windows cover the whole day (00:00-23:59 leaves 23:59 open).
    const holidayWindows = [
      { kind: 'holiday' as const, start: '00:00', end: '23:59' },
      { kind: 'holiday' as const, start: '23:59', end: '00:00' },
    ]
    const schedule: ScheduleConfig = {
      models: ['m1', 'm2'].map((model) => ({ provider: 'alpha', model, disabledWindows: holidayWindows })),
      holidays: [],
      workdays: [],
      useBuiltinHolidays: true,
      timezone: null,
    }
    const summary = catalogAvailability({ nowMs, schedule, catalog, timezone: 'Asia/Shanghai' })
    // Built-in holidays end 2026-10-07, so the first available minute is
    // 2026-10-08 00:00 Shanghai = 2026-10-07T16:00Z.
    expect(summary).toEqual({
      total: 2,
      available: 0,
      earliestStart: Date.UTC(2026, 9, 7, 16, 0),
    })
  })

  it('applies the manual makeup-workday override on a weekend', () => {
    const nowMs = Date.UTC(2026, 9, 10, 4, 0) // 2026-10-10 12:00 Asia/Shanghai (Saturday, a 调休 workday)
    const schedule: ScheduleConfig = {
      models: [{
        provider: 'alpha',
        model: 'm1',
        disabledWindows: [{ kind: 'weekend', start: '00:00', end: '23:59' }],
      }],
      holidays: [],
      workdays: [],
      useBuiltinHolidays: true,
      timezone: null,
    }
    const calendar = tryResolveHolidayCalendar(schedule)
    expect(calendar).not.toBeNull()
    // The built-in 调休 data turns this Saturday into a working day, so the
    // weekend window does not block it.
    expect(calendar?.workdays.has('2026-10-10')).toBe(true)
    const summary = catalogAvailability({ nowMs, schedule, catalog: [{ provider: 'alpha', models: [{ id: 'm1' }] }], timezone: 'Asia/Shanghai' })
    expect(summary).toEqual({ total: 1, available: 1, earliestStart: null })

    // With the built-in data off it is an ordinary blocked weekend.
    const weekendOnly = catalogAvailability({
      nowMs,
      schedule: { ...schedule, useBuiltinHolidays: false },
      catalog: [{ provider: 'alpha', models: [{ id: 'm1' }] }],
      timezone: 'Asia/Shanghai',
    })
    expect(weekendOnly?.available).toBe(0)
    expect(weekendOnly?.earliestStart).not.toBeNull()
  })
})

describe('validation error copy', () => {
  const issues = [
    { code: 'time-format' as const, path: 'models[0].disabledWindows[1].start', message: 'raw message' },
    { code: 'overlap' as const, path: 'models[0]', message: 'raw overlap' },
  ]

  it('selects issues by dotted path prefix', () => {
    expect(issuesFor(issues, 'models[0].disabledWindows[1]')).toHaveLength(1)
    expect(issuesFor(issues, 'models[0]')).toHaveLength(2)
    expect(issuesFor(issues, 'models[1]')).toHaveLength(0)
    expect(issuesFor(issues, '')).toHaveLength(2)
  })

  it('prefers localized copy and falls back to the validator message', () => {
    const zh = createTranslator('zh')
    expect(issueMessage(zh, issues[0]!)).toBe('时间格式应为 HH:mm')
    expect(issueMessage(zh, { code: 'shape', path: '', message: 'boom' })).toBe('配置格式不正确')
    const en = createTranslator('en')
    expect(issueMessage(en, issues[1]!)).toBe('Windows of the same model must not overlap')
    expect(issueMessage(en, { code: 'unknown-code' as never, path: '', message: 'fallback' })).toBe('fallback')
  })
})
