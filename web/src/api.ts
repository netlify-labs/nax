import type { DryRunOptions, DryRunResponse, HealthResponse, RunDetailsResponse, RunGraphResponse, RunsResponse, StartRunResponse, WorkflowGraphResponse, WorkflowListResponse, VisualizeRun } from './types'

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: {
      accept: 'application/json',
    },
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = payload?.error?.message || `Request failed with ${response.status}`
    throw new Error(message)
  }
  return payload as T
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

function sessionToken(): string {
  const params = new URLSearchParams(window.location.search)
  return params.get('token') || ''
}

function withSessionToken(path: string): string {
  const token = sessionToken()
  if (!token) {
    return path
  }
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}token=${encodeURIComponent(token)}`
}

export async function runWorkflowDryRun(id: string, options: DryRunOptions): Promise<DryRunResponse> {
  const response = await fetch(`/api/workflows/${encodeURIComponent(id)}/dry-run`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-nax-token': sessionToken(),
    },
    body: JSON.stringify(options),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = payload?.error?.message || payload?.dryRun?.stderr || `Dry-run failed with ${response.status}`
    throw new Error(message)
  }
  return payload as DryRunResponse
}

export async function startWorkflowRun(id: string, options: DryRunOptions): Promise<StartRunResponse> {
  const response = await fetch(`/api/workflows/${encodeURIComponent(id)}/runs`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-nax-token': sessionToken(),
    },
    body: JSON.stringify(options),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = payload?.error?.message || `Run failed with ${response.status}`
    throw new Error(message)
  }
  return payload as StartRunResponse
}

export async function cancelWorkflowRun(id: string): Promise<{ run: VisualizeRun; cancelled: boolean }> {
  const response = await fetch(`/api/runs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'x-nax-token': sessionToken(),
    },
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = payload?.error?.message || `Cancel failed with ${response.status}`
    throw new Error(message)
  }
  return payload as { run: VisualizeRun; cancelled: boolean }
}

export function runEventsUrl(id: string): string {
  return withSessionToken(`/api/runs/${encodeURIComponent(id)}/events`)
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
