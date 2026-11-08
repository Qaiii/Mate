/**
 * Model availability scheduling: the disabled-window configuration, its
 * validation, and the pure availability judgement used by the analysis and
 * dispatch gates.
 *
 * CONTRACT (owner: schedule-core). Keep every export below: the Host gate, the
 * settings page, and the unit tests import these names. This module is pure and
 * isomorphic — it must not import `node:*`, read the system clock, or open I/O —
 * so the browser bundle can reuse the validation.
 */
import type { DisabledWindow, ModelSchedule, ScheduleConfig, TimeZoneSource, TimeZoneView, WeekdayCode } from './shared.js'

/** Canonical ISO weekday order, Monday first. */
export const WEEKDAYS: readonly WeekdayCode[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/** One validation failure, addressed by a dotted path into the submitted config. */
export interface ValidationIssue {
  /** Stable machine code the settings page maps onto localized copy. */
  code:
    | 'shape'
    | 'models'
    | 'provider'
    | 'model'
    | 'duplicate-model'
    | 'kind'
    | 'weekday'
    | 'time-format'
    | 'zero-length'
    | 'overlap'
    | 'holiday-format'
    | 'workday-format'
    | 'holiday-toggle'
    | 'timezone'
  /** Dotted path, e.g. `models[0].disabledWindows[1].start`. */
  path: string
  /** English developer-facing detail; the UI prefers the localized code. */
  message: string
}

/** Validation result: either the normalized config or every issue found. */
export type ScheduleValidation =
  | { ok: true; value: ScheduleConfig }
  | { ok: false; errors: ValidationIssue[] }

/** The default no-config schedule: no windows, no holidays, no override. */
export function emptySchedule(): ScheduleConfig {
  return { models: [], holidays: [], workdays: [], useBuiltinHolidays: true, timezone: null }
}

/**
 * Validate and normalize a candidate {@link ScheduleConfig} coming from the
 * browser (always untrusted `unknown`). On success the returned value is
 * canonical: provider/model strings trimmed, weekday arrays de-duplicated in
 * ISO order, holidays de-duplicated and sorted, timezone trimmed to `null` when
 * empty. On failure every issue found is returned (do not stop at the first).
 *
 * Rules:
 * - empty `models` + empty `holidays` is valid and generates no disabled window;
 * - `provider`/`model` must be non-empty after trim; the same pair may not
 *   appear twice (code `duplicate-model`);
 * - `start`/`end` must match `^([01]\d|2[0-3]):[0-5]\d$` (`time-format`);
 *   `start === end` is a zero-length window and is rejected (`zero-length`);
 * - `kind` is `'weekday' | 'weekend' | 'holiday'` or a non-empty array of
 *   weekday codes (`kind` / `weekday` issues); an unknown string or an empty
 *   array is rejected; duplicate weekday entries are de-duplicated;
 * - two windows of the same model whose effective day sets intersect may not
 *   overlap in wall-clock time (`overlap`). A window's effective day set is
 *   `mon..fri` for `'weekday'`, `sat..sun` for `'weekend'`, its exact array for
 *   an explicit list, and the holiday family for `'holiday'` (holiday windows
 *   are mutually exclusive with weekday/weekend windows: the holiday branch
 *   takes precedence);
 * - `holidays` / `workdays` entries must match `^\d{4}-\d{2}-\d{2}$` and be
 *   real calendar dates (`holiday-format` / `workday-format`); each list is
 *   de-duplicated and sorted; a `workdays` date is a manual 调休上班日 override;
 * - `useBuiltinHolidays` is a boolean and defaults to `true` when absent
 *   (`holiday-toggle`);
 * - `timezone` is `null` or an IANA zone id accepted by `Intl`
 *   (`timezone`).
 */
export function validateScheduleConfig(raw: unknown): ScheduleValidation {
  const errors: ValidationIssue[] = []

  // A missing schedule (null/undefined) is the no-config state, not an error.
  if (raw === null || raw === undefined) return { ok: true, value: emptySchedule() }
  if (!isRecord(raw)) {
    return {
      ok: false,
      errors: [{ code: 'shape', path: '', message: 'schedule config must be an object' }],
    }
  }

  const models: ModelSchedule[] = []
  const rawModels = raw.models
  if (rawModels !== null && rawModels !== undefined) {
    if (!Array.isArray(rawModels)) {
      errors.push({ code: 'models', path: 'models', message: 'models must be an array' })
    } else {
      const seen = new Set<string>()
      rawModels.forEach((rawEntry, index) => {
        const modelPath = `models[${index}]`
        if (!isRecord(rawEntry)) {
          errors.push({ code: 'shape', path: modelPath, message: 'model schedule must be an object' })
          return
        }

        const provider = normalizeLabel(rawEntry.provider, `${modelPath}.provider`, 'provider', errors)
        const model = normalizeLabel(rawEntry.model, `${modelPath}.model`, 'model', errors)

        const windows: DisabledWindow[] = []
        const rawWindows = rawEntry.disabledWindows
        if (rawWindows !== null && rawWindows !== undefined) {
          if (!Array.isArray(rawWindows)) {
            errors.push({
              code: 'shape',
              path: `${modelPath}.disabledWindows`,
              message: 'disabledWindows must be an array',
            })
          } else {
            rawWindows.forEach((rawWindow, windowIndex) => {
              const windowPath = `${modelPath}.disabledWindows[${windowIndex}]`
              if (!isRecord(rawWindow)) {
                errors.push({ code: 'shape', path: windowPath, message: 'disabled window must be an object' })
                return
              }
              const kind = normalizeKind(rawWindow.kind, `${windowPath}.kind`, errors)
              const start = normalizeTime(rawWindow.start, `${windowPath}.start`, errors)
              const end = normalizeTime(rawWindow.end, `${windowPath}.end`, errors)
              if (start !== null && end !== null) {
                if (start === end) {
                  errors.push({
                    code: 'zero-length',
                    path: windowPath,
                    message: 'start and end must differ (zero-length window)',
                  })
                } else if (kind !== null) {
                  windows.push({ kind, start, end })
                }
              }
            })
          }
        }

        if (provider !== null && model !== null) {
          const key = `${provider}\u0000${model}`
          if (seen.has(key)) {
            errors.push({
              code: 'duplicate-model',
              path: modelPath,
              message: `duplicate schedule for ${provider}/${model}`,
            })
          } else {
            seen.add(key)
          }
        }

        for (let left = 0; left < windows.length; left += 1) {
          for (let right = left + 1; right < windows.length; right += 1) {
            if (windowsOverlap(windows[left], windows[right])) {
              errors.push({
                code: 'overlap',
                path: `${modelPath}.disabledWindows[${right}]`,
                message: `window ${describeWindow(windows[left])} overlaps ${describeWindow(windows[right])}`,
              })
            }
          }
        }

        models.push({
          provider: provider ?? '',
          model: model ?? '',
          disabledWindows: windows,
        })
      })
    }
  }

  const holidays = normalizeDateList(raw.holidays, 'holidays', 'holiday-format', errors)
  const workdays = normalizeDateList(raw.workdays, 'workdays', 'workday-format', errors)

  // Missing toggle keeps the feature on: the built-in calendar applies by default.
  let useBuiltinHolidays = true
  const rawToggle = raw.useBuiltinHolidays
  if (rawToggle !== null && rawToggle !== undefined) {
    if (typeof rawToggle !== 'boolean') {
      errors.push({
        code: 'holiday-toggle',
        path: 'useBuiltinHolidays',
        message: 'useBuiltinHolidays must be a boolean',
      })
    } else {
      useBuiltinHolidays = rawToggle
    }
  }

  let timezone: string | null = null
  const rawTimezone = raw.timezone
  if (rawTimezone !== null && rawTimezone !== undefined) {
    if (typeof rawTimezone !== 'string') {
      errors.push({ code: 'timezone', path: 'timezone', message: 'timezone must be a string or null' })
    } else {
      const trimmed = rawTimezone.trim()
      if (trimmed !== '') {
        if (isValidTimeZone(trimmed)) timezone = trimmed
        else errors.push({ code: 'timezone', path: 'timezone', message: `unknown IANA time zone "${trimmed}"` })
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { models, holidays, workdays, useBuiltinHolidays, timezone } }
}

/**
 * Validate and canonicalize one `YYYY-MM-DD` list (holidays or makeup workdays):
 * de-duplicated and sorted; malformed or impossible dates produce one issue per
 * offending entry so the settings page can point at the exact index.
 */
function normalizeDateList(
  raw: unknown,
  path: string,
  code: 'holiday-format' | 'workday-format',
  errors: ValidationIssue[],
): string[] {
  const dates: string[] = []
  if (raw === null || raw === undefined) return dates
  if (!Array.isArray(raw)) {
    errors.push({ code: 'shape', path, message: `${path} must be an array` })
    return dates
  }
  const seen = new Set<string>()
  raw.forEach((value, index) => {
    if (typeof value !== 'string' || !isRealDate(value)) {
      errors.push({
        code,
        path: `${path}[${index}]`,
        message: `${path === 'workdays' ? 'makeup workday' : 'holiday'} must be a real YYYY-MM-DD date`,
      })
    } else {
      seen.add(value)
    }
  })
  dates.push(...[...seen].sort())
  return dates
}

/**
 * True when `timeZone` is a non-empty IANA zone id Intl accepts. Never throws.
 * `null`/`undefined`/`''` are not valid ids.
 */
export function isValidTimeZone(timeZone: string | null | undefined): boolean {
  if (typeof timeZone !== 'string') return false
  const trimmed = timeZone.trim()
  return trimmed !== '' && acceptsTimeZone(trimmed)
}

/** The Host process's own IANA zone, or `'UTC'` when Intl cannot report one. */
export function hostTimeZone(): string {
  try {
    const resolved = new Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof resolved === 'string' && resolved.trim() !== '' && acceptsTimeZone(resolved.trim())) {
      return resolved.trim()
    }
  } catch {
    // Intl unavailable: fall through to UTC.
  }
  return 'UTC'
}

/**
 * Resolve the effective scheduling zone, in priority order: a valid manual
 * override (`'manual'`), the zone the DSH web client reported (`'client'`),
 * then the Host zone (`'host'`). Never returns an invalid id.
 */
export function resolveEffectiveTimeZone(input: {
  manual?: string | null
  client?: string | null
  host?: string | null
}): TimeZoneView {
  const manual = trimmedZone(input.manual)
  if (manual !== '' && acceptsTimeZone(manual)) return { id: manual, source: 'manual' }

  const client = trimmedZone(input.client)
  if (client !== '' && acceptsTimeZone(client)) return { id: client, source: 'client' }

  const host = trimmedZone(input.host)
  const hostZone = host !== '' ? host : hostTimeZone()
  if (acceptsTimeZone(hostZone)) return { id: hostZone, source: 'host' }

  return { id: 'UTC', source: 'host' }
}

/** Wall-clock components of one instant in one IANA zone. */
export interface LocalParts {
  year: number
  /** 1..12 */
  month: number
  /** 1..31 */
  day: number
  /** 0..23 */
  hour: number
  /** 0..59 */
  minute: number
  /** ISO weekday index, Monday = 0 … Sunday = 6. */
  weekday: number
  /** `YYYY-MM-DD` local date key used for holiday matching. */
  dateKey: string
}

/**
 * Local wall clock of `nowMs` in `timezone`. Pure: no system-clock reads.
 * Returns `null` for an invalid zone (callers resolve the zone first).
 */
export function localParts(nowMs: number, timezone: string): LocalParts | null {
  if (typeof timezone !== 'string') return null
  const trimmed = timezone.trim()
  if (trimmed === '') return null
  const formatter = formatterFor(trimmed)
  if (formatter === null) return null
  return localPartsWith(formatter, nowMs)
}

/**
 * Which calendar rule decides today's availability. A makeup workday resolves
 * to `'weekday'`; `'holiday'` outranks the ordinary weekend rule.
 */
export type DayBranch = 'weekday' | 'weekend' | 'holiday'

export type AvailabilityReason =
  /** No schedule entry, or the entry has no disabled window. */
  | 'no-config'
  /** A schedule exists but no window matches this instant. */
  | 'outside-window'
  /** A window matches this instant. */
  | 'inside-window'

/** The judgement for one model at one instant. */
export interface AvailabilityResult {
  available: boolean
  branch: DayBranch
  reason: AvailabilityReason
  /** The window that blocks this instant, or `null` when available. */
  window: DisabledWindow | null
  /** Earliest instant (epoch ms) the model is available again; `null` when available or unknown. */
  nextAvailableAt: number | null
  /** `<timezone>` at decision time, for diagnostics. */
  timezone: string
}

/** The schedule entry of one route, or `undefined` when it has no windows. */
export function findModelSchedule(
  schedule: ScheduleConfig | null | undefined,
  provider: string,
  model: string,
): ModelSchedule | undefined {
  if (schedule === null || schedule === undefined || !Array.isArray(schedule.models)) return undefined
  const wantedProvider = typeof provider === 'string' ? provider.trim() : ''
  const wantedModel = typeof model === 'string' ? model.trim() : ''
  const entry = schedule.models.find(
    (candidate) => candidate.provider.trim() === wantedProvider && candidate.model.trim() === wantedModel,
  )
  if (entry === undefined || !Array.isArray(entry.disabledWindows) || entry.disabledWindows.length === 0) {
    return undefined
  }
  return entry
}

/** Normalize the holiday list of a schedule into a lookup set. */
export function holidaySetOf(
  schedule: ScheduleConfig | null | undefined,
): Set<string> {
  const set = new Set<string>()
  if (schedule === null || schedule === undefined || !Array.isArray(schedule.holidays)) return set
  for (const value of schedule.holidays) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed !== '') set.add(trimmed)
  }
  return set
}

/** Normalize the manual makeup-workday list of a schedule into a lookup set. */
export function workdaySetOf(
  schedule: ScheduleConfig | null | undefined,
): Set<string> {
  const set = new Set<string>()
  if (schedule === null || schedule === undefined || !Array.isArray(schedule.workdays)) return set
  for (const value of schedule.workdays) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed !== '') set.add(trimmed)
  }
  return set
}

/**
 * Judge one model at one injected instant. Never reads the system clock.
 *
 * Semantics:
 * - `branch` is `'weekday'` when `localParts(...).dateKey` is in the makeup
 *   `workdays` set (调休上班日, even on a Saturday/Sunday), else `'holiday'`
 *   when it is in `holidays`, else `'weekend'` for Saturday/Sunday, else
 *   `'weekday'`;
 * - a window applies when its `kind` matches the branch: `'holiday'` windows
 *   only on the holiday branch; `'weekday'`/`'weekend'` only on their branch;
 *   an explicit weekday array only when that weekday matches (non-holiday);
 * - wall-clock containment: `start <= minuteOfDay < end`; when `end < start`
 *   the window crosses midnight (`minuteOfDay >= start || minuteOfDay < end`);
 *   `end === start` never matches;
 * - no entry or no windows: `available: true`, `reason: 'no-config'`;
 * - invalid `timezone`: fall back to UTC rather than throwing;
 * - `nextAvailableAt` is `null` when available, otherwise the first aligned
 *   minute after `now` at which the model is available (scan at most 12 days;
 *   whole blocked local days are skipped in one step so a long holiday window
 *   stays cheap; `null` when the configuration disables every minute of every
 *   day in that horizon).
 */
export function isModelAvailable(
  nowMs: number,
  entry: ModelSchedule | undefined,
  timezone: string,
  holidays: ReadonlySet<string> | readonly string[],
  workdays?: ReadonlySet<string> | readonly string[],
): AvailabilityResult {
  const zone = isValidTimeZone(timezone) ? timezone.trim() : 'UTC'
  const formatter = formatterFor(zone)
  const parts = formatter === null ? null : localPartsWith(formatter, nowMs)

  // Unresolvable instant or zone (defensive): treat as always available.
  if (parts === null) {
    return {
      available: true,
      branch: 'weekday',
      reason: 'no-config',
      window: null,
      nextAvailableAt: null,
      timezone: zone,
    }
  }

  const holidaySet = toHolidaySet(holidays)
  const workdaySet = toWorkdaySet(workdays)
  const windows = entry !== undefined && Array.isArray(entry.disabledWindows) ? entry.disabledWindows : []
  const branch = branchAt(parts, holidaySet, workdaySet)

  if (windows.length === 0) {
    return { available: true, branch, reason: 'no-config', window: null, nextAvailableAt: null, timezone: zone }
  }

  const blocking = blockingWindowAt(parts, windows, holidaySet, workdaySet)
  if (blocking === null) {
    return {
      available: true,
      branch,
      reason: 'outside-window',
      window: null,
      nextAvailableAt: null,
      timezone: zone,
    }
  }

  return {
    available: false,
    branch,
    reason: 'inside-window',
    window: blocking,
    nextAvailableAt: firstAvailableAt(nowMs, formatter!, windows, holidaySet, workdaySet),
    timezone: zone,
  }
}

/** Convenience wrapper: look the route up in the schedule, then judge it. */
export function evaluateModelRoute(input: {
  nowMs: number
  schedule: ScheduleConfig | null | undefined
  provider: string
  model: string
  timezone: string
  holidays?: ReadonlySet<string> | readonly string[]
  workdays?: ReadonlySet<string> | readonly string[]
}): AvailabilityResult {
  const entry = findModelSchedule(input.schedule, input.provider, input.model)
  const holidays = input.holidays ?? holidaySetOf(input.schedule)
  const workdays = input.workdays ?? workdaySetOf(input.schedule)
  return isModelAvailable(input.nowMs, entry, input.timezone, holidays, workdays)
}

/** One provider/model route to judge. */
export interface ModelRoute {
  provider: string
  model: string
}

/** One route plus its availability judgement at the requested instant. */
export interface ModelAvailability extends ModelRoute, AvailabilityResult {}

export interface ModelAvailabilityInput {
  nowMs: number
  schedule: ScheduleConfig | null | undefined
  /** Routes to judge; duplicates are kept in input order (callers de-duplicate the catalog). */
  routes: readonly ModelRoute[]
  timezone: string
  /** Effective holiday set; defaults to the schedule's manual list. */
  holidays?: ReadonlySet<string> | readonly string[]
  /** Effective makeup-workday set; defaults to the schedule's manual list. */
  workdays?: ReadonlySet<string> | readonly string[]
}

/**
 * Judge a list of routes at one instant and return every judgement, in input
 * order. Pure: no clock, no I/O. Used by the Host/client to answer "which
 * models are available right now" and "when does each become available".
 */
export function modelAvailabilityAt(input: ModelAvailabilityInput): ModelAvailability[] {
  const schedule = input.schedule ?? null
  const holidays = input.holidays ?? holidaySetOf(schedule)
  const workdays = input.workdays ?? workdaySetOf(schedule)
  const timezone = typeof input.timezone === 'string' ? input.timezone : 'UTC'
  return input.routes.map((route) => {
    const entry = findModelSchedule(schedule, route.provider, route.model)
    const result = isModelAvailable(input.nowMs, entry, timezone, holidays, workdays)
    return { provider: route.provider, model: route.model, ...result }
  })
}

/** The subset of `routes` that is available at `input.nowMs`, in input order. */
export function availableModelRoutes(input: ModelAvailabilityInput): ModelRoute[] {
  return modelAvailabilityAt(input)
    .filter((judgement) => judgement.available)
    .map(({ provider, model }) => ({ provider, model }))
}

/** Human-readable one-line summary of a window, e.g. `weekday 22:00-06:00`. */
export function describeWindow(window: DisabledWindow): string {
  const days = Array.isArray(window.kind) ? window.kind.join(',') : window.kind
  return `${days} ${window.start}-${window.end}`
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const MINUTES_PER_DAY = 24 * 60
/** Extra "day" bit that keeps holiday windows in a family of their own. */
const HOLIDAY_DAY_BIT = 7
/** Days scanned forward by `nextAvailableAt`; covers the longest (9-day) holiday. */
export const MAX_SCAN_DAYS = 12
/** Whole minutes scanned forward by `nextAvailableAt` (the contract cap). */
const MAX_SCAN_MINUTES = MAX_SCAN_DAYS * 24 * 60
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeLabel(
  value: unknown,
  path: string,
  code: 'provider' | 'model',
  errors: ValidationIssue[],
): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  errors.push({ code, path, message: `${code} must be a non-empty string` })
  return null
}

function normalizeTime(value: unknown, path: string, errors: ValidationIssue[]): string | null {
  if (typeof value === 'string' && TIME_PATTERN.test(value)) return value
  errors.push({ code: 'time-format', path, message: 'time must be HH:mm between 00:00 and 23:59' })
  return null
}

function normalizeKind(value: unknown, path: string, errors: ValidationIssue[]): DisabledWindow['kind'] | null {
  if (typeof value === 'string') {
    if (value === 'weekday' || value === 'weekend' || value === 'holiday') return value
    errors.push({ code: 'kind', path, message: `unknown kind "${value}"` })
    return null
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      errors.push({ code: 'kind', path, message: 'kind weekday array must not be empty' })
      return null
    }
    const codes: WeekdayCode[] = []
    let bad = false
    for (const item of value) {
      if (typeof item === 'string' && (WEEKDAYS as readonly string[]).includes(item)) {
        codes.push(item as WeekdayCode)
      } else {
        bad = true
        errors.push({ code: 'weekday', path, message: `unknown weekday ${JSON.stringify(item)}` })
      }
    }
    return bad ? null : WEEKDAYS.filter((code) => codes.includes(code))
  }
  errors.push({ code: 'kind', path, message: 'kind must be weekday/weekend/holiday or a weekday array' })
  return null
}

function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}

function acceptsTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

function trimmedZone(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseMinute(hhmm: string): number {
  const colon = hhmm.indexOf(':')
  return Number(hhmm.slice(0, colon)) * 60 + Number(hhmm.slice(colon + 1))
}

/** Bitmask of the weekdays a window applies to; the holiday family is bit 7. */
function kindDayMask(kind: DisabledWindow['kind']): number {
  if (kind === 'weekday') return 0b00011111
  if (kind === 'weekend') return 0b01100000
  if (kind === 'holiday') return 1 << HOLIDAY_DAY_BIT
  let mask = 0
  for (const code of kind) {
    const index = WEEKDAYS.indexOf(code)
    if (index >= 0) mask |= 1 << index
  }
  return mask
}

type MinuteRange = readonly [number, number]

/** Linear `[from, to)` pieces of a window on the minute-of-day line. */
function minuteRanges(window: DisabledWindow): MinuteRange[] {
  const start = parseMinute(window.start)
  const end = parseMinute(window.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return []
  if (end > start) return [[start, end]]
  const ranges: MinuteRange[] = [[start, MINUTES_PER_DAY]]
  if (end > 0) ranges.push([0, end])
  return ranges
}

function windowsOverlap(left: DisabledWindow, right: DisabledWindow): boolean {
  if ((kindDayMask(left.kind) & kindDayMask(right.kind)) === 0) return false
  const leftRanges = minuteRanges(left)
  const rightRanges = minuteRanges(right)
  for (const a of leftRanges) {
    for (const b of rightRanges) {
      if (a[0] < b[1] && b[0] < a[1]) return true
    }
  }
  return false
}

function windowContains(window: DisabledWindow, minuteOfDay: number): boolean {
  const start = parseMinute(window.start)
  const end = parseMinute(window.end)
  if (start === end) return false
  if (end > start) return minuteOfDay >= start && minuteOfDay < end
  return minuteOfDay >= start || minuteOfDay < end
}

function windowMatchesDay(window: DisabledWindow, branch: DayBranch, weekday: number): boolean {
  const kind = window.kind
  if (kind === 'holiday') return branch === 'holiday'
  if (branch === 'holiday') return false
  if (kind === 'weekday') return branch === 'weekday'
  if (kind === 'weekend') return branch === 'weekend'
  return kind.includes(WEEKDAYS[weekday])
}

function branchAt(
  parts: LocalParts,
  holidays: ReadonlySet<string>,
  workdays: ReadonlySet<string>,
): DayBranch {
  // A makeup workday (调休上班日) outranks the weekend/holiday rules: it is a
  // working day even when it falls on a Saturday or inside a holiday range.
  if (workdays.has(parts.dateKey)) return 'weekday'
  if (holidays.has(parts.dateKey)) return 'holiday'
  return parts.weekday >= 5 ? 'weekend' : 'weekday'
}

function blockingWindowAt(
  parts: LocalParts,
  windows: readonly DisabledWindow[],
  holidays: ReadonlySet<string>,
  workdays: ReadonlySet<string>,
): DisabledWindow | null {
  const branch = branchAt(parts, holidays, workdays)
  const minuteOfDay = parts.hour * 60 + parts.minute
  for (const window of windows) {
    if (windowMatchesDay(window, branch, parts.weekday) && windowContains(window, minuteOfDay)) return window
  }
  return null
}

function firstAvailableAt(
  nowMs: number,
  formatter: Intl.DateTimeFormat,
  windows: readonly DisabledWindow[],
  holidays: ReadonlySet<string>,
  workdays: ReadonlySet<string>,
): number | null {
  const firstMinute = Math.floor(nowMs / 60_000) + 1
  let offset = 0
  while (offset < MAX_SCAN_MINUTES) {
    const candidate = (firstMinute + offset) * 60_000
    const parts = localPartsWith(formatter, candidate)
    if (parts === null) return null
    if (blockingWindowAt(parts, windows, holidays, workdays) === null) return candidate
    // A local day whose every minute is blocked cannot contain an answer, so
    // skip to the next local midnight in one step instead of scanning 1440
    // blocked minutes. Verify the jump lands exactly on the next midnight; on a
    // DST transition (offset change) fall back to a one-minute step.
    const jump = wholeDayBlocked(parts, windows, holidays, workdays)
      ? nextLocalMidnightJump(parts, formatter, firstMinute + offset)
      : 1
    offset += jump
  }
  return null
}

/**
 * Minutes from `parts`' instant to the next local midnight, but only when a
 * minute-granularity jump lands exactly on 00:00 of a later local date.
 * Otherwise returns 1 (the caller scans minute by minute for correctness across
 * timezone-offset transitions).
 */
function nextLocalMidnightJump(
  parts: LocalParts,
  formatter: Intl.DateTimeFormat,
  candidateMinute: number,
): number {
  const jump = MINUTES_PER_DAY - (parts.hour * 60 + parts.minute)
  if (jump <= 1) return 1
  const target = localPartsWith(formatter, (candidateMinute + jump) * 60_000)
  if (target === null) return 1
  if (target.hour === 0 && target.minute === 0 && target.dateKey !== parts.dateKey) return jump
  return 1
}

/** True when every minute of the local day is disabled for this day's branch. */
function wholeDayBlocked(
  parts: LocalParts,
  windows: readonly DisabledWindow[],
  holidays: ReadonlySet<string>,
  workdays: ReadonlySet<string>,
): boolean {
  const branch = branchAt(parts, holidays, workdays)
  const ranges: MinuteRange[] = []
  for (const window of windows) {
    if (windowMatchesDay(window, branch, parts.weekday)) ranges.push(...minuteRanges(window))
  }
  if (ranges.length === 0) return false
  ranges.sort((left, right) => left[0] - right[0])
  let reach = 0
  for (const [from, to] of ranges) {
    if (from > reach) return false
    if (to > reach) reach = to
    if (reach >= MINUTES_PER_DAY) return true
  }
  return reach >= MINUTES_PER_DAY
}

function toHolidaySet(holidays: ReadonlySet<string> | readonly string[]): Set<string> {
  return toDateSet(holidays)
}

function toWorkdaySet(workdays: ReadonlySet<string> | readonly string[] | undefined): Set<string> {
  return toDateSet(workdays)
}

function toDateSet(values: ReadonlySet<string> | readonly string[] | undefined | null): Set<string> {
  if (values === null || values === undefined) return new Set()
  const set = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed !== '') set.add(trimmed)
  }
  return set
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(timeZone)
  if (cached !== undefined) return cached
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    formatterCache.set(timeZone, formatter)
    return formatter
  } catch {
    return null
  }
}

function localPartsWith(formatter: Intl.DateTimeFormat, nowMs: number): LocalParts | null {
  let formatted: Intl.DateTimeFormatPart[]
  try {
    formatted = formatter.formatToParts(new Date(nowMs))
  } catch {
    return null
  }

  let year = Number.NaN
  let month = Number.NaN
  let day = Number.NaN
  let hour = Number.NaN
  let minute = Number.NaN
  for (const part of formatted) {
    switch (part.type) {
      case 'year':
        year = Number(part.value)
        break
      case 'month':
        month = Number(part.value)
        break
      case 'day':
        day = Number(part.value)
        break
      case 'hour':
        hour = Number(part.value)
        break
      case 'minute':
        minute = Number(part.value)
        break
      default:
        break
    }
  }
  if (![year, month, day, hour, minute].every((value) => Number.isFinite(value))) return null

  const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7
  const dateKey = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`
  return { year, month, day, hour, minute, weekday, dateKey }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}
