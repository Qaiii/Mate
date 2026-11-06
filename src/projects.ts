import { isAbsolute, resolve } from 'node:path'
import { statSync } from 'node:fs'

export interface ProjectPathResult {
  ok: boolean
  path: string
  error?: { code: string; message: string }
}

/**
 * Normalize a user-supplied project path: must be absolute, trailing slashes
 * are stripped, and separators collapse to the platform's native form. This is
 * the value we store and the key we compare against live session cwds.
 */
export function normalizeProjectPath(input: string): ProjectPathResult {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return { ok: false, path: '', error: { code: 'empty-path', message: 'A project path is required' } }
  }
  if (!isAbsolute(trimmed)) {
    return { ok: false, path: '', error: { code: 'not-absolute', message: 'The project path must be absolute' } }
  }
  let value = resolve(trimmed)
  value = value.replace(/[\\/]+$/, '')
  // Keep the separator on drive roots (C:\) so the path stays usable.
  if (/^[A-Za-z]:$/.test(value)) value += '\\'
  if (value.length === 0) {
    return { ok: false, path: '', error: { code: 'empty-path', message: 'A project path is required' } }
  }
  return { ok: true, path: value }
}

/** True when `path` exists on disk and is a directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
