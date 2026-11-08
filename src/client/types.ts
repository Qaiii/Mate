import type { MateState, MateController } from './controller.js'
import type { Translator } from './locales.js'
import { formatZonedClock } from './scheduleDraft.js'
import type { ProjectSource, QueueEntryView, RequirementView } from '../shared.js'

/** Why a requirement needs the user's attention, if it does. */
export type UserAttention = 'reply' | 'confirm'

export function userAttention(requirement: RequirementView): UserAttention | null {
  if (requirement.status === 'clarifying') return 'reply'
  if (requirement.status === 'proposed') return 'confirm'
  return null
}

/** Result of asking the host for one directory path. */
export interface PickDirectoryResult {
  path: string | null
  /** True when this profile has no usable directory picker. */
  unavailable: boolean
}

/** Props every view of the Mate panel shares. */
export interface PanelContext {
  state: MateState
  controller: MateController
  t: Translator
  openSession: (sessionId: string) => void
  pickDirectory: () => Promise<PickDirectoryResult>
}

export function formatRelative(timestamp: number, lang: 'zh' | 'en'): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const delta = Date.now() - timestamp
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return lang === 'zh' ? '刚刚' : 'just now'
  if (delta < hour) {
    const value = Math.floor(delta / minute)
    return lang === 'zh' ? `${value} 分钟前` : `${value}m ago`
  }
  if (delta < day) {
    const value = Math.floor(delta / hour)
    return lang === 'zh' ? `${value} 小时前` : `${value}h ago`
  }
  const value = Math.floor(delta / day)
  return lang === 'zh' ? `${value} 天前` : `${value}d ago`
}

export function projectLabel(path: string): string {
  if (!path) return '—'
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').pop() ?? path
}

/** Translation key for the requirement's project source badge. */
export function projectSourceLabelKey(source: ProjectSource | undefined): string {
  if (source === 'user') return 'badge.sourceUser'
  if (source === 'user-new') return 'badge.sourceUserNew'
  return 'badge.sourceAuto'
}

/** Short countdown to a future instant, e.g. `2 小时 5 分钟` / `2h 5m`. */
export function formatCountdown(timestamp: number, lang: 'zh' | 'en'): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const delta = timestamp - Date.now()
  if (delta <= 0) return lang === 'zh' ? '即将' : 'any moment'
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return lang === 'zh' ? '不到 1 分钟' : '<1m'
  if (delta < hour) {
    const minutes = Math.ceil(delta / minute)
    return lang === 'zh' ? `${minutes} 分钟` : `${minutes}m`
  }
  if (delta < day) {
    const hours = Math.floor(delta / hour)
    const minutes = Math.ceil((delta % hour) / minute)
    if (minutes === 0) return lang === 'zh' ? `${hours} 小时` : `${hours}h`
    return lang === 'zh' ? `${hours} 小时 ${minutes} 分钟` : `${hours}h ${minutes}m`
  }
  const days = Math.floor(delta / day)
  const hours = Math.ceil((delta % day) / hour)
  if (hours === 0) return lang === 'zh' ? `${days} 天` : `${days}d`
  return lang === 'zh' ? `${days} 天 ${hours} 小时` : `${days}d ${hours}h`
}

/**
 * Compact board/list hint for a requirement waiting on a model window. Shows
 * the expected start clock in the effective scheduling `timezone`, falling back
 * to the plain badge when the wake time or its clock formatting is unknown.
 * Returns `null` for everything that is not `queued` (a stale `queue` object on
 * a cancelled/failed row must never render a queue badge).
 */
export function queueHint(
  requirement: RequirementView,
  t: Translator,
  lang: 'zh' | 'en',
  timezone?: string,
): string | null {
  if (requirement.status !== 'queued') return null
  const queue = requirement.queue
  if (queue == null) return t('queue.badge')
  if (queue.nextWakeAt !== null && Number.isFinite(queue.nextWakeAt) && queue.nextWakeAt > 0) {
    const zone = timezone !== undefined && timezone.trim() !== '' ? timezone : queue.timezone
    const clock = formatZonedClock(queue.nextWakeAt, zone, lang)
    if (clock !== '') return `${t('queue.badgeQueued')} · ${t('queue.startsAt', { clock })}`
    return `${t('queue.badge')} · ${t('queue.resumeIn', { time: formatCountdown(queue.nextWakeAt, lang) })}`
  }
  return t('queue.badge')
}

/** Tooltip/detail line for one queue entry (phase, window, wake, zone, retries). */
export function queueDetail(queue: QueueEntryView, t: Translator, lang: 'zh' | 'en'): string {
  const parts: string[] = [t(`queue.phase.${queue.phase}`)]
  if (queue.window !== undefined && queue.window.length > 0) {
    parts.push(t('queue.window', { window: queue.window }))
  }
  if (queue.nextWakeAt !== null && Number.isFinite(queue.nextWakeAt) && queue.nextWakeAt > 0) {
    parts.push(t('queue.nextWake', { time: formatCountdown(queue.nextWakeAt, lang) }))
  }
  parts.push(t('queue.zone', { zone: queue.timezone }))
  if (queue.attempts > 0) parts.push(t('queue.attempts', { n: queue.attempts }))
  return parts.join(' · ')
}


