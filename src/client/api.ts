import { API, type CommandResponse, type StateResponse } from '../shared.js'

/** One error surfaced to the panel, already user-readable. */
export class MateRequestError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: unknown) {
    super(message)
    this.name = 'MateRequestError'
  }
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new MateRequestError('transport', `HTTP ${response.status}: ${text.slice(0, 240) || '(empty body)'}`)
  }
  const envelope = parsed as { ok?: boolean; value?: unknown; error?: { code?: string; message?: string; detail?: unknown } }
  if (envelope.ok !== true) {
    throw new MateRequestError(
      envelope.error?.code ?? 'transport',
      envelope.error?.message ?? `HTTP ${response.status}`,
      envelope.error?.detail,
    )
  }
  return envelope.value as T
}

export function fetchState(rev: number | undefined, signal?: AbortSignal): Promise<StateResponse> {
  return postJson<StateResponse>(API.state, rev === undefined ? {} : { rev }, signal)
}

export function runCommand(
  command: string,
  args: Record<string, unknown>,
  requestId: string,
  signal?: AbortSignal,
): Promise<CommandResponse> {
  return postJson<unknown>(API.command, { command, args, requestId }, signal).then((value) => ({ ok: true, value }))
}
