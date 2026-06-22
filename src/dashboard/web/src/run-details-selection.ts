import type { RunDetailsSection } from './types'

export type RunDetailsSelector = {
  stepId: string
  agent?: string
  runnerId?: string
  sessionId?: string
}

export type RunDetailsSelectionResult =
  | { status: 'selected'; section: RunDetailsSection; candidates: RunDetailsSection[] }
  | { status: 'none'; candidates: RunDetailsSection[] }
  | { status: 'unresolved'; candidates: RunDetailsSection[] }

export function selectorKey(selector?: RunDetailsSelector): string {
  if (!selector) return ''
  return [
    selector.stepId,
    selector.agent,
    selector.runnerId || '',
    selector.sessionId || '',
  ].join('|')
}

export function selectRunDetailsSection(
  sections: RunDetailsSection[],
  selector: RunDetailsSelector,
): RunDetailsSelectionResult {
  if (!selector.agent) return { status: 'none', candidates: [] }

  const candidates = sections.filter((section) => (
    section.kind === 'session' &&
    section.stepId === selector.stepId &&
    section.agent === selector.agent
  ))

  if (candidates.length === 0) return { status: 'none', candidates }

  const exact = candidates.find((section) => (
    Boolean(selector.runnerId && section.runnerId === selector.runnerId) ||
    Boolean(selector.sessionId && section.sessionId === selector.sessionId)
  ))
  if (exact) return { status: 'selected', section: exact, candidates }

  if (candidates.length === 1) return { status: 'selected', section: candidates[0], candidates }

  return { status: 'unresolved', candidates }
}
