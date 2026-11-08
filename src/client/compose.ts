/**
 * Helpers for the compose ("send a requirement") dialog.
 *
 * The browser half cannot read the Host half's settings synchronously, so the
 * Mate the user picked last is remembered in the user's own localStorage: one
 * versioned key holding one versioned JSON envelope. Every storage access is
 * defensive — private mode, disabled storage, corrupt JSON or a Mate that no
 * longer exists all degrade to the same silent fallback chain.
 */
import type { ProjectSource } from '../shared.js'

/** Versioned localStorage key; bump the suffix together with the envelope. */
export const COMPOSE_MATE_STORAGE_KEY = 'dsh-mate.compose.last-mate.v1'

/** Envelope version stored inside the JSON value (must match the key suffix). */
export const COMPOSE_MATE_STORAGE_VERSION = 1

/** The slice of Web Storage this module needs (injectable for tests). */
export interface ComposeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

/** Shape of the stored JSON value. */
export interface ComposeMateRecord {
  version: number
  mateId: string
}

/** The `requirement.create` arguments the compose dialog submits. */
export interface ComposePayload {
  brief: string
  mateId: string
  projectSource: ProjectSource
  projectPath: string
  projectTitle?: string
}

/** localStorage when the page allows it; null in SSR, tests and blocked contexts. */
export function composeStorage(): ComposeStorage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage ?? null
  } catch {
    // Even reading localStorage throws in some private/blocked contexts.
    return null
  }
}

/** An explicit `null` means "unavailable"; `undefined` means "use the browser". */
function resolveStorage(storage: ComposeStorage | null | undefined): ComposeStorage | null {
  return storage === undefined ? composeStorage() : storage
}

/** The persisted Mate id, or null when absent/unreadable/malformed. Never throws. */
export function readLastMateId(storage?: ComposeStorage | null): string | null {
  const target = resolveStorage(storage)
  if (target === null) return null
  let raw: string | null
  try {
    raw = target.getItem(COMPOSE_MATE_STORAGE_KEY)
  } catch {
    return null
  }
  if (raw === null || raw.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const record = parsed as { version?: unknown; mateId?: unknown }
  if (record.version !== COMPOSE_MATE_STORAGE_VERSION) return null
  if (typeof record.mateId !== 'string' || record.mateId.length === 0) return null
  return record.mateId
}

/** Persist the user's pick. Returns false instead of throwing when storage is unavailable. */
export function writeLastMateId(mateId: string, storage?: ComposeStorage | null): boolean {
  if (mateId.length === 0) return false
  const target = resolveStorage(storage)
  if (target === null) return false
  const record: ComposeMateRecord = { version: COMPOSE_MATE_STORAGE_VERSION, mateId }
  try {
    target.setItem(COMPOSE_MATE_STORAGE_KEY, JSON.stringify(record))
    return true
  } catch {
    return false
  }
}

/** Drop the saved pick (manual reset, tests). Never throws. */
export function clearLastMateId(storage?: ComposeStorage | null): void {
  const target = resolveStorage(storage)
  if (target === null || typeof target.removeItem !== 'function') return
  try {
    target.removeItem(COMPOSE_MATE_STORAGE_KEY)
  } catch {
    // A storage that cannot remove is as good as empty for this feature.
  }
}

/**
 * The Mate the dialog opens with: the last pick wins while it still exists,
 * then the configured default, then the first available Mate. An empty list
 * yields '' so the caller can keep the send button disabled as before.
 */
export function resolveComposeMateId(
  persisted: string | null,
  mates: ReadonlyArray<{ id: string }>,
  defaultMateId: string | null,
): string {
  const ids = mates.map((mate) => mate.id)
  if (persisted !== null && ids.includes(persisted)) return persisted
  if (defaultMateId !== null && ids.includes(defaultMateId)) return defaultMateId
  return ids[0] ?? ''
}

/** Assemble the requirement.create payload; the selected Mate always travels as `mateId`. */
export function composePayload(
  brief: string,
  mateId: string,
  project: { source: ProjectSource; path: string; title?: string },
): ComposePayload {
  return {
    brief: brief.trim(),
    mateId,
    projectSource: project.source,
    projectPath: project.path,
    ...(project.title === undefined ? {} : { projectTitle: project.title }),
  }
}
