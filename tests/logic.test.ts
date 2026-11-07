import { describe, expect, it } from 'vitest'
import { extractJsonObject, normalizeAnalysis, normalizeMemory, normalizeResult } from '../src/analyzer.js'
import { mergeMemory, parseDispatchModels, resolveDispatchModel } from '../src/app.js'
import { buildBrief } from '../src/dispatch.js'
import { isTerminal, statusLabel } from '../src/shared.js'
import type { MateView, RequirementView } from '../src/shared.js'

const mate: MateView = {
  id: 'mate_1',
  name: 'Planner',
  description: '',
  specialty: 'breaking work down',
  model: { provider: 'p', model: 'm' },
  dispatchModel: null,
  autonomy: 'confirm',
  confidenceThreshold: 0.75,
  maxParallel: 2,
  allowSplit: true,
  persona: '',
  createdAt: 0,
  updatedAt: 0,
  archived: false,
}

function requirement(overrides: Partial<RequirementView> = {}): RequirementView {
  return {
    id: 'req_1',
    number: 1,
    title: 'Add empty states',
    brief: 'Each board column needs a hint when empty.',
    projectPath: 'D:\\repo',
    projectTitle: 'repo',
    priority: 'normal',
    mateId: 'mate_1',
    mateName: 'Planner',
    mateModel: 'p/m',
    parentId: null,
    kind: 'requirement',
    status: 'proposed',
    autonomy: 'confirm',
    sessionOverrides: null,
    discussion: [],
    analysis: {
      provider: 'p',
      model: 'm',
      summary: 'summary',
      confidence: 0.8,
      needsClarification: false,
      subTasks: [
        { id: 'st-1', title: 'Find the column config', detail: 'search the board', acceptance: 'paths listed' },
      ],
      risks: [],
      questions: [],
      splitSuggestion: [],
      suggestedProjectPath: null,
      at: 0,
    },
    plan: null,
    dispatch: null,
    result: null,
    errors: [],
    createdAt: 0,
    updatedAt: 0,
    rev: 1,
    ...overrides,
  }
}

describe('extractJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}')
  })

  it('ignores markdown fences and leading prose', () => {
    expect(extractJsonObject('here you go:\n```json\n{"a":{"b":"}"}}\n```')).toBe('{"a":{"b":"}"}}')
  })

  it('respects escaped quotes and nested braces', () => {
    const text = '{"a":"say \\"hi\\"","b":{"c":[1,2]}}'
    expect(extractJsonObject(text)).toBe(text)
  })

  it('returns null without a complete object', () => {
    expect(extractJsonObject('no json here')).toBeNull()
    expect(extractJsonObject('{"a":1')).toBeNull()
  })
})

describe('normalizeAnalysis', () => {
  it('fills defaults and clamps confidence', () => {
    const value = normalizeAnalysis({ summary: 's', confidence: 3, subTasks: [{ title: 't' }] })
    expect(value.confidence).toBe(1)
    expect(value.needsClarification).toBe(false)
    expect(value.subTasks[0]).toMatchObject({ id: 'st-1', title: 't', detail: '', acceptance: '' })
    expect(value.splitSuggestion).toEqual([])
    expect(value.suggestedProjectPath).toBeNull()
  })

  it('treats questions as a clarification signal', () => {
    const value = normalizeAnalysis({ questions: ['Which project?'] })
    expect(value.needsClarification).toBe(true)
    expect(value.questions).toEqual(['Which project?'])
  })

  it('keeps the title and priority the Mate judged', () => {
    const value = normalizeAnalysis({ title: '  卡片空态  ', priority: 'high' })
    expect(value.title).toBe('卡片空态')
    expect(value.priority).toBe('high')
  })

  it('drops an unknown priority and an incomplete session model', () => {
    const value = normalizeAnalysis({ priority: 'urgent', sessionModel: { provider: 'p' } })
    expect(value.priority).toBeUndefined()
    expect(value.sessionModel).toBeNull()
  })
})

describe('normalizeResult', () => {
  it('keeps only well-formed acceptance rows', () => {
    const value = normalizeResult({
      doneSummary: 'done',
      acceptance: [{ item: 'a', met: true }, { met: false }, 'nope'],
      remaining: ['x'],
    })
    expect(value.doneSummary).toBe('done')
    expect(value.acceptance).toEqual([{ item: 'a', met: true }])
    expect(value.remaining).toEqual(['x'])
  })
})

describe('buildBrief', () => {
  it('carries the plan, acceptance points, and the final-message contract', () => {
    const brief = buildBrief(requirement(), mate)
    expect(brief).toContain('# Requirement')
    expect(brief).toContain('Add empty states')
    expect(brief).toContain('Acceptance: paths listed')
    expect(brief).toContain('what you changed')
    expect(brief).not.toContain('Extra instruction')
  })

  it('adds the extra instruction when the plan has one', () => {
    const brief = buildBrief(requirement({
      plan: { targetProjectPath: 'D:\\repo', dispatchMode: 'new', extraInstruction: 'Use TypeScript only', at: 0 },
    }), mate)
    expect(brief).toContain('# Extra instruction')
    expect(brief).toContain('Use TypeScript only')
  })
})

describe('mate memory', () => {
  it('normalizes kinds, drops junk and de-duplicates', () => {
    const entries = normalizeMemory([
      { kind: 'constraint', text: '  只改 apps/web  ' },
      { kind: 'constraint', text: '只改 APPS/WEB' },
      { kind: 'nonsense', text: 'ignored' },
      { kind: 'note', text: '' },
      { kind: 'preference', text: '先给结论' },
    ])
    expect(entries).toEqual([
      { kind: 'constraint', text: '只改 apps/web' },
      { kind: 'preference', text: '先给结论' },
    ])
  })

  it('refuses a non-array payload', () => {
    expect(normalizeMemory('nope')).toEqual([])
    expect(normalizeMemory({ entries: [] })).toEqual([])
  })

  it('folds distilled facts into existing memory without duplicates', () => {
    const existing = [{ id: 'a', kind: 'role' as const, text: '只改 apps/web', createdAt: 1 }]
    const merged = mergeMemory(existing, [
      { kind: 'role', text: '只改 APPS/WEB' },
      { kind: 'preference', text: '先给结论' },
    ], 42)
    expect(merged).toHaveLength(2)
    expect(merged[0]).toEqual(existing[0])
    expect(merged[1]).toMatchObject({ kind: 'preference', text: '先给结论', createdAt: 42 })
    expect(typeof merged[1]?.id).toBe('string')
  })
})

describe('dispatch model restrictions', () => {
  it('keeps valid pairs, drops junk and duplicates', () => {
    const rules = parseDispatchModels([
      { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
      { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
      { provider: 'deepseek-account', model: 'deepseek-flash' },
      { provider: '', model: 'x' },
      { provider: 'p', model: 'm', reasoningEffort: 'low' },
    ])
    expect(rules).toEqual([
      { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
      { provider: 'deepseek-account', model: 'deepseek-flash' },
      { provider: 'p', model: 'm', reasoningEffort: 'low' },
    ])
  })

  it('treats an empty restriction as no restriction', () => {
    expect(parseDispatchModels([])).toBeUndefined()
    expect(resolveDispatchModel([], { provider: 'p', model: 'm' })).toEqual({ provider: 'p', model: 'm' })
  })

  it('maps an off-list pick onto the first allowed pair', () => {
    const rules = [
      { provider: 'a', model: 'x', reasoningEffort: 'high' },
      { provider: 'b', model: 'y' },
    ]
    expect(resolveDispatchModel(rules, { provider: 'c', model: 'z' })).toEqual({ provider: 'a', model: 'x', reasoningEffort: 'high' })
  })

  it('keeps the effort of a matching route instead of the model default', () => {
    const rules = [
      { provider: 'a', model: 'x', reasoningEffort: 'low' },
      { provider: 'a', model: 'x', reasoningEffort: 'max' },
    ]
    expect(resolveDispatchModel(rules, { provider: 'a', model: 'x', reasoningEffort: 'max' }))
      .toEqual({ provider: 'a', model: 'x', reasoningEffort: 'max' })
    expect(resolveDispatchModel(rules, { provider: 'a', model: 'x' }))
      .toEqual({ provider: 'a', model: 'x', reasoningEffort: 'low' })
  })
})

describe('status helpers', () => {
  it('only done and cancelled are terminal', () => {
    expect(isTerminal('done')).toBe(true)
    expect(isTerminal('cancelled')).toBe(true)
    expect(isTerminal('awaiting_review')).toBe(false)
    expect(isTerminal('running')).toBe(false)
  })

  it('labels every status', () => {
    expect(statusLabel('clarifying')).toBe('澄清中')
    expect(statusLabel('awaiting_review')).toBe('待验收')
  })
})
