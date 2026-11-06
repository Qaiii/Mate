import { describe, expect, it } from 'vitest'
import type { AnalysisView } from './shared.js'
import { planAnalysisOutcome, projectSourceOf, resolveDispatchProject, sameProjectPath } from './planning.js'

function analysis(overrides: Partial<AnalysisView> = {}): AnalysisView {
  return {
    summary: 'summary',
    confidence: 0.8,
    needsClarification: false,
    subTasks: [],
    risks: [],
    questions: [],
    splitSuggestion: [],
    suggestedProjectPath: null,
    at: 0,
    ...overrides,
  }
}

describe('sameProjectPath', () => {
  it('ignores trailing slashes and Windows separators', () => {
    expect(sameProjectPath('D:\\CodeProject\\Convey\\', 'D:/CodeProject/Convey')).toBe(true)
    expect(sameProjectPath('D:\\CodeProject\\Convey', 'D:/CodeProject/Convey/')).toBe(true)
  })

  it('compares case-insensitively', () => {
    expect(sameProjectPath('D:\\codeproject\\convey', 'D:\\CodeProject\\Convey')).toBe(true)
  })

  it('treats different paths as different', () => {
    expect(sameProjectPath('D:\\A', 'D:\\B')).toBe(false)
  })
})

describe('projectSourceOf', () => {
  it('defaults undefined to auto', () => {
    expect(projectSourceOf(undefined)).toBe('auto')
  })
})

describe('resolveDispatchProject', () => {
  it('auto mode uses the Mate suggestion', () => {
    expect(resolveDispatchProject({
      projectSource: 'auto',
      projectPath: '',
      analysis: analysis({ suggestedProjectPath: 'D:\\Suggested' }),
    })).toBe('D:\\Suggested')
  })

  it('manual selection wins over the suggestion by default', () => {
    expect(resolveDispatchProject({
      projectSource: 'user',
      projectPath: 'D:\\Chosen',
      analysis: analysis({ suggestedProjectPath: 'D:\\Suggested' }),
    })).toBe('D:\\Chosen')
  })

  it('adopting the Mate switches to the suggestion', () => {
    expect(resolveDispatchProject({
      projectSource: 'user',
      projectPath: 'D:\\Chosen',
      projectResolution: 'mate',
      analysis: analysis({ suggestedProjectPath: 'D:\\Suggested' }),
    })).toBe('D:\\Suggested')
  })

  it('explicit plan target has the highest priority', () => {
    expect(resolveDispatchProject({
      plan: { targetProjectPath: 'D:\\Plan', dispatchMode: 'new', extraInstruction: '', at: 0 },
      projectSource: 'user',
      projectPath: 'D:\\Chosen',
      projectResolution: 'mate',
      analysis: analysis({ suggestedProjectPath: 'D:\\Suggested' }),
    })).toBe('D:\\Plan')
  })
})

describe('planAnalysisOutcome', () => {
  it('marks a manual-vs-suggested mismatch as conflict until resolved', () => {
    const outcome = planAnalysisOutcome({
      projectSource: 'user',
      projectPath: 'D:\\Chosen',
      projectResolution: null,
      autonomy: 'auto',
      analysis: analysis({ suggestedProjectPath: 'D:\\Suggested' }),
    })
    expect(outcome).toEqual({ status: 'conflict', projectResolution: null, conflict: true })
  })

  it('resolves a matching manual selection without a conflict', () => {
    const outcome = planAnalysisOutcome({
      projectSource: 'user',
      projectPath: 'D:\\Chosen',
      projectResolution: null,
      autonomy: 'auto',
      analysis: analysis({ suggestedProjectPath: 'D:\\Chosen' }),
    })
    expect(outcome).toEqual({ status: 'approved', projectResolution: 'user', conflict: false })
  })

  it('keeps an already-resolved conflict from re-asking', () => {
    const outcome = planAnalysisOutcome({
      projectSource: 'user',
      projectPath: 'D:\\Chosen',
      projectResolution: 'user',
      autonomy: 'auto',
      analysis: analysis({ suggestedProjectPath: 'D:\\Suggested' }),
    })
    expect(outcome).toEqual({ status: 'approved', projectResolution: 'user', conflict: true })
  })

  it('confirm autonomy still lands manual selections in proposed', () => {
    const outcome = planAnalysisOutcome({
      projectSource: 'user-new',
      projectPath: 'D:\\Chosen',
      projectResolution: null,
      autonomy: 'confirm',
      analysis: analysis({ suggestedProjectPath: 'D:\\Suggested' }),
    })
    expect(outcome.status).toBe('conflict')
  })
})
