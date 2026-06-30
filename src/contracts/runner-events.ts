export type RunnerEvent = {
  id?: number
  schemaVersion?: number
  generatedBy?: {
    name?: string
    version?: string
  }
  seq?: number
  eventId?: string
  type: string
  at?: string
  runId?: string
  flowId?: string
  flowTitle?: string
  status?: string
  stepId?: string
  stepTitle?: string
  agent?: string
  runnerId?: string
  sessionId?: string
  issueNumber?: number | null
  issueUrl?: string
  links?: Record<string, string>
  command?: string[]
  exitCode?: number | null
  signal?: string | null
  durationMs?: number
  text?: string
  message?: string
  [key: string]: unknown
}
