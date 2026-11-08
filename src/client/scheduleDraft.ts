/**
 * Settings-page helpers for the model availability schedule.
 *
 * The browser half has no DOM test harness, so every decision worth testing
 * (holiday range/year expansion, de-duplication, window-kind switching and the
 * validation-to-localized-copy mapping) lives in this plain module. It is pure
 * except for the explicit `Date.now()` in {@link tryModelAvailability}, which
 * only feeds the live availability preview.
 */
import { resolveHolidayCalendar } from '../holidays.js'
import { WEEKDAYS, describeWindow, isModelAvailable, modelAvailabilityAt, validateScheduleConfig } from '../schedule.js'
import type { AvailabilityResult, ScheduleValidation, ValidationIssue } from '../schedule.js'
import type { HolidayCalendar } from '../holidays.js'
import type {
  DisabledWindow,
  ModelSchedule,
  ScheduleConfig,
  ScheduleDayKind,
  WeekdayCode,
} from '../shared.js'
import type { Translator } from './locales.js'

/** A disabled-window configuration with no routes, holidays, workdays or override. */
export function emptyScheduleDraft(): ScheduleConfig {
  return { models: [], holidays: [], workdays: [], useBuiltinHolidays: true, timezone: null }
}

/**
 * Deep copy of a persisted schedule so editing never mutates the snapshot in
 * place. Tolerates a missing/legacy value from an older Host: absent
 * `workdays`/`useBuiltinHolidays` read as an empty list / the built-in data on.
 */
export function cloneSchedule(config: ScheduleConfig | null | undefined): ScheduleConfig {
  return {
    models: (config?.models ?? []).map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      disabledWindows: (entry.disabledWindows ?? []).map((window) => ({
        kind: Array.isArray(window.kind) ? [...window.kind] : window.kind,
        start: window.start,
        end: window.end,
      })),
    })),
    holidays: [...(config?.holidays ?? [])],
    workdays: [...(config?.workdays ?? [])],
    useBuiltinHolidays: config?.useBuiltinHolidays !== false,
    timezone: config?.timezone ?? null,
  }
}

/**
 * Resolve the effective holiday / makeup-workday calendar of a draft, or `null`
 * when the pure resolver is unavailable. Never throws: the settings preview is
 * advisory and must not crash on a half-edited configuration.
 */
export function tryResolveHolidayCalendar(config: ScheduleConfig | null | undefined): HolidayCalendar | null {
  try {
    return resolveHolidayCalendar(config)
  } catch {
    return null
  }
}

/** The four choices the window-kind `<select>` offers. */
export type WindowKindChoice = 'weekday' | 'weekend' | 'holiday' | 'weekdays'

/** Map a stored kind onto the selector value. `weekdays` = explicit weekday list. */
export function windowKindChoice(kind: ScheduleDayKind | undefined): WindowKindChoice {
  if (Array.isArray(kind)) return 'weekdays'
  if (kind === 'weekend' || kind === 'holiday' || kind === 'weekday') return kind
  return 'weekday'
}

/** The weekday list a kind implies when the user switches to "specific days". */
export function impliedWeekdays(kind: ScheduleDayKind | undefined): WeekdayCode[] {
  if (kind === 'weekend') return ['sat', 'sun']
  if (Array.isArray(kind)) return kind.length > 0 ? WEEKDAYS.filter((code) => kind.includes(code)) : ['mon']
  if (kind === 'weekday') return ['mon', 'tue', 'wed', 'thu', 'fri']
  return ['mon']
}

/** Apply a selector choice, keeping the times and seeding the weekday list. */
export function withWindowKind(window: DisabledWindow, choice: WindowKindChoice): DisabledWindow {
  if (choice === 'weekdays') return { ...window, kind: impliedWeekdays(window.kind) }
  return { ...window, kind: choice }
}

/** Toggle one weekday checkbox; the caller renders an empty list as an error. */
export function toggleWeekday(window: DisabledWindow, code: WeekdayCode): DisabledWindow {
  const current = Array.isArray(window.kind) ? window.kind : []
  const next = current.includes(code) ? current.filter((item) => item !== code) : [...current, code]
  return { ...window, kind: WEEKDAYS.filter((item) => next.includes(item)) }
}

/** A new window starts as an evening block, mirroring the docs example. */
export function newDisabledWindow(): DisabledWindow {
  return { kind: 'weekday', start: '22:00', end: '06:00' }
}

const DAY_MS = 86_400_000
/** Cap for a single range/expansion so a typo cannot hang the renderer. */
export const MAX_HOLIDAY_RANGE_DAYS = 3660

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Build a `YYYY-MM-DD` key without touching the local clock. */
export function dateKeyOf(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`
}

/** Parse a real calendar date key, or `null` for bad shape / impossible dates. */
export function parseDateKey(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return { year, month, day }
}

export function isRealDateKey(value: string): boolean {
  return parseDateKey(value) !== null
}

export type RangeExpansion =
  | { dates: string[]; error: null }
  | { dates: []; error: 'invalid' | 'too-long' }

/**
 * Expand an inclusive date range into individual `YYYY-MM-DD` keys. Both ends
 * are validated as real dates; a reversed or over-long range is reported so the
 * dialog can explain why nothing was added.
 */
export function expandHolidayRange(from: string, to: string): RangeExpansion {
  const start = parseDateKey(from)
  const end = parseDateKey(to)
  if (start === null || end === null) return { dates: [], error: 'invalid' }
  const startMs = Date.UTC(start.year, start.month - 1, start.day)
  const endMs = Date.UTC(end.year, end.month - 1, end.day)
  if (endMs < startMs) return { dates: [], error: 'invalid' }
  const total = Math.round((endMs - startMs) / DAY_MS) + 1
  if (total > MAX_HOLIDAY_RANGE_DAYS) return { dates: [], error: 'too-long' }
  const dates: string[] = []
  for (let cursor = startMs; cursor <= endMs; cursor += DAY_MS) {
    const date = new Date(cursor)
    dates.push(dateKeyOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()))
  }
  return { dates, error: null }
}

/** Parse the bulk-year input; only a four-digit year is accepted. */
export function parseHolidayYear(value: string): number | null {
  const trimmed = value.trim()
  if (!/^\d{4}$/.test(trimmed)) return null
  const year = Number(trimmed)
  return year >= 1000 && year <= 9999 ? year : null
}

export interface YearExpansion {
  dates: string[]
  invalid: string[]
}

/**
 * Expand a whitespace/comma separated `MM-DD` list into one year's dates.
 * Invalid tokens are returned verbatim so the dialog can list them.
 */
export function expandYearHolidays(yearValue: string, input: string): YearExpansion {
  const tokens = input
    .split(/[\s,，、;；]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
  const year = parseHolidayYear(yearValue)
  if (year === null) {
    return { dates: [], invalid: tokens.length > 0 ? tokens : [yearValue.trim()].filter((token) => token.length > 0) }
  }
  const dates: string[] = []
  const invalid: string[] = []
  for (const token of tokens) {
    const match = /^(\d{1,2})-(\d{1,2})$/.exec(token)
    if (match === null) {
      invalid.push(token)
      continue
    }
    const key = dateKeyOf(year, Number(match[1]), Number(match[2]))
    if (isRealDateKey(key)) dates.push(key)
    else invalid.push(token)
  }
  return { dates, invalid }
}

/** Merge new dates into the existing list, dropping duplicates and sorting. */
export function mergeHolidays(current: readonly string[], additions: readonly string[]): string[] {
  const set = new Set(current.filter(isRealDateKey))
  for (const date of additions) {
    if (isRealDateKey(date)) set.add(date)
  }
  return [...set].sort()
}

/** Delete a list of individual dates. */
export function removeHolidayDates(current: readonly string[], dates: readonly string[]): string[] {
  const removed = new Set(dates)
  return current.filter((date) => !removed.has(date))
}

/** Bulk-delete every date of one year. */
export function removeHolidayYear(current: readonly string[], year: string): string[] {
  const prefix = `${year.trim()}-`
  return current.filter((date) => !date.startsWith(prefix))
}

/** Group the sorted holiday list by year, ascending. */
export function groupHolidays(holidays: readonly string[]): Array<{ year: string; dates: string[] }> {
  const byYear = new Map<string, string[]>()
  for (const date of [...holidays].sort()) {
    const year = date.slice(0, 4)
    const dates = byYear.get(year) ?? []
    dates.push(date)
    byYear.set(year, dates)
  }
  return [...byYear.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([year, dates]) => ({ year, dates }))
}

/**
 * Validate the edited draft. The Host is authoritative and rejects the same
 * config server-side; a thrown validator is degraded to one shape error so the
 * dialog can still explain the failure instead of crashing.
 */
export function validateScheduleDraft(raw: unknown): ScheduleValidation {
  try {
    return validateScheduleConfig(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, errors: [{ code: 'shape', path: '', message }] }
  }
}

/** Every issue whose dotted path is the prefix itself or a child of it. */
export function issuesFor(errors: readonly ValidationIssue[], prefix: string): ValidationIssue[] {
  if (prefix.length === 0) return [...errors]
  return errors.filter((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`))
}

/**
 * Localized copy for one issue (`schedule.err.<code>`), falling back to the
 * validator's English message when no translation exists.
 */
export function issueMessage(t: Translator, issue: ValidationIssue): string {
  const key = `schedule.err.${issue.code}`
  const localized = t(key)
  return localized === key ? issue.message : localized
}

/** Live availability preview; `null` when the pure judge is unavailable. */
export function tryModelAvailability(
  entry: ModelSchedule | undefined,
  timezone: string,
  holidays: ReadonlySet<string> | readonly string[],
  workdays?: ReadonlySet<string> | readonly string[],
): AvailabilityResult | null {
  try {
    return isModelAvailable(Date.now(), entry, timezone, holidays, workdays)
  } catch {
    return null
  }
}

/** One-line window summary for tooltips; degrades when describeWindow throws. */
export function windowSummary(window: DisabledWindow): string {
  try {
    return describeWindow(window)
  } catch {
    return `${window.start}-${window.end}`
  }
}

/**
 * Format an instant in the scheduling zone for the live status line. Falls back
 * to the browser locale formatting when the zone id is unknown.
 */
export function formatZonedDateTime(timestamp: number, timezone: string, lang?: 'zh' | 'en'): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
  const locale = lang === 'zh' ? 'zh-CN' : lang === 'en' ? 'en-US' : undefined
  const options: Intl.DateTimeFormatOptions = {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }
  try {
    return new Intl.DateTimeFormat(locale, options).format(new Date(timestamp))
  } catch {
    return new Date(timestamp).toLocaleString(locale)
  }
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>()

function clockFormatterFor(timezone: string): Intl.DateTimeFormat | null {
  const cached = clockFormatters.get(timezone)
  if (cached !== undefined) return cached
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    clockFormatters.set(timezone, formatter)
    return formatter
  } catch {
    return null
  }
}

function clockFromFormatter(formatter: Intl.DateTimeFormat, timestamp: number): string {
  try {
    const parts = formatter.formatToParts(new Date(timestamp))
    let hour = ''
    let minute = ''
    for (const part of parts) {
      if (part.type === 'hour') hour = part.value
      else if (part.type === 'minute') minute = part.value
    }
    if (hour === '' || minute === '') return ''
    return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  } catch {
    return ''
  }
}

/**
 * `HH:mm` of one instant in the scheduling `timezone` (the queue's expected
 * start clock). Returns `''` for an unusable timestamp so the caller can fall
 * back; an unknown zone degrades to the browser's local clock instead of
 * throwing.
 */
export function formatZonedClock(timestamp: number, timezone: string, lang?: 'zh' | 'en'): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const zone = typeof timezone === 'string' ? timezone.trim() : ''
  const formatter = zone === '' ? null : clockFormatterFor(zone)
  if (formatter !== null) {
    const formatted = clockFromFormatter(formatter, timestamp)
    if (formatted !== '') return formatted
  }
  try {
    const date = new Date(timestamp)
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  } catch {
    return ''
  }
}

/** Aggregate live availability of every route in the model catalog. */
export interface CatalogAvailability {
  /** Routes judged (catalog size after de-duplication). */
  total: number
  /** Routes available at the judged instant. */
  available: number
  /** Earliest instant any unavailable route becomes available, when known. */
  earliestStart: number | null
}

export interface CatalogAvailabilityInput {
  /** Host server time (snapshot.serverTime), not the browser clock. */
  nowMs: number
  schedule: ScheduleConfig | null | undefined
  catalog: ReadonlyArray<{ provider: string; models: ReadonlyArray<{ id: string }> }>
  /** Effective scheduling zone, e.g. `settings.timezone.id`. */
  timezone: string
}

/**
 * Judge every catalog route with the pure availability API, folding in the
 * effective holiday + makeup-workday calendar. `null` when there is nothing to
 * judge (empty catalog / unusable instant) or the pure judge throws, so the
 * panel can stay silent instead of crashing.
 */
export function catalogAvailability(input: CatalogAvailabilityInput): CatalogAvailability | null {
  if (!Number.isFinite(input.nowMs) || input.nowMs <= 0) return null
  const routes = catalogRoutes(input.catalog)
  if (routes.length === 0) return null
  try {
    const calendar = resolveHolidayCalendar(input.schedule)
    const judgements = modelAvailabilityAt({
      nowMs: input.nowMs,
      schedule: input.schedule,
      routes,
      timezone: input.timezone,
      holidays: calendar.holidays,
      workdays: calendar.workdays,
    })
    let available = 0
    let earliestStart: number | null = null
    for (const judgement of judgements) {
      if (judgement.available) {
        available += 1
        continue
      }
      const at = judgement.nextAvailableAt
      if (at !== null && Number.isFinite(at) && at > 0 && (earliestStart === null || at < earliestStart)) {
        earliestStart = at
      }
    }
    return { total: judgements.length, available, earliestStart }
  } catch {
    return null
  }
}

/**
 * Flatten the settings catalog into unique provider/model routes. The Host
 * judges duplicate routes fine, but a badge should count each route once.
 */
function catalogRoutes(
  catalog: ReadonlyArray<{ provider: string; models: ReadonlyArray<{ id: string }> }>,
): Array<{ provider: string; model: string }> {
  const seen = new Set<string>()
  const routes: Array<{ provider: string; model: string }> = []
  for (const group of catalog) {
    for (const entry of group.models) {
      const key = `${group.provider}\u0000${entry.id}`
      if (seen.has(key)) continue
      seen.add(key)
      routes.push({ provider: group.provider, model: entry.id })
    }
  }
  return routes
}
