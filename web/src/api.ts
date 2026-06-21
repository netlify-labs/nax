import type { DryRunOptions, DryRunResponse, HealthResponse, RunDetailsResponse, RunFollowupRequest, RunFollowupResponse, RunGraphResponse, RunsResponse, StartRunResponse, WorkflowGraphResponse, WorkflowListResponse, VisualizeRun } from './types'

function sessionToken(): string {
  const params = new URLSearchParams(window.location.search)
  return params.get('token') || ''
}

function authHeaders(): Record<string, string> {
  const token = sessionToken()
  return token ? { 'x-nax-token': token } : {}
}

async function bootstrapSession(): Promise<void> {
  await fetch('/api/health', {
    headers: {
      accept: 'application/json',
      ...authHeaders(),
    },
  }).catch(() => null)
}

async function fetchJson<T>(path: string, init: RequestInit = {}, retryOnUnauthorized = true): Promise<T> {
  const headers = new Headers(init.headers)
  if (!headers.has('accept')) headers.set('accept', 'application/json')
  for (const [key, value] of Object.entries(authHeaders())) {
    if (!headers.has(key)) headers.set(key, value)
  }
  const response = await fetch(path, {
    ...init,
    headers,
  })
  const payload = await response.json().catch(() => null)
  if (response.status === 401 && retryOnUnauthorized && !sessionToken()) {
    await bootstrapSession()
    return fetchJson<T>(path, init, false)
  }
  if (!response.ok) {
    const message = payload?.error?.message || `Request failed with ${response.status}`
    throw new Error(message)
  }
  return payload as T
}

async function requestJson<T>(path: string): Promise<T> {
  return fetchJson<T>(path)
}

export function listWorkflows(): Promise<WorkflowListResponse> {
  return requestJson<WorkflowListResponse>('/api/workflows')
}

export function getHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>('/api/health')
}

export function getWorkflowGraph(id: string): Promise<WorkflowGraphResponse> {
  return requestJson<WorkflowGraphResponse>(`/api/workflows/${encodeURIComponent(id)}/graph`)
}

export async function runWorkflowDryRun(id: string, options: DryRunOptions): Promise<DryRunResponse> {
  return fetchJson<DryRunResponse>(`/api/workflows/${encodeURIComponent(id)}/dry-run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(options),
  })
}

export async function startWorkflowRun(id: string, options: DryRunOptions): Promise<StartRunResponse> {
  return fetchJson<StartRunResponse>(`/api/workflows/${encodeURIComponent(id)}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(options),
  })
}

export async function cancelWorkflowRun(id: string): Promise<{ run: VisualizeRun; cancelled: boolean; remoteStopped?: number; remoteStopAttempted?: number; warnings?: string[] }> {
  return fetchJson<{ run: VisualizeRun; cancelled: boolean; remoteStopped?: number; remoteStopAttempted?: number; warnings?: string[] }>(`/api/runs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: {
    },
  })
}

export async function cancelFollowupRun(
  id: string,
  target: { stepId?: string; agent?: string; runnerId?: string; sessionId?: string },
): Promise<{ run: VisualizeRun; cancelled: boolean; remoteStopped?: boolean; warnings: string[] }> {
  return fetchJson<{ run: VisualizeRun; cancelled: boolean; remoteStopped?: boolean; warnings: string[] }>(
    `/api/runs/${encodeURIComponent(id)}/followups/cancel`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(target),
    },
  )
}

export async function approveHumanReviewGate(
  id: string,
  target: { stepId?: string },
): Promise<{ run: VisualizeRun; approved: boolean; stepId: string }> {
  return fetchJson<{ run: VisualizeRun; approved: boolean; stepId: string }>(
    `/api/runs/${encodeURIComponent(id)}/review/approve`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(target),
    },
  )
}

export async function cancelHumanReviewGate(
  id: string,
  target: { stepId?: string; reason?: string },
): Promise<{ run: VisualizeRun; cancelled: boolean }> {
  return fetchJson<{ run: VisualizeRun; cancelled: boolean }>(
    `/api/runs/${encodeURIComponent(id)}/review/cancel`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(target),
    },
  )
}

export type RunEventStream = { close: () => void }

export function runEventsStream(
  id: string,
  since = 0,
  handlers: {
    onEvent: (event: MessageEvent<string>) => void
    onClose?: () => void
    onError?: (event: MessageEvent<string> | Error) => void
  },
): RunEventStream {
  const path = since > 0
    ? `/api/runs/${encodeURIComponent(id)}/events?since=${encodeURIComponent(String(since))}`
    : `/api/runs/${encodeURIComponent(id)}/events`
  const controller = new AbortController()
  const dispatchBlock = (block: string) => {
    const eventType = block.match(/^event:\s*(.*)$/m)?.[1] || 'message'
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) return
    const event = new MessageEvent(eventType, { data })
    handlers.onEvent(event)
  }

  void fetch(path, {
    headers: {
      accept: 'text/event-stream',
      ...authHeaders(),
    },
    signal: controller.signal,
  }).then(async (response) => {
    if (!response.ok || !response.body) {
      throw new Error(`Event stream failed with ${response.status}`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split(/\n\n/)
      buffer = parts.pop() || ''
      for (const part of parts) dispatchBlock(part)
    }
    buffer += decoder.decode()
    if (buffer.trim()) dispatchBlock(buffer)
    handlers.onClose?.()
  }).catch((error) => {
    if (!controller.signal.aborted) handlers.onError?.(error instanceof Error ? error : new Error(String(error)))
  })

  return {
    close: () => controller.abort(),
  }
}

export function listRuns(): Promise<RunsResponse> {
  return requestJson<RunsResponse>('/api/runs')
}

export function getRunGraph(id: string): Promise<RunGraphResponse> {
  return requestJson<RunGraphResponse>(`/api/runs/${encodeURIComponent(id)}/graph`)
}

export function getRunDetails(id: string): Promise<RunDetailsResponse> {
  return requestJson<RunDetailsResponse>(`/api/runs/${encodeURIComponent(id)}/details`)
}

export async function startRunFollowup(id: string, options: RunFollowupRequest): Promise<RunFollowupResponse> {
  return fetchJson<RunFollowupResponse>(`/api/runs/${encodeURIComponent(id)}/followups`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(options),
  })
}

export async function openLocalFile(path: string): Promise<{ opened: boolean; path: string }> {
  const response = await fetch('/api/files/open', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({ path }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = payload?.error?.message || `Open failed with ${response.status}`
    throw new Error(message)
  }
  return payload as { opened: boolean; path: string }
}
