import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isDirectory, normalizeProjectPath } from './projects.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mate-project-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

describe('normalizeProjectPath', () => {
  it('rejects empty input', () => {
    expect(normalizeProjectPath('   ').ok).toBe(false)
  })

  it('rejects relative input', () => {
    expect(normalizeProjectPath('relative/dir').ok).toBe(false)
  })

  it('keeps an absolute path absolute and strips trailing separators', () => {
    const base = makeTempDir()
    const result = normalizeProjectPath(base + '\\')
    expect(result.ok).toBe(true)
    expect(result.path).toBe(resolve(base))
    expect(result.path.endsWith('\\')).toBe(false)
    expect(result.path.endsWith('/')).toBe(false)
  })

  it('unifies Windows separators to the native form', () => {
    const base = makeTempDir()
    const mixed = base.replace(/\\/g, '/') + '/'
    const result = normalizeProjectPath(mixed)
    expect(result.ok).toBe(true)
    expect(result.path).toBe(resolve(base))
  })
})

describe('isDirectory', () => {
  it('is true for an existing directory', () => {
    expect(isDirectory(makeTempDir())).toBe(true)
  })

  it('is false for a missing path', () => {
    expect(isDirectory(join(makeTempDir(), 'does-not-exist'))).toBe(false)
  })
})
