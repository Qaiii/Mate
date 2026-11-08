import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { COMMANDS, type MateView, type Snapshot } from '../shared.js'
import { runCommand } from './api.js'
import {
  COMPOSE_MATE_STORAGE_KEY,
  COMPOSE_MATE_STORAGE_VERSION,
  clearLastMateId,
  composePayload,
  composeStorage,
  readLastMateId,
  resolveComposeMateId,
  writeLastMateId,
  type ComposeStorage,
} from './compose.js'
import type { MateController } from './controller.js'
import { ComposeDialog } from './dialogs.js'
import { createTranslator } from './locales.js'

/**
 * An in-memory localStorage stand-in. Two handles over the same backing map
 * behave like two browser tabs sharing one origin.
 */
function memoryStorage(backing = new Map<string, string>()): ComposeStorage & { backing: Map<string, string> } {
  return {
    backing,
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => { backing.set(key, value) },
    removeItem: (key) => { backing.delete(key) },
  }
}

/** A storage whose every operation throws, like a blocked/private context. */
const deniedStorage: ComposeStorage = {
  getItem: () => { throw new Error('storage is blocked') },
  setItem: () => { throw new Error('storage is blocked') },
  removeItem: () => { throw new Error('storage is blocked') },
}

function mate(id: string, name: string): MateView {
  return {
    id,
    name,
    description: '',
    specialty: '',
    model: { provider: 'p', model: 'm' },
    dispatchModel: null,
    autonomy: 'auto',
    confidenceThreshold: 0.75,
    maxParallel: 1,
    allowSplit: true,
    persona: '',
    createdAt: 0,
    updatedAt: 0,
    archived: false,
  }
}

function snapshotWith(mates: MateView[], defaultMateId: string | null = null): Snapshot {
  return {
    rev: 1,
    mates,
    requirements: [],
    projects: [],
    liveSessions: [],
    settings: {
      defaultMateId,
      pollMs: 2500,
      reuseIdleSession: false,
      version: '0.1.0',
      lastStartedAt: null,
      lastProjectPath: null,
      modelCatalog: [],
      schedule: { models: [], holidays: [], timezone: null },
      timezone: { id: 'UTC', source: 'host' },
      contextCompression: { enabled: false, threshold: 80 },
    },
    serverTime: 0,
  }
}

function storedEnvelope(mateId: string): string {
  return JSON.stringify({ version: COMPOSE_MATE_STORAGE_VERSION, mateId })
}

describe('last Mate persistence', () => {
  it('stores a versioned envelope under the versioned key', () => {
    expect(COMPOSE_MATE_STORAGE_KEY).toBe('dsh-mate.compose.last-mate.v1')
    expect(COMPOSE_MATE_STORAGE_VERSION).toBe(1)

    const storage = memoryStorage()
    expect(writeLastMateId('mate_b', storage)).toBe(true)
    expect(storage.backing.get(COMPOSE_MATE_STORAGE_KEY)).toBe('{"version":1,"mateId":"mate_b"}')
    expect(readLastMateId(storage)).toBe('mate_b')
  })

  it('reads no preference when no browser storage exists', () => {
    expect(composeStorage()).toBeNull()
    expect(readLastMateId()).toBeNull()
    expect(writeLastMateId('mate_b')).toBe(false)
  })

  it('treats blocked storage as no preference instead of throwing', () => {
    expect(readLastMateId(deniedStorage)).toBeNull()
    expect(writeLastMateId('mate_b', deniedStorage)).toBe(false)
    expect(() => clearLastMateId(deniedStorage)).not.toThrow()
  })

  it('ignores unreadable, malformed, foreign-version and empty records', () => {
    const storage = memoryStorage()
    const invalid = [
      '',
      'not json at all',
      '{"version":1',
      '{}',
      '[]',
      'null',
      '"mate_a"',
      '{"version":2,"mateId":"mate_a"}',
      '{"version":"1","mateId":"mate_a"}',
      '{"mateId":"mate_a"}',
      '{"version":1,"mateId":""}',
      '{"version":1,"mateId":42}',
      '{"version":1,"mateId":null}',
    ]
    for (const raw of invalid) {
      storage.backing.set(COMPOSE_MATE_STORAGE_KEY, raw)
      expect(readLastMateId(storage), `raw value: ${raw}`).toBeNull()
    }
  })

  it('clears the saved pick', () => {
    const storage = memoryStorage()
    writeLastMateId('mate_a', storage)
    clearLastMateId(storage)
    expect(readLastMateId(storage)).toBeNull()
  })

  it('lets the last write win across tabs and the next open reads it', () => {
    const shared = new Map<string, string>()
    const tabOne = memoryStorage(shared)
    const tabTwo = memoryStorage(shared)
    writeLastMateId('mate_a', tabOne)
    writeLastMateId('mate_c', tabTwo)
    expect(readLastMateId(memoryStorage(shared))).toBe('mate_c')
  })
})

describe('resolveComposeMateId', () => {
  const mates = [mate('mate_a', 'Alpha'), mate('mate_b', 'Beta')]

  it('prefers the remembered Mate while it still exists', () => {
    expect(resolveComposeMateId('mate_b', mates, 'mate_a')).toBe('mate_b')
  })

  it('falls back to the configured default when the remembered Mate is gone', () => {
    expect(resolveComposeMateId('mate_gone', mates, 'mate_b')).toBe('mate_b')
  })

  it('falls back to the first Mate when the remembered and default Mates are gone', () => {
    expect(resolveComposeMateId('mate_gone', mates, 'mate_gone_too')).toBe('mate_a')
  })

  it('ignores missing records and a missing default', () => {
    expect(resolveComposeMateId(null, mates, null)).toBe('mate_a')
    expect(resolveComposeMateId(null, mates, 'mate_b')).toBe('mate_b')
  })

  it('returns no selection for an empty Mate list', () => {
    expect(resolveComposeMateId('mate_a', [], 'mate_a')).toBe('')
  })
})

describe('composePayload', () => {
  it('carries the selected Mate as mateId', () => {
    expect(composePayload('  ship it  ', 'mate_b', { source: 'user', path: 'D:\\repo', title: 'repo' }))
      .toEqual({
        brief: 'ship it',
        mateId: 'mate_b',
        projectSource: 'user',
        projectPath: 'D:\\repo',
        projectTitle: 'repo',
      })
  })

  it('omits projectTitle for auto targets', () => {
    expect(composePayload('ship it', 'mate_a', { source: 'auto', path: '' }))
      .toEqual({ brief: 'ship it', mateId: 'mate_a', projectSource: 'auto', projectPath: '' })
  })
})

describe('requirement.create request', () => {
  it('posts the selected Mate id with the send request', async () => {
    const requests: Array<{ path: string; body: { command?: string; args?: Record<string, unknown> } }> = []
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      requests.push({ path, body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ ok: true, value: { id: 'req_1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const payload = { ...composePayload('ship it', 'mate_b', { source: 'auto', path: '' }) }
      await runCommand(COMMANDS.requirementCreate, payload, 'req-test')
    } finally {
      vi.unstubAllGlobals()
    }

    expect(requests).toHaveLength(1)
    expect(requests[0]?.path).toBe('api/dsh-mate/command')
    expect(requests[0]?.body.command).toBe('requirement.create')
    expect(requests[0]?.body.args?.mateId).toBe('mate_b')
    expect(requests[0]?.body.args?.brief).toBe('ship it')
  })
})

/** ComposeDialog only needs the command channel for manual project registration. */
function renderComposeDialog(snapshot: Snapshot): string {
  const controller = { run: async () => null } as unknown as MateController
  return renderToStaticMarkup(
    React.createElement(ComposeDialog, {
      snapshot,
      controller,
      t: createTranslator('zh'),
      busy: false,
      onPickDirectory: async () => ({ path: null, unavailable: true }),
      onClose: (): void => { /* noop in SSR */ },
      onSubmit: (): void => { /* noop in SSR */ },
    }),
  )
}

/** Render with a browser-like localStorage so the dialog reads a stored pick. */
function renderWithStorage(snapshot: Snapshot, storedRaw: string | null): string {
  const storage = memoryStorage()
  if (storedRaw !== null) storage.backing.set(COMPOSE_MATE_STORAGE_KEY, storedRaw)
  vi.stubGlobal('window', { localStorage: storage })
  try {
    return renderComposeDialog(snapshot)
  } finally {
    vi.unstubAllGlobals()
  }
}

function selectedOptionIds(markup: string): string[] {
  return [...markup.matchAll(/<option value="([^"]*)" selected=""/g)].map((match) => match[1] ?? '')
}

describe('ComposeDialog Mate selector', () => {
  const mates = [mate('mate_a', 'Alpha'), mate('mate_b', 'Beta')]

  it('always shows the selector with every active Mate', () => {
    const markup = renderWithStorage(snapshotWith(mates, 'mate_a'), null)
    expect(markup).toContain('aria-label="交给哪个 Mate"')
    expect(markup).toContain('value="mate_a"')
    expect(markup).toContain('value="mate_b"')
    expect(markup).toContain('Alpha')
    expect(markup).toContain('Beta')
  })

  it('opens on the remembered Mate, beating the configured default', () => {
    const markup = renderWithStorage(snapshotWith(mates, 'mate_a'), storedEnvelope('mate_b'))
    expect(selectedOptionIds(markup)).toContain('mate_b')
    expect(selectedOptionIds(markup)).not.toContain('mate_a')
  })

  it('opens on the configured default on first use', () => {
    const markup = renderWithStorage(snapshotWith(mates, 'mate_b'), null)
    expect(selectedOptionIds(markup)).toContain('mate_b')
  })

  it('falls back silently when the stored value is corrupt', () => {
    const markup = renderWithStorage(snapshotWith(mates, 'mate_b'), '{"version":1,"mateId":')
    expect(selectedOptionIds(markup)).toContain('mate_b')
  })

  it('falls back silently when the stored Mate no longer exists', () => {
    const markup = renderWithStorage(snapshotWith(mates, 'mate_b'), storedEnvelope('mate_deleted'))
    expect(selectedOptionIds(markup)).toContain('mate_b')
    expect(markup).not.toContain('mate_deleted')
  })

  it('first Mate wins when there is neither a remembered nor a default Mate', () => {
    const markup = renderWithStorage(snapshotWith(mates, null), storedEnvelope('mate_deleted'))
    expect(selectedOptionIds(markup)).toContain('mate_a')
  })

  it('disables the selector but keeps rendering when no Mate exists', () => {
    const markup = renderWithStorage(snapshotWith([], null), storedEnvelope('mate_a'))
    expect(markup).toMatch(/<select[^>]*disabled=""[^>]*aria-label="交给哪个 Mate"/)
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>发送<\/button>/)
  })
})

