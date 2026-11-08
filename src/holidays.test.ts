import { describe, expect, it } from 'vitest'
import {
  BUILTIN_HOLIDAY_DATA,
  BUILTIN_HOLIDAY_YEARS,
  defaultHolidayData,
  resolveHolidayCalendar,
} from './holidays.js'
import type { ScheduleConfig } from './shared.js'

function configOf(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    models: [],
    holidays: [],
    workdays: [],
    useBuiltinHolidays: true,
    timezone: null,
    ...overrides,
  }
}

describe('built-in China holiday data', () => {
  it('covers 2024-2026', () => {
    expect(BUILTIN_HOLIDAY_YEARS).toEqual([2024, 2025, 2026])
    expect(Object.keys(BUILTIN_HOLIDAY_DATA.years).sort()).toEqual(['2024', '2025', '2026'])
    expect(BUILTIN_HOLIDAY_DATA.source).toBe('builtin-cn')
  })

  it('carries the official 2025 notice dates (国庆中秋 + 调休)', () => {
    const year = BUILTIN_HOLIDAY_DATA.years['2025']
    expect(year).toBeDefined()
    for (const date of ['2025-10-01', '2025-10-08', '2025-01-28', '2025-02-04', '2025-05-31']) {
      expect(year!.holidays).toContain(date)
    }
    for (const date of ['2025-09-28', '2025-10-11', '2025-01-26', '2025-02-08', '2025-04-27']) {
      expect(year!.workdays).toContain(date)
    }
  })

  it('carries the official 2026 notice dates', () => {
    const year = BUILTIN_HOLIDAY_DATA.years['2026']
    expect(year).toBeDefined()
    for (const date of ['2026-01-01', '2026-02-15', '2026-02-23', '2026-10-01', '2026-10-07']) {
      expect(year!.holidays).toContain(date)
    }
    for (const date of ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']) {
      expect(year!.workdays).toContain(date)
    }
  })

  it('is a complete, duplicate-free dataset', () => {
    for (const [yearKey, year] of Object.entries(BUILTIN_HOLIDAY_DATA.years)) {
      expect(yearKey).toMatch(/^\d{4}$/)
      expect(new Set(year.holidays).size).toBe(year.holidays.length)
      expect(new Set(year.workdays).size).toBe(year.workdays.length)
      for (const date of [...year.holidays, ...year.workdays]) {
        expect(date).toMatch(new RegExp(`^${yearKey}-\\d{2}-\\d{2}$`))
      }
      // A date cannot be both a day off and a makeup workday.
      expect(year.holidays.some((date) => year.workdays.includes(date))).toBe(false)
    }
  })

  it('is exposed through defaultHolidayData', () => {
    expect(defaultHolidayData()).toBe(BUILTIN_HOLIDAY_DATA)
  })
})

describe('resolveHolidayCalendar', () => {
  it('folds the built-in data into effective sets', () => {
    const calendar = resolveHolidayCalendar(configOf(), { year: 2025 })
    expect(calendar.holidays.has('2025-10-01')).toBe(true)
    expect(calendar.workdays.has('2025-10-11')).toBe(true)
    expect(calendar.coveredYears.has(2025)).toBe(true)
    expect(calendar.missingYears).toEqual([])
    expect(calendar.degraded).toBe(false)
    expect(calendar.source).toBe('builtin-cn')
  })

  it('tolerates a missing (nullish) config as the default', () => {
    const calendar = resolveHolidayCalendar(undefined, { year: 2025 })
    expect(calendar.holidays.has('2025-10-01')).toBe(true)
    expect(calendar.degraded).toBe(false)
  })

  it('applies manual holidays and workdays over the built-in data', () => {
    const calendar = resolveHolidayCalendar(configOf({
      holidays: ['2025-09-28', '2025-10-11', '2025-12-24'],
      workdays: ['2025-10-01', '2025-10-11', '2025-12-27'],
    }))
    // A manual workday outranks a manual holiday; a manual holiday outranks a
    // built-in makeup workday; and both outrank the built-in dataset.
    expect(calendar.holidays.has('2025-10-11')).toBe(false)
    expect(calendar.workdays.has('2025-10-11')).toBe(true)
    // Manual workday 2025-10-01 undoes the built-in National Day holiday.
    expect(calendar.holidays.has('2025-10-01')).toBe(false)
    expect(calendar.workdays.has('2025-10-01')).toBe(true)
    // Manual holiday 2025-09-28 undoes the built-in makeup workday.
    expect(calendar.workdays.has('2025-09-28')).toBe(false)
    expect(calendar.holidays.has('2025-09-28')).toBe(true)
    expect(calendar.holidays.has('2025-12-24')).toBe(true)
    expect(calendar.workdays.has('2025-12-27')).toBe(true)
  })

  it('skips malformed manual entries instead of throwing', () => {
    const calendar = resolveHolidayCalendar(configOf({
      holidays: ['2025-10-01', 'not-a-date', ''],
      workdays: ['2025-10-11', '2025-13-40'],
    }))
    expect(calendar.holidays.has('2025-10-01')).toBe(true)
    expect(calendar.workdays.has('2025-10-11')).toBe(true)
  })

  it('can disable the built-in data entirely', () => {
    const calendar = resolveHolidayCalendar(configOf({ useBuiltinHolidays: false }), { year: 2025 })
    expect(calendar.holidays.size).toBe(0)
    expect(calendar.workdays.size).toBe(0)
    expect(calendar.degraded).toBe(false)
  })

  it('degrades to weekend-only rules when the data cannot be loaded', () => {
    const calendar = resolveHolidayCalendar(configOf(), { data: null, year: 2025 })
    expect(calendar.holidays.size).toBe(0)
    expect(calendar.degraded).toBe(true)
    expect(calendar.source).toBe('none')
  })

  it('reports a year the data bundle does not cover', () => {
    const partial = {
      years: { '2025': BUILTIN_HOLIDAY_DATA.years['2025'] },
      source: 'partial-test',
    }
    const calendar = resolveHolidayCalendar(configOf(), { data: partial, year: 2030 })
    expect(calendar.missingYears).toEqual([2030])
    expect(calendar.degraded).toBe(true)
    expect(calendar.source).toBe('partial-test')
  })

  it('never throws on a malformed bundle', () => {
    const broken = { years: { '2025': null }, source: 'broken' } as unknown as Parameters<typeof resolveHolidayCalendar>[1]
    expect(() => resolveHolidayCalendar(configOf(), broken)).not.toThrow()
    expect(() => resolveHolidayCalendar(configOf(), { data: null })).not.toThrow()
  })
})
