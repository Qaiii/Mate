import { describe, expect, it, vi } from 'vitest'
import type { DisabledWindow, ModelSchedule, ScheduleConfig } from './shared.js'
import type { ValidationIssue } from './schedule.js'
import {
  WEEKDAYS,
  describeWindow,
  emptySchedule,
  evaluateModelRoute,
  findModelSchedule,
  holidaySetOf,
  hostTimeZone,
  isModelAvailable,
  isValidTimeZone,
  localParts,
  resolveEffectiveTimeZone,
  validateScheduleConfig,
} from './schedule.js'

const MINUTE = 60_000

/** Fixed reference dates (all UTC): Monday, Saturday, and a Friday holiday. */
const MONDAY = '2026-11-09'
const FRIDAY = '2026-11-13'
const SATURDAY = '2026-11-14'
const CHRISTMAS = '2026-12-25'

function utc(iso: string): number {
  return Date.parse(iso)
}

function monday(hhmm: string): number {
  return utc(`${MONDAY}T${hhmm}:00Z`)
}

function windowOf(kind: DisabledWindow['kind'], start: string, end: string): DisabledWindow {
  return { kind, start, end }
}

function entryOf(windows: DisabledWindow[], provider = 'openai', model = 'gpt'): ModelSchedule {
  return { provider, model, disabledWindows: windows }
}

function scheduleOf(windows: DisabledWindow[], overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    models: [entryOf(windows)],
    holidays: [],
    workdays: [],
    useBuiltinHolidays: true,
    timezone: null,
    ...overrides,
  }
}

/** Raw (possibly invalid) window list for validation tests. */
function configWithWindows(windows: unknown[]): unknown {
  return { models: [{ provider: 'p', model: 'm', disabledWindows: windows }] }
}

function okValue(raw: unknown): ScheduleConfig {
  const result = validateScheduleConfig(raw)
  if (!result.ok) throw new Error(`expected a valid schedule, got ${JSON.stringify(result.errors)}`)
  return result.value
}

function errorsOf(raw: unknown): ValidationIssue[] {
  const result = validateScheduleConfig(raw)
  if (result.ok) throw new Error('expected an invalid schedule')
  return result.errors
}

function hasIssue(issues: ValidationIssue[], code: ValidationIssue['code'], path?: string): boolean {
  return issues.some((issue) => issue.code === code && (path === undefined || issue.path === path))
}

function codesOf(issues: ValidationIssue[]): ValidationIssue['code'][] {
  return issues.map((issue) => issue.code)
}

/** The "every minute of every ordinary day is disabled" window set. */
function fullDayWindows(): DisabledWindow[] {
  return [
    windowOf('weekday', '00:00', '12:00'),
    windowOf('weekday', '12:00', '00:00'),
    windowOf('weekend', '00:00', '12:00'),
    windowOf('weekend', '12:00', '00:00'),
  ]
}

describe('WEEKDAYS', () => {
  it('is the canonical ISO order', () => {
    expect(WEEKDAYS).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
  })
})

describe('emptySchedule / empty config', () => {
  it('is the no-config value', () => {
    expect(emptySchedule()).toEqual({
      models: [],
      holidays: [],
      workdays: [],
      useBuiltinHolidays: true,
      timezone: null,
    })
  })

  it('accepts an empty config and generates no windows', () => {
    const value = okValue({})
    expect(value).toEqual(emptySchedule())
    expect(value.models).toHaveLength(0)
    expect(value.holidays).toEqual([])
    expect(value.timezone).toBeNull()
    expect(okValue(emptySchedule())).toEqual(emptySchedule())
  })

  it('treats a missing (nullish) config as the empty config', () => {
    expect(okValue(undefined)).toEqual(emptySchedule())
    expect(okValue(null)).toEqual(emptySchedule())
  })

  it('reports always available with reason no-config and no wake time', () => {
    const result = isModelAvailable(monday('10:30'), undefined, 'UTC', [])
    expect(result).toEqual({
      available: true,
      branch: 'weekday',
      reason: 'no-config',
      window: null,
      nextAvailableAt: null,
      timezone: 'UTC',
    })
  })

  it('treats an entry with no windows as no-config', () => {
    const result = isModelAvailable(monday('10:30'), entryOf([]), 'UTC', [])
    expect(result.available).toBe(true)
    expect(result.reason).toBe('no-config')
  })
})

describe('validateScheduleConfig: normalization', () => {
  it('trims labels, dedupes weekdays in ISO order, dedupes/sorts holidays and trims the timezone', () => {
    const value = okValue({
      models: [
        {
          provider: '  openai  ',
          model: ' gpt-5 ',
          disabledWindows: [
            { kind: ['fri', 'mon', 'mon'], start: '22:00', end: '06:00' },
            { kind: 'weekend', start: '10:00', end: '12:00' },
          ],
        },
      ],
      holidays: ['2026-12-25', '2026-01-01', '2026-12-25'],
      timezone: '  Asia/Shanghai  ',
    })
    expect(value.models).toEqual([
      {
        provider: 'openai',
        model: 'gpt-5',
        disabledWindows: [
          windowOf(['mon', 'fri'], '22:00', '06:00'),
          windowOf('weekend', '10:00', '12:00'),
        ],
      },
    ])
    expect(value.holidays).toEqual(['2026-01-01', '2026-12-25'])
    expect(value.timezone).toBe('Asia/Shanghai')
  })

  it('normalizes a blank timezone to null', () => {
    expect(okValue({ timezone: '   ' }).timezone).toBeNull()
  })

  it('keeps a model entry with no disabled windows as always available', () => {
    const value = okValue({ models: [{ provider: 'p', model: 'm', disabledWindows: [] }] })
    expect(value.models).toEqual([{ provider: 'p', model: 'm', disabledWindows: [] }])
  })
})

describe('validateScheduleConfig: rejections', () => {
  it('rejects malformed HH:mm times', () => {
    for (const bad of ['9:00', '09:60', '24:00', '09:00:00', '0900', '']) {
      const issues = errorsOf(configWithWindows([{ kind: 'weekday', start: bad, end: '10:00' }]))
      expect(hasIssue(issues, 'time-format', 'models[0].disabledWindows[0].start')).toBe(true)
    }
    const issues = errorsOf(configWithWindows([{ kind: 'weekday', start: '09:00', end: '25:00' }]))
    expect(hasIssue(issues, 'time-format', 'models[0].disabledWindows[0].end')).toBe(true)
  })

  it('rejects an unknown weekday code', () => {
    const issues = errorsOf(configWithWindows([{ kind: ['mon', 'funday'], start: '10:00', end: '12:00' }]))
    expect(hasIssue(issues, 'weekday', 'models[0].disabledWindows[0].kind')).toBe(true)
  })

  it('rejects an unknown kind, a non-string kind and an empty weekday array', () => {
    expect(hasIssue(errorsOf(configWithWindows([{ kind: 'holidays', start: '10:00', end: '12:00' }])), 'kind')).toBe(true)
    expect(hasIssue(errorsOf(configWithWindows([{ kind: 42, start: '10:00', end: '12:00' }])), 'kind')).toBe(true)
    expect(hasIssue(errorsOf(configWithWindows([{ kind: [], start: '10:00', end: '12:00' }])), 'kind')).toBe(true)
  })

  it('rejects a zero-length window', () => {
    const issues = errorsOf(configWithWindows([{ kind: 'weekday', start: '10:00', end: '10:00' }]))
    expect(hasIssue(issues, 'zero-length', 'models[0].disabledWindows[0]')).toBe(true)
  })

  it('rejects overlapping windows of the same model', () => {
    expect(
      hasIssue(
        errorsOf(
          configWithWindows([
            windowOf('weekday', '22:00', '06:00'),
            windowOf('weekday', '05:00', '07:00'),
          ]),
        ),
        'overlap',
        'models[0].disabledWindows[1]',
      ),
    ).toBe(true)

    expect(
      hasIssue(
        errorsOf(
          configWithWindows([
            windowOf(['mon'], '10:00', '12:00'),
            windowOf(['mon', 'tue'], '11:00', '13:00'),
          ]),
        ),
        'overlap',
      ),
    ).toBe(true)

    expect(
      hasIssue(
        errorsOf(
          configWithWindows([
            windowOf('weekday', '23:00', '01:00'),
            windowOf('weekday', '00:30', '02:00'),
          ]),
        ),
        'overlap',
      ),
    ).toBe(true)

    expect(
      hasIssue(
        errorsOf(
          configWithWindows([
            windowOf('holiday', '10:00', '12:00'),
            windowOf('holiday', '11:00', '13:00'),
          ]),
        ),
        'overlap',
      ),
    ).toBe(true)
  })

  it('allows adjacent, disjoint-weekday, and cross-branch windows', () => {
    expect(validateScheduleConfig(configWithWindows([
      windowOf('weekday', '22:00', '06:00'),
      windowOf('weekday', '06:00', '08:00'),
    ])).ok).toBe(true)

    expect(validateScheduleConfig(configWithWindows([
      windowOf(['mon'], '10:00', '12:00'),
      windowOf(['tue'], '11:00', '13:00'),
    ])).ok).toBe(true)

    expect(validateScheduleConfig(configWithWindows([
      windowOf('weekday', '22:00', '06:00'),
      windowOf('weekend', '05:00', '07:00'),
    ])).ok).toBe(true)

    expect(validateScheduleConfig(configWithWindows([
      windowOf('weekday', '10:00', '12:00'),
      windowOf('holiday', '10:00', '12:00'),
    ])).ok).toBe(true)
  })

  it('rejects a duplicate provider/model pair', () => {
    const issues = errorsOf({
      models: [
        { provider: 'p', model: 'm', disabledWindows: [] },
        { provider: ' p ', model: ' m ', disabledWindows: [] },
      ],
    })
    expect(hasIssue(issues, 'duplicate-model', 'models[1]')).toBe(true)
  })

  it('rejects a missing or empty provider/model label', () => {
    const issues = errorsOf({ models: [{ model: 'm' }, { provider: 'p', model: '   ' }] })
    expect(hasIssue(issues, 'provider', 'models[0].provider')).toBe(true)
    expect(hasIssue(issues, 'model', 'models[1].model')).toBe(true)
  })

  it('rejects bad holiday dates but accepts a real leap day', () => {
    for (const bad of ['2026-2-01', '2026-02-30', '2026-13-01', 'not-a-date', '2026-01-01T00:00:00Z']) {
      expect(hasIssue(errorsOf({ holidays: [bad] }), 'holiday-format', 'holidays[0]')).toBe(true)
    }
    expect(okValue({ holidays: ['2028-02-29'] }).holidays).toEqual(['2028-02-29'])
  })

  it('rejects an invalid IANA timezone', () => {
    expect(hasIssue(errorsOf({ timezone: 'Mars/Phobos' }), 'timezone', 'timezone')).toBe(true)
    expect(hasIssue(errorsOf({ timezone: 123 }), 'timezone', 'timezone')).toBe(true)
  })

  it('returns every issue instead of stopping at the first', () => {
    const issues = errorsOf({
      models: [
        { provider: 'p', model: 'm', disabledWindows: [{ kind: 'holidays', start: '9:00', end: '10:00' }] },
        { provider: 'p', model: 'm', disabledWindows: [] },
      ],
      holidays: ['2026-02-30'],
      timezone: 'Mars/Phobos',
    })
    const codes = codesOf(issues)
    expect(codes).toContain('kind')
    expect(codes).toContain('time-format')
    expect(codes).toContain('duplicate-model')
    expect(codes).toContain('holiday-format')
    expect(codes).toContain('timezone')
    expect(issues.length).toBeGreaterThanOrEqual(5)
  })

  it('reports shape problems without throwing on untrusted values', () => {
    for (const weird of [0, '', 'nope', [], true]) {
      expect(validateScheduleConfig(weird).ok).toBe(false)
      expect(() => validateScheduleConfig(weird)).not.toThrow()
    }
    expect(hasIssue(errorsOf({ models: 'nope' }), 'models', 'models')).toBe(true)
    expect(hasIssue(errorsOf({ models: [null] }), 'shape', 'models[0]')).toBe(true)
    expect(hasIssue(errorsOf({ models: [{ provider: 'p', model: 'm', disabledWindows: 'nope' }] }), 'shape', 'models[0].disabledWindows')).toBe(true)
    expect(hasIssue(errorsOf({ models: [{ provider: 'p', model: 'm', disabledWindows: [null] }] }), 'shape', 'models[0].disabledWindows[0]')).toBe(true)
    expect(hasIssue(errorsOf({ holidays: '2026-12-25' }), 'shape', 'holidays')).toBe(true)
  })
})

describe('isValidTimeZone / hostTimeZone', () => {
  it('accepts real IANA ids and rejects junk', () => {
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true)
    expect(isValidTimeZone(' America/New_York ')).toBe(true)
    expect(isValidTimeZone('Mars/Phobos')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone('   ')).toBe(false)
    expect(isValidTimeZone(null)).toBe(false)
    expect(isValidTimeZone(undefined)).toBe(false)
  })

  it('reports a valid host zone', () => {
    expect(isValidTimeZone(hostTimeZone())).toBe(true)
  })
})

describe('resolveEffectiveTimeZone', () => {
  it('prefers a valid manual override', () => {
    expect(resolveEffectiveTimeZone({
      manual: 'Asia/Shanghai',
      client: 'America/New_York',
      host: 'Europe/London',
    })).toEqual({ id: 'Asia/Shanghai', source: 'manual' })
  })

  it('falls back to the DSH client zone when the manual override is invalid', () => {
    expect(resolveEffectiveTimeZone({
      manual: 'Mars/Phobos',
      client: 'America/New_York',
      host: 'Europe/London',
    })).toEqual({ id: 'America/New_York', source: 'client' })
  })

  it('falls back to the host zone when manual and client are unusable', () => {
    expect(resolveEffectiveTimeZone({
      manual: '',
      client: '  ',
      host: 'Europe/London',
    })).toEqual({ id: 'Europe/London', source: 'host' })
  })

  it('falls back to hostTimeZone and finally UTC', () => {
    expect(resolveEffectiveTimeZone({})).toEqual({ id: hostTimeZone(), source: 'host' })
    expect(resolveEffectiveTimeZone({
      manual: 'Mars/Phobos',
      client: 'Nope/Nope',
      host: 'Also/Bad',
    })).toEqual({ id: 'UTC', source: 'host' })
  })
})

describe('localParts', () => {
  it('renders the wall clock in the requested zone', () => {
    const instant = utc('2026-11-09T02:30:00Z')
    expect(localParts(instant, 'UTC')).toEqual({
      year: 2026,
      month: 11,
      day: 9,
      hour: 2,
      minute: 30,
      weekday: 0,
      dateKey: MONDAY,
    })
    expect(localParts(instant, 'Asia/Shanghai')).toEqual({
      year: 2026,
      month: 11,
      day: 9,
      hour: 10,
      minute: 30,
      weekday: 0,
      dateKey: MONDAY,
    })
  })

  it('maps ISO weekdays Monday = 0 … Sunday = 6', () => {
    expect(localParts(utc('2026-11-09T00:00:00Z'), 'UTC')?.weekday).toBe(0)
    expect(localParts(utc(`${SATURDAY}T00:00:00Z`), 'UTC')?.weekday).toBe(5)
    expect(localParts(utc('2026-11-08T00:00:00Z'), 'UTC')?.weekday).toBe(6)
  })

  it('truncates seconds and returns null for an invalid zone', () => {
    expect(localParts(utc('2026-11-09T02:30:59.999Z'), 'Asia/Shanghai')?.minute).toBe(30)
    expect(localParts(utc('2026-11-09T02:30:00Z'), 'Mars/Phobos')).toBeNull()
    expect(localParts(utc('2026-11-09T02:30:00Z'), '')).toBeNull()
  })
})

describe('isModelAvailable: single window', () => {
  const entry = entryOf([windowOf('weekday', '10:00', '12:00')])

  it('blocks inside the window and reports the blocking window', () => {
    expect(isModelAvailable(monday('11:00'), entry, 'UTC', [])).toEqual({
      available: false,
      branch: 'weekday',
      reason: 'inside-window',
      window: windowOf('weekday', '10:00', '12:00'),
      nextAvailableAt: monday('12:00'),
      timezone: 'UTC',
    })
  })

  it('is available outside the window (start inclusive, end exclusive)', () => {
    expect(isModelAvailable(monday('09:00'), entry, 'UTC', [])).toMatchObject({
      available: true,
      reason: 'outside-window',
      window: null,
      nextAvailableAt: null,
    })
    expect(isModelAvailable(monday('12:00'), entry, 'UTC', []).available).toBe(true)
    expect(isModelAvailable(monday('21:59'), entry, 'UTC', []).available).toBe(true)
  })
})

describe('isModelAvailable: cross-midnight windows', () => {
  const entry = entryOf([windowOf('weekday', '22:00', '06:00')])

  it('matches both late night and early morning', () => {
    expect(isModelAvailable(monday('23:30'), entry, 'UTC', [])).toMatchObject({ available: false, reason: 'inside-window' })
    expect(isModelAvailable(monday('05:30'), entry, 'UTC', [])).toMatchObject({ available: false, reason: 'inside-window' })
  })

  it('stops matching at the end of the window and before the start', () => {
    expect(isModelAvailable(monday('06:00'), entry, 'UTC', [])).toMatchObject({ available: true, reason: 'outside-window' })
    expect(isModelAvailable(monday('21:59'), entry, 'UTC', [])).toMatchObject({ available: true, reason: 'outside-window' })
  })

  it('does not leak a weekday overnight window into the weekend branch', () => {
    expect(isModelAvailable(utc(`${SATURDAY}T05:30:00Z`), entry, 'UTC', [])).toMatchObject({
      available: true,
      branch: 'weekend',
      reason: 'outside-window',
    })
  })

  it('computes the next available minute across midnight', () => {
    expect(isModelAvailable(monday('23:30'), entry, 'UTC', []).nextAvailableAt).toBe(
      utc('2026-11-10T06:00:00Z'),
    )
  })
})

describe('isModelAvailable: weekend branch', () => {
  const entry = entryOf([windowOf('weekend', '09:00', '18:00')])

  it('blocks Saturday', () => {
    expect(isModelAvailable(utc(`${SATURDAY}T10:00:00Z`), entry, 'UTC', [])).toMatchObject({
      available: false,
      branch: 'weekend',
      reason: 'inside-window',
    })
  })

  it('does not block Friday', () => {
    expect(isModelAvailable(utc(`${FRIDAY}T10:00:00Z`), entry, 'UTC', [])).toMatchObject({
      available: true,
      branch: 'weekday',
      reason: 'outside-window',
    })
  })
})

describe('isModelAvailable: holiday branch', () => {
  const entry = entryOf([
    windowOf('weekday', '10:00', '12:00'),
    windowOf('holiday', '14:00', '16:00'),
  ])

  it('gives holidays precedence and applies only holiday windows', () => {
    const morning = isModelAvailable(utc(`${CHRISTMAS}T10:30:00Z`), entry, 'UTC', [CHRISTMAS])
    expect(morning).toMatchObject({ available: true, branch: 'holiday', reason: 'outside-window' })

    const afternoon = isModelAvailable(utc(`${CHRISTMAS}T14:30:00Z`), entry, 'UTC', new Set([CHRISTMAS]))
    expect(afternoon).toMatchObject({
      available: false,
      branch: 'holiday',
      reason: 'inside-window',
      window: windowOf('holiday', '14:00', '16:00'),
    })
  })

  it('restores the weekday rule when the date is not listed', () => {
    const morning = isModelAvailable(utc(`${CHRISTMAS}T10:30:00Z`), entry, 'UTC', [])
    expect(morning).toMatchObject({
      available: false,
      branch: 'weekday',
      reason: 'inside-window',
      window: windowOf('weekday', '10:00', '12:00'),
    })
    expect(isModelAvailable(utc(`${CHRISTMAS}T14:30:00Z`), entry, 'UTC', []).available).toBe(true)
  })

  it('does not apply explicit weekday arrays on holidays', () => {
    const explicit = entryOf([windowOf(['fri'], '10:00', '12:00')])
    expect(isModelAvailable(utc(`${CHRISTMAS}T10:30:00Z`), explicit, 'UTC', [CHRISTMAS]).available).toBe(true)
    expect(isModelAvailable(utc(`${CHRISTMAS}T10:30:00Z`), explicit, 'UTC', []).available).toBe(false)
  })

  it('matches explicit weekday lists on ordinary days', () => {
    const mondayOnly = entryOf([windowOf(['mon'], '10:00', '12:00')])
    expect(isModelAvailable(monday('11:00'), mondayOnly, 'UTC', []).available).toBe(false)
    expect(isModelAvailable(utc(`${FRIDAY}T11:00:00Z`), mondayOnly, 'UTC', []).available).toBe(true)
  })
})

describe('isModelAvailable: timezone handling', () => {
  const entry = entryOf([windowOf('weekday', '09:00', '12:00')])
  const instant = utc('2026-11-09T02:30:00Z') // Mon 02:30 UTC = Mon 10:30 Asia/Shanghai

  it('judges the same instant differently in UTC and Asia/Shanghai', () => {
    expect(isModelAvailable(instant, entry, 'UTC', [])).toMatchObject({
      available: true,
      reason: 'outside-window',
      timezone: 'UTC',
    })
    expect(isModelAvailable(instant, entry, 'Asia/Shanghai', [])).toMatchObject({
      available: false,
      reason: 'inside-window',
      timezone: 'Asia/Shanghai',
    })
  })

  it('falls back to UTC for an invalid timezone instead of throwing', () => {
    const instantInsideUtc = utc('2026-11-09T10:30:00Z')
    const result = isModelAvailable(instantInsideUtc, entry, 'Mars/Phobos', [])
    expect(result).toMatchObject({ available: false, reason: 'inside-window', timezone: 'UTC' })
    expect(() => isModelAvailable(instantInsideUtc, entry, 'Mars/Phobos', [])).not.toThrow()
  })

  it('never reads the system clock', () => {
    const spy = vi.spyOn(Date, 'now')
    try {
      isModelAvailable(monday('11:00'), entry, 'UTC', [])
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('isModelAvailable: nextAvailableAt', () => {
  it('is null when available now', () => {
    const entry = entryOf([windowOf('weekday', '10:00', '12:00')])
    expect(isModelAvailable(monday('09:00'), entry, 'UTC', []).nextAvailableAt).toBeNull()
  })

  it('returns the first aligned minute after the window', () => {
    const entry = entryOf([windowOf('weekday', '10:00', '12:00')])
    const next = isModelAvailable(utc('2026-11-09T11:30:45.500Z'), entry, 'UTC', []).nextAvailableAt
    expect(next).toBe(utc('2026-11-09T12:00:00Z'))
    expect(next! % MINUTE).toBe(0)
  })

  it('is null when every minute of every ordinary day is disabled', () => {
    const schedule = scheduleOf(fullDayWindows())
    expect(validateScheduleConfig(schedule).ok).toBe(true)
    const result = isModelAvailable(monday('10:00'), schedule.models[0], 'UTC', schedule.holidays)
    expect(result).toMatchObject({ available: false, reason: 'inside-window', nextAvailableAt: null })
  })

  it('wakes at the next holiday that falls inside the scan window', () => {
    const schedule = scheduleOf(fullDayWindows(), { holidays: [SATURDAY] })
    const result = isModelAvailable(monday('10:00'), schedule.models[0], 'UTC', schedule.holidays)
    expect(result.nextAvailableAt).toBe(utc(`${SATURDAY}T00:00:00Z`))
  })

  it('returns null when the next available minute is past the 8-day scan', () => {
    const schedule = scheduleOf(fullDayWindows(), { holidays: ['2026-11-18'] })
    const result = isModelAvailable(monday('10:00'), schedule.models[0], 'UTC', schedule.holidays)
    expect(result.nextAvailableAt).toBeNull()
  })
})

describe('findModelSchedule / holidaySetOf', () => {
  it('finds a route entry and returns undefined without windows', () => {
    const entry = entryOf([windowOf('weekday', '10:00', '12:00')])
    const schedule = scheduleOf(entry.disabledWindows, {
      models: [entry, { provider: 'anthropic', model: 'claude', disabledWindows: [] }],
    })
    expect(findModelSchedule(schedule, 'openai', 'gpt')).toEqual(entry)
    expect(findModelSchedule(schedule, 'anthropic', 'claude')).toBeUndefined()
    expect(findModelSchedule(schedule, 'missing', 'gpt')).toBeUndefined()
    expect(findModelSchedule(null, 'openai', 'gpt')).toBeUndefined()
    expect(findModelSchedule(undefined, 'openai', 'gpt')).toBeUndefined()
    expect(findModelSchedule(emptySchedule(), 'openai', 'gpt')).toBeUndefined()
  })

  it('normalizes holidays into a set', () => {
    const set = holidaySetOf(scheduleOf([], { holidays: [CHRISTMAS, ` ${CHRISTMAS} `, ''] }))
    expect(set).toEqual(new Set([CHRISTMAS]))
    expect(holidaySetOf(null).size).toBe(0)
    expect(holidaySetOf(undefined).size).toBe(0)
    expect(holidaySetOf(emptySchedule()).size).toBe(0)
  })
})

describe('evaluateModelRoute', () => {
  it('looks the route up and applies the schedule holidays by default', () => {
    const schedule: ScheduleConfig = {
      models: [entryOf([
        windowOf('weekday', '10:00', '12:00'),
        windowOf('holiday', '14:00', '16:00'),
      ])],
      holidays: [CHRISTMAS],
      workdays: [],
      useBuiltinHolidays: true,
      timezone: null,
    }

    expect(evaluateModelRoute({
      nowMs: utc(`${CHRISTMAS}T14:30:00Z`),
      schedule,
      provider: 'openai',
      model: 'gpt',
      timezone: 'UTC',
    })).toMatchObject({
      available: false,
      branch: 'holiday',
      reason: 'inside-window',
      window: windowOf('holiday', '14:00', '16:00'),
    })

    expect(evaluateModelRoute({
      nowMs: utc(`${CHRISTMAS}T10:30:00Z`),
      schedule,
      provider: 'openai',
      model: 'gpt',
      timezone: 'UTC',
    })).toMatchObject({ available: true, branch: 'holiday', reason: 'outside-window' })
  })

  it('is available for a route that has no entry', () => {
    const result = evaluateModelRoute({
      nowMs: monday('10:30'),
      schedule: emptySchedule(),
      provider: 'openai',
      model: 'gpt',
      timezone: 'UTC',
    })
    expect(result.reason).toBe('no-config')
    expect(result.available).toBe(true)
  })

  it('honours an explicit holiday override', () => {
    const schedule = scheduleOf([windowOf('holiday', '14:00', '16:00')])
    const result = evaluateModelRoute({
      nowMs: utc(`${CHRISTMAS}T14:30:00Z`),
      schedule,
      provider: 'openai',
      model: 'gpt',
      timezone: 'UTC',
      holidays: [CHRISTMAS],
    })
    expect(result).toMatchObject({ available: false, branch: 'holiday', reason: 'inside-window' })
  })
})

describe('describeWindow', () => {
  it('renders one-line summaries', () => {
    expect(describeWindow(windowOf('weekday', '22:00', '06:00'))).toBe('weekday 22:00-06:00')
    expect(describeWindow(windowOf('weekend', '09:00', '18:00'))).toBe('weekend 09:00-18:00')
    expect(describeWindow(windowOf('holiday', '00:00', '23:59'))).toBe('holiday 00:00-23:59')
    expect(describeWindow(windowOf(['mon', 'fri'], '10:00', '12:00'))).toBe('mon,fri 10:00-12:00')
  })
})
