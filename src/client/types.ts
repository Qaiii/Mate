import type { MateState, MateController } from './controller.js'
import type { Translator } from './locales.js'
import type { ProjectSource } from '../shared.js'

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

