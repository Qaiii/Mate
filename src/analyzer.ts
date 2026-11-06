import type { AnalysisView, MateView, ModelSelection, RequirementView, ResultView } from './shared.js'

/** The subset of `ctx.llm` the analyzer needs; keeps the class unit-testable. */
export interface LlmGateway {
  stream(request: LlmStreamRequest): AsyncIterable<LlmStreamChunk>
}

export interface LlmStreamRequest {
  provider: string
  model: string
  reasoningEffort?: string
  system?: string
  messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface LlmStreamChunk {
  type: string
  text?: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

export interface ProjectOption {
  path: string
  title: string
}

export interface AnalyzeInput {
  requirement: Pick<RequirementView, 'title' | 'brief' | 'projectPath' | 'projectTitle' | 'discussion'>
  mate: MateView
  projects: ProjectOption[]
  models: Array<{ provider: string; name: string; models: Array<{ id: string; name: string }> }>
  language: string
  maxTokens: number
  signal?: AbortSignal
}

export interface AnalyzeOutput {
  analysis: AnalysisView
  usage: { inputTokens: number; outputTokens: number }
  raw: string
}

export interface SummarizeInput {
  requirement: Pick<RequirementView, 'title' | 'brief' | 'analysis' | 'plan' | 'discussion'>
  mate: MateView
  transcript: string
  language: string
  maxTokens: number
  signal?: AbortSignal
}

export interface SummarizeOutput {
  result: ResultView
  usage: { inputTokens: number; outputTokens: number }
  raw: string
}

const ANALYSIS_CONTRACT = `Return ONE JSON object and nothing else, with this exact shape:
{
  "title": "short requirement title in the user's language",
  "summary": "one paragraph in the user's language",
  "confidence": 0.0,
  "needsClarification": false,
  "questions": ["..."],
  "subTasks": [{ "title": "...", "detail": "how to do it", "acceptance": "how to verify" }],
  "risks": ["..."],
  "splitSuggestion": [{ "title": "...", "brief": "...", "acceptance": "..." }],
  "suggestedProjectPath": null,
  "sessionModel": { "provider": "...", "model": "..." }
}
Rules:
- "title" is a concise label (at most 40 characters) you would put on a card; never repeat the whole request.
- "confidence" is your own 0..1 judgement that you fully understand the requirement and can dispatch it without asking anything.
- Set "needsClarification" true and fill "questions" when the requirement leaves real decisions open; use the user's language. Ask only what actually blocks a correct dispatch.
- "subTasks" are the concrete work items an implementing agent should do, 1-8 items, each with a verifiable acceptance point.
- "splitSuggestion" is non-empty ONLY when the requirement is too large for one session; give 2-6 independent child requirements that could each be dispatched separately. You own this decision; the user does not configure it.
- "suggestedProjectPath" must be one of the listed project paths, or null.
- "sessionModel" is the model the implementing session should use, picked from the listed models, or null to keep the default. The user did not choose it; you decide.
- Never wrap the JSON in markdown fences.`

const SUMMARY_CONTRACT = `Return ONE JSON object and nothing else, with this exact shape:
{
  "doneSummary": "what was actually done, in the user's language",
  "acceptance": [{ "item": "the acceptance point being judged", "met": true }],
  "remaining": ["work that is not finished"],
  "followUps": ["recommended next steps"]
}
Rules:
- Judge each acceptance point from the requirement against the transcript evidence; do not invent work.
- If the transcript is missing or inconclusive, say so in "doneSummary" and keep "met" false where evidence is absent.
- Never wrap the JSON in markdown fences.`

function languageName(language: string): string {
  if (language.toLowerCase().startsWith('zh')) return 'Simplified Chinese'
  return 'English'
}

function projectsBlock(projects: ProjectOption[]): string {
  if (projects.length === 0) return '(no projects are currently registered)'
  return projects.slice(0, 40).map((project) => `- ${project.path}  (${project.title})`).join('\n')
}

function modelsBlock(models: AnalyzeInput['models']): string {
  if (models.length === 0) return '(no model catalog is available)'
  return models.map((group) =>
    `${group.provider} (${group.name}): ${group.models.map((model) => model.id).join(', ')}`).join('\n')
}

function clip(text: string, limit: number): string {
  const value = text.trim()
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…(truncated)`
}

function discussionBlock(entries: RequirementView['discussion']): string {
  if (entries.length === 0) return '(no prior discussion)'
  return clip(entries.map((entry) => `${entry.role === 'user' ? 'User' : 'Mate'}: ${entry.text}`).join('\n'), 6000)
}

/** First balanced JSON object in `text`, tolerating fences and leading prose. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asStringArray(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, limit)
}

function asConfidence(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.min(1, Math.max(0, numeric))
}

export function normalizeAnalysis(raw: Record<string, unknown>, provider?: string, model?: string): AnalysisView {
  const subTasks = Array.isArray(raw.subTasks)
    ? raw.subTasks.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item, index) => ({
        id: `st-${index + 1}`,
        title: asString(item.title, `Step ${index + 1}`),
        detail: asString(item.detail),
        acceptance: asString(item.acceptance),
      })).slice(0, 10)
    : []
  const splitSuggestion = Array.isArray(raw.splitSuggestion)
    ? raw.splitSuggestion.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        title: asString(item.title),
        brief: asString(item.brief),
        acceptance: asString(item.acceptance),
      }))
      .filter((item) => item.title.length > 0)
      .slice(0, 8)
    : []
  const suggested = raw.suggestedProjectPath
  const sessionModelRaw = raw.sessionModel
  const sessionModel = sessionModelRaw !== null && typeof sessionModelRaw === 'object'
    ? (() => {
      const record = sessionModelRaw as Record<string, unknown>
      const provider = asString(record.provider)
      const model = asString(record.model)
      return provider.length > 0 && model.length > 0 ? { provider, model } : null
    })()
    : null
  const title = asString(raw.title).trim()
  return {
    provider,
    model,
    ...(title.length > 0 ? { title: title.slice(0, 80) } : {}),
    sessionModel,
    summary: asString(raw.summary, '(no summary)'),
    confidence: asConfidence(raw.confidence),
    needsClarification: raw.needsClarification === true || asStringArray(raw.questions).length > 0,
    subTasks,
    risks: asStringArray(raw.risks),
    questions: asStringArray(raw.questions),
    splitSuggestion,
    suggestedProjectPath: typeof suggested === 'string' && suggested.trim().length > 0 ? suggested.trim() : null,
    at: Date.now(),
  }
}

export function normalizeResult(raw: Record<string, unknown>, provider?: string, model?: string): ResultView {
  const acceptance = Array.isArray(raw.acceptance)
    ? raw.acceptance.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({ item: asString(item.item), met: item.met === true }))
      .filter((item) => item.item.length > 0)
      .slice(0, 20)
    : []
  return {
    provider,
    model,
    doneSummary: asString(raw.doneSummary, '(no summary)'),
    acceptance,
    remaining: asStringArray(raw.remaining),
    followUps: asStringArray(raw.followUps),
    at: Date.now(),
  }
}

/**
 * Requirement analysis and result summarization on the Mate's own model.
 * One repair round is attempted when the model returns unusable JSON.
 */
export class MateAnalyzer {
  constructor(private readonly llm: LlmGateway) {}

  async analyze(input: AnalyzeInput): Promise<AnalyzeOutput> {
    const { mate, requirement } = input
    const system = [
      `You are ${mate.name}, a project manager inside DeepSeek Harness.`,
      mate.specialty ? `Your specialty: ${mate.specialty}.` : '',
      mate.persona ? `Working style: ${mate.persona}` : '',
      'You turn a short human requirement into a dispatchable plan for coding agents.',
      `Answer in ${languageName(input.language)}.`,
      '',
      'Projects available for dispatch (absolute path followed by a title):',
      projectsBlock(input.projects),
      '',
      'Models available for the implementing session (provider: model ids):',
      modelsBlock(input.models),
      '',
      'Output contract:',
      ANALYSIS_CONTRACT,
    ].filter((line) => line.length > 0).join('\n')

    const user = [
      requirement.title.length > 0 && requirement.title !== requirement.brief.slice(0, requirement.title.length)
        ? `Requirement title: ${requirement.title}`
        : '',
      requirement.projectPath.length > 0 ? `Project: ${requirement.projectTitle} (${requirement.projectPath})` : '',
      '',
      'Requirement:',
      clip(requirement.brief, 8000),
      '',
      'Discussion so far:',
      discussionBlock(requirement.discussion),
    ].filter((line, index, lines) => !(line === '' && (index === 0 || lines[index - 1] === ''))).join('\n')

    return this.callJson({
      config: mate.model,
      system,
      user,
      maxTokens: input.maxTokens,
      signal: input.signal,
      normalize: (raw) => normalizeAnalysis(raw, mate.model.provider, mate.model.model),
      shape: (value) => ({ analysis: value as AnalysisView }),
    })
  }

  async summarize(input: SummarizeInput): Promise<SummarizeOutput> {
    const { mate, requirement } = input
    const acceptance = (requirement.analysis?.subTasks ?? [])
      .map((task) => `- ${task.title}${task.acceptance ? ` (acceptance: ${task.acceptance})` : ''}`)
      .join('\n')
    const system = [
      `You are ${mate.name}, a project manager inside DeepSeek Harness reviewing delivered work.`,
      mate.persona ? `Working style: ${mate.persona}` : '',
      `Answer in ${languageName(input.language)}.`,
      '',
      'Output contract:',
      SUMMARY_CONTRACT,
    ].filter((line) => line.length > 0).join('\n')

    const user = [
      `Requirement: ${requirement.title}`,
      clip(requirement.brief, 4000),
      '',
      'Planned sub tasks:',
      acceptance || '(none recorded)',
      '',
      'Session transcript excerpt:',
      clip(input.transcript, 12000),
    ].join('\n')

    return this.callJson({
      config: mate.model,
      system,
      user,
      maxTokens: input.maxTokens,
      signal: input.signal,
      normalize: (raw) => normalizeResult(raw, mate.model.provider, mate.model.model),
      shape: (value) => ({ result: value as ResultView }),
    })
  }

  private async callJson<T, R extends object>(input: {
    config: ModelSelection
    system: string
    user: string
    maxTokens: number
    signal?: AbortSignal
    normalize: (raw: Record<string, unknown>) => T
    shape: (value: T) => R
  }): Promise<R & { usage: { inputTokens: number; outputTokens: number }; raw: string }> {
    const first = await this.callText(input.config, input.system, input.user, input.maxTokens, input.signal)
    const parsed = parseOrThrow(first.text)
    if (parsed !== null) {
      const value = input.normalize(parsed)
      return { ...input.shape(value), usage: first.usage, raw: first.text }
    }

    const repair = [
      input.user,
      '',
      'Your previous answer could not be parsed as the required JSON object.',
      'Previous answer (truncated):',
      clip(first.text, 2000),
      '',
      'Return the corrected JSON object only.',
    ].join('\n')
    const second = await this.callText(input.config, input.system, repair, input.maxTokens, input.signal)
    const repaired = parseOrThrow(second.text)
    if (repaired === null) {
      throw new Error('model returned no usable JSON object')
    }
    const value = input.normalize(repaired)
    return {
      ...input.shape(value),
      usage: {
        inputTokens: first.usage.inputTokens + second.usage.inputTokens,
        outputTokens: first.usage.outputTokens + second.usage.outputTokens,
      },
      raw: second.text,
    }
  }

  private async callText(
    config: ModelSelection,
    system: string,
    user: string,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
    const usage = { inputTokens: 0, outputTokens: 0 }
    let text = ''
    const stream = this.llm.stream({
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens,
      temperature: 0.2,
      signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
      } else if (chunk.type === 'usage' && chunk.usage) {
        usage.inputTokens += chunk.usage.inputTokens ?? 0
        usage.outputTokens += chunk.usage.outputTokens ?? 0
      }
    }
    return { text, usage }
  }
}

function parseOrThrow(text: string): Record<string, unknown> | null {
  const json = extractJsonObject(text)
  if (json === null) return null
  try {
    const value = JSON.parse(json)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

