import { describe, expect, it } from 'vitest'
import type { QueueEntryView, RequirementView } from '../shared.js'
import { createTranslator } from './locales.js'
import { queueHint } from './types.js'

const t = createTranslator('zh')

function queueEntry(overrides: Partial<QueueEntryView> = {}): QueueEntryView {
  return {
    phase: 'analyze',
    reason: 'model-window',
    model: null,
    enqueuedAt: 0,
    nextWakeAt: Date.parse('2026-11-09T16:30:00Z'), // 2026-11-10 00:30 Asia/Shanghai
    timezone: 'Asia/Shanghai',
    attempts: 0,
    ...overrides,
  }
}

function requirement(overrides: Partial<RequirementView> = {}): RequirementView {
  return {
    id: 'req_1',
    number: 1,
    title: 'R',
    brief: 'R',
    projectPath: '',
    projectTitle: '',
    priority: 'normal',
    mateId: 'mate_1',
    mateName: 'Mate',
    mateModel: 'p/m',
    parentId: null,
    kind: 'requirement',
    status: 'queued',
    autonomy: 'auto',
    sessionOverrides: null,
    discussion: [],
    analysis: null,
    plan: null,
    dispatch: null,
    result: null,
    errors: [],
    queue: queueEntry(),
    createdAt: 0,
    updatedAt: 0,
    rev: 1,
    ...overrides,
  } as RequirementView
}

describe('queueHint', () => {
  it('shows the expected start clock in the effective zone', () => {
    expect(queueHint(requirement(), t, 'zh', 'Asia/Shanghai')).toBe('排队等待 · 预计 00:30 开始')
  })

  it('falls back to the queue entry zone when no effective zone is passed', () => {
    expect(queueHint(requirement(), createTranslator('en'), 'en')).toBe('Queued · starts ~00:30')
  })

  it('shows the plain badge when the expected start is unknown', () => {
    expect(queueHint(requirement({ queue: queueEntry({ nextWakeAt: null }) }), t, 'zh')).toBe('等待模型时段')
  })

  it('returns null for every non-queued status even with stale queue metadata', () => {
    for (const status of ['cancelled', 'done', 'failed', 'running', 'proposed', 'approved', 'analyzing'] as const) {
      expect(queueHint(requirement({ status }), t, 'zh', 'Asia/Shanghai')).toBeNull()
    }
  })

  it('shows the plain badge for a queued requirement whose queue entry is not stored yet', () => {
    expect(queueHint(requirement({ queue: null }), t, 'zh')).toBe('等待模型时段')
  })
})
