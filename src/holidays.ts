/**
 * Built-in China statutory-holiday and 调休 (makeup workday) data, plus the pure
 * resolver that folds it together with the user's manual overrides.
 *
 * CONTRACT (owner: schedule-core). This module is pure and isomorphic: it must
 * not import `node:*`, read the system clock, or open I/O, so the browser half
 * can compute the same calendar as the Host half. It never throws: a missing or
 * broken data bundle degrades to "no holiday rules" (weekend-only judging) and
 * reports that through {@link HolidayCalendar.degraded}, which the Host logs.
 *
 * Data sources (official State Council notices):
 * - 2024: 国办发明电〔2023〕7号
 *   https://www.gov.cn/gongbao/2023/issue_10806/202311/content_6913823.html
 * - 2025: 国办发明电〔2024〕12号
 *   https://www.gov.cn/gongbao/2024/issue_11726/202411/content_6989767.html
 * - 2026: 国办发明电〔2025〕7号
 *   https://www.gov.cn/zhengce/content/202511/content_7047090.htm
 *
 * A year's `holidays` list is the announced 放假调休 range (including weekend
 * days that belong to the arrangement); `workdays` is the announced 调休上班日
 * list. Dates outside the covered years fall back to the weekend rule.
 */
import type { ScheduleConfig } from './shared.js'

/** Days off and makeup workdays of one calendar year. */
export interface HolidayYearData {
  /** `YYYY-MM-DD` public-holiday days off. */
  holidays: string[]
  /** `YYYY-MM-DD` makeup workdays (调休上班日), usually a Saturday/Sunday. */
  workdays: string[]
}

/** One refreshable holiday dataset (built-in today; an injected bundle may replace it). */
export interface HolidayDataBundle {
  /** Year (`'2024'`) → data. Only four-digit years are honoured. */
  years: Record<string, HolidayYearData>
  /** Diagnostic data-source label, e.g. `'builtin-cn'`. */
  source: string
  /** Last data revision marker, for docs/diagnostics. */
  updatedAt?: string
}

/** The years shipped in {@link BUILTIN_HOLIDAY_DATA}. */
export const BUILTIN_HOLIDAY_YEARS: readonly number[] = [2024, 2025, 2026]

/**
 * The built-in dataset. Update this object (and {@link BUILTIN_HOLIDAY_YEARS})
 * when a new year's notice is published; manual overrides can fill a gap
 * without a code change.
 */
export const BUILTIN_HOLIDAY_DATA: HolidayDataBundle = {
  source: 'builtin-cn',
  updatedAt: '2025-11-04',
  years: {
    // 国办发明电〔2023〕7号
    '2024': {
      holidays: [
        '2024-01-01',
        // 春节 2/10 - 2/17
        '2024-02-10', '2024-02-11', '2024-02-12', '2024-02-13',
        '2024-02-14', '2024-02-15', '2024-02-16', '2024-02-17',
        // 清明 4/4 - 4/6
        '2024-04-04', '2024-04-05', '2024-04-06',
        // 劳动节 5/1 - 5/5
        '2024-05-01', '2024-05-02', '2024-05-03', '2024-05-04', '2024-05-05',
        // 端午 6/10（与周末连休）
        '2024-06-10',
        // 中秋 9/15 - 9/17
        '2024-09-15', '2024-09-16', '2024-09-17',
        // 国庆 10/1 - 10/7
        '2024-10-01', '2024-10-02', '2024-10-03', '2024-10-04',
        '2024-10-05', '2024-10-06', '2024-10-07',
      ],
      workdays: [
        '2024-02-04', '2024-02-18', '2024-04-07', '2024-04-28',
        '2024-05-11', '2024-09-14', '2024-09-29', '2024-10-12',
      ],
    },
    // 国办发明电〔2024〕12号
    '2025': {
      holidays: [
        '2025-01-01',
        // 春节 1/28 - 2/4
        '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31',
        '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04',
        // 清明 4/4 - 4/6
        '2025-04-04', '2025-04-05', '2025-04-06',
        // 劳动节 5/1 - 5/5
        '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05',
        // 端午 5/31 - 6/2
        '2025-05-31', '2025-06-01', '2025-06-02',
        // 国庆节、中秋节 10/1 - 10/8
        '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04',
        '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08',
      ],
      workdays: ['2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11'],
    },
    // 国办发明电〔2025〕7号
    '2026': {
      holidays: [
        // 元旦 1/1 - 1/3
        '2026-01-01', '2026-01-02', '2026-01-03',
        // 春节 2/15 - 2/23
        '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
        '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
        // 清明 4/4 - 4/6
        '2026-04-04', '2026-04-05', '2026-04-06',
        // 劳动节 5/1 - 5/5
        '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
        // 端午 6/19 - 6/21
        '2026-06-19', '2026-06-20', '2026-06-21',
        // 中秋 9/25 - 9/27
        '2026-09-25', '2026-09-26', '2026-09-27',
        // 国庆 10/1 - 10/7
        '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
        '2026-10-05', '2026-10-06', '2026-10-07',
      ],
      workdays: ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10'],
    },
  },
}

/** The data source used when no override bundle is injected. */
export function defaultHolidayData(): HolidayDataBundle {
  return BUILTIN_HOLIDAY_DATA
}

/**
 * Effective day sets derived from the built-in/injected data plus the user's
 * manual overrides. Consumed by the availability judge.
 *
 * Precedence (later wins): built-in data < manual `holidays` < manual `workdays`.
 * So a manual holiday removes a built-in makeup workday, and a manual workday
 * removes a built-in holiday. All sets are plain date-key sets; absence of a
 * date means "ordinary weekend/weekday rule".
 */
export interface HolidayCalendar {
  /** `YYYY-MM-DD` dates judged as public holidays. */
  holidays: ReadonlySet<string>
  /** `YYYY-MM-DD` dates judged as working days even when they fall on a weekend. */
  workdays: ReadonlySet<string>
  /** Years the data bundle actually covers (built-in coverage, not manual dates). */
  coveredYears: ReadonlySet<number>
  /** Any year requested through {@link ResolveHolidayOptions.year} the data does not cover. */
  missingYears: readonly number[]
  /**
   * True when the built-in data was wanted but is unavailable or does not cover
   * the judged year: the judge then applies only the weekend rule (plus manual
   * overrides). The Host logs this once instead of failing.
   */
  degraded: boolean
  /** Data-source label for diagnostics (`'builtin-cn'`, `'none'`, or injected). */
  source: string
}

export interface ResolveHolidayOptions {
  /**
   * Replace/refresh the built-in bundle. `undefined` uses the built-in data;
   * `null` simulates a failed data load (weekend-only fallback).
   */
  data?: HolidayDataBundle | null
  /** Local year about to be judged; when set, missing coverage is reported. */
  year?: number
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Fold the data bundle and manual overrides into effective sets. Never throws:
 * malformed entries are skipped, a broken bundle degrades to weekend-only.
 */
export function resolveHolidayCalendar(
  config?: ScheduleConfig | null,
  options: ResolveHolidayOptions = {},
): HolidayCalendar {
  const schedule = config ?? null
  const useBuiltin = schedule?.useBuiltinHolidays !== false
  const bundle = options.data === undefined ? BUILTIN_HOLIDAY_DATA : options.data
  const holidays = new Set<string>()
  const workdays = new Set<string>()
  const coveredYears = new Set<number>()
  let source = bundle === null ? 'none' : (typeof bundle.source === 'string' && bundle.source.trim() !== '' ? bundle.source : 'unknown')

  try {
    if (useBuiltin && bundle !== null && typeof bundle === 'object') {
      for (const [yearKey, entry] of Object.entries(bundle.years ?? {})) {
        if (!/^\d{4}$/.test(yearKey) || entry === null || typeof entry !== 'object') continue
        coveredYears.add(Number(yearKey))
        addDateKeys(holidays, entry.holidays)
        addDateKeys(workdays, entry.workdays)
      }
    }

    // Manual holidays win over built-in makeup workdays.
    for (const date of schedule?.holidays ?? []) {
      if (!isDateKey(date)) continue
      holidays.add(date)
      workdays.delete(date)
    }
    // Manual makeup workdays win over manual and built-in holidays.
    for (const date of schedule?.workdays ?? []) {
      if (!isDateKey(date)) continue
      workdays.add(date)
      holidays.delete(date)
    }
  } catch {
    // A malformed injected bundle must never break scheduling: drop the holiday
    // rules and let the caller log the degradation.
    holidays.clear()
    workdays.clear()
    return {
      holidays,
      workdays,
      coveredYears: new Set<number>(),
      missingYears: options.year === undefined ? [] : [options.year],
      degraded: useBuiltin,
      source: 'unavailable',
    }
  }

  const missingYears = options.year !== undefined && !coveredYears.has(options.year) ? [options.year] : []
  const dataUnavailable = bundle === null
  return {
    holidays,
    workdays,
    coveredYears,
    missingYears,
    degraded: useBuiltin && (dataUnavailable || missingYears.length > 0),
    source,
  }
}

function addDateKeys(target: Set<string>, dates: readonly string[] | undefined): void {
  if (!Array.isArray(dates)) return
  for (const date of dates) {
    if (isDateKey(date)) target.add(date)
  }
}

function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && DATE_KEY_PATTERN.test(value)
}
