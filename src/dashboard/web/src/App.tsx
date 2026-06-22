import { type CSSProperties, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Code,
  CopyButton,
  Group,
  Modal,
  ScrollArea,
  Splitter,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { Check, Copy, FolderGit2, GitBranch, Moon, RefreshCw, Sun } from 'lucide-react'
import { ReactFlowProvider } from '@xyflow/react'
import { cancelWorkflowRun, getHealth, getRunGraph, getWorkflowGraph, listRuns, listWorkflows, runEventsStream, runWorkflowDryRun, startWorkflowRun, type RunEventStream } from './api'
import { WorkflowOutputTabs } from './components/DryRunPanel'
import { Inspector } from './components/Inspector'
import { MarkdownRenderer } from './components/MarkdownRenderer'
import { RecentRuns } from './components/RecentRuns'
import { RunDetailsModal, type RunDetailsLiveContext } from './components/RunDetailsModal'
import { WorkflowCanvas } from './components/WorkflowCanvas'
import { WorkflowControls } from './components/WorkflowControls'
import { WorkflowList } from './components/WorkflowList'
import { initialLiveRunState, liveRunReducer, visualStatus } from './liveRunReducer'
import { projectWorkflowGraph, workflowGraphNodeByStepId } from './run-projection'
import { recordValue, runId } from './run-format'
import type { RunDetailsSelector } from './run-details-selection'
import type { DryRunOptions, DryRunResult, RunFollowupResponse, RunnerEvent, DashboardRun, Workflow, WorkflowGraph, WorkflowGraphNodeData } from './types'

type ContextModalAction = '' | 'dry-run' | 'run'
type DetailsModalContext = {
  node: WorkflowGraphNodeData
  agent: string
  runId: string
  selector: RunDetailsSelector
}

function parseRunEvent(event: Event): RunnerEvent {
  try {
    return JSON.parse((event as MessageEvent).data) as RunnerEvent
  } catch {
    return { type: 'runner_event_error', message: 'Could not parse run event.' }
  }
}

function stepModelsFromRunGraph(graph: WorkflowGraph): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const node of graph.nodes) {
    const agents = node.data.agents || []
    const selectedAgents = node.data.selectedAgents || []
    if (selectedAgents.length === 0 || selectedAgents.length >= agents.length) continue
    out[node.data.stepId] = selectedAgents
  }
  return out
}

function initialWorkflowFromUrl(): string {
  const params = new URLSearchParams(window.location.search)
  return params.get('workflow') || ''
}

function setWorkflowUrl(id: string) {
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('workflow', id)
  else url.searchParams.delete('workflow')
  window.history.replaceState(null, '', url)
}

function repoNameFromPath(projectRoot: string): string {
  return projectRoot.split('/').filter(Boolean).pop() || projectRoot || 'Repository'
}

function shortHomePath(value: string, projectRoot = ''): string {
  if (!value) return ''
  if (projectRoot.startsWith('/Users/david/dotfiles') && value.startsWith('/Users/david/dotfiles')) {
    return `~/dotfiles${value.slice('/Users/david/dotfiles'.length)}`
  }
  if (projectRoot.startsWith('/Users/david') && value.startsWith('/Users/david')) {
    return `~${value.slice('/Users/david'.length)}`
  }
  return value
}

function runValue(run: Record<string, unknown> | undefined, key: string): string {
  return recordValue(run, key)
}

function runForAgent(node: WorkflowGraphNodeData, agent: string): Record<string, unknown> | undefined {
  for (let index = node.runs.length - 1; index >= 0; index -= 1) {
    const run = node.runs[index]
    if (runValue(run, 'agent') === agent) return run
  }
  return undefined
}

function liveStatusMapsFromRun(run: DashboardRun): {
  stepStatuses: Record<string, string>
  agentStatuses: Record<string, Record<string, string>>
} {
  const stepStatuses: Record<string, string> = {}
  const agentStatuses: Record<string, Record<string, string>> = {}
  for (const step of run.steps || []) {
    const stepId = recordValue(step, 'id')
    if (!stepId) continue
    const stepStatus = recordValue(step, 'status')
    if (stepStatus) stepStatuses[stepId] = visualStatus(stepStatus)
    const runs = Array.isArray(step.runs) ? step.runs : []
    for (const runRecord of runs) {
      if (!runRecord || typeof runRecord !== 'object' || Array.isArray(runRecord)) continue
      const agent = recordValue(runRecord as Record<string, unknown>, 'agent')
      const status = recordValue(runRecord as Record<string, unknown>, 'status')
      if (!agent || !status) continue
      agentStatuses[stepId] = {
        ...(agentStatuses[stepId] || {}),
        [agent]: visualStatus(status),
      }
    }
  }
  return { stepStatuses, agentStatuses }
}

function latestAgentEvent(events: RunnerEvent[], node: WorkflowGraphNodeData, agent: string): RunnerEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'agent_status' && event.stepId === node.stepId && event.agent === agent) return event
  }
  return null
}

function liveAgentUrl(event: RunnerEvent | null): string {
  if (!event) return ''
  const links = event.links || {}
  return links.sessionUrl || links.agentRunUrl || links.issueUrl || event.issueUrl || ''
}

function eventRevisionPart(event: RunnerEvent): string {
  const type = String(event.type || '')
  if (![
    'agent_status',
    'artifact_written',
    'step_status',
    'workflow_awaiting_review',
    'workflow_cancelled',
    'workflow_completed',
    'workflow_failed',
    'exited',
  ].includes(type)) return ''
  return [
    type,
    event.seq ?? event.id ?? '',
    event.stepId || '',
    event.agent || '',
    event.status || '',
    event.runnerId || '',
    event.sessionId || '',
  ].join(':')
}

function savedRunUrl(run: Record<string, unknown> | undefined): string {
  if (!run) return ''
  const links = run.links
  if (links && typeof links === 'object' && !Array.isArray(links)) {
    const typedLinks = links as Record<string, unknown>
    for (const key of ['sessionUrl', 'agentRunUrl', 'commentUrl', 'issueUrl']) {
      const value = typedLinks[key]
      if (typeof value === 'string' && value) return value
    }
  }
  return runValue(run, 'commentUrl') || runValue(run, 'issueUrl')
}

function runIdentifier(run: Partial<DashboardRun>): string {
  return runId(run)
}

function mergeRunLists(active: DashboardRun[], durable: DashboardRun[]): DashboardRun[] {
  const seen = new Set<string>()
  return [...active, ...durable].filter((run) => {
    const id = runIdentifier(run)
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function isTerminalRunStatus(status: string): boolean {
  return ['completed', 'failed', 'timeout', 'cancelled', 'canceled', 'dry-run'].includes(status.toLowerCase())
}

function isActiveRemoteStatus(status: string): boolean {
  return ['pending', 'queued', 'running', 'submitted', 'submitting', 'waiting', 'retrying'].includes(status.toLowerCase())
}

function graphHasActiveRemoteRuns(graph: WorkflowGraph | null): boolean {
  return Boolean(graph?.nodes.some((node) => (
    (node.data.runs || []).some((run) => (
      isActiveRemoteStatus(runValue(run, 'status')) &&
      Boolean(runValue(run, 'runnerId') || runValue(run, 'sessionId'))
    ))
  )))
}

function replaceRunInList(runs: DashboardRun[], nextRun: DashboardRun): DashboardRun[] {
  const nextId = nextRun.runId || nextRun.id
  if (!nextId) return runs
  const filtered = runs.filter((candidate) => candidate.runId !== nextId && candidate.id !== nextId)
  return [nextRun, ...filtered]
}

function sameRun(left: Partial<DashboardRun>, right: Partial<DashboardRun>): boolean {
  const leftIds = [left.id, left.runId].filter(Boolean)
  const rightIds = [right.id, right.runId].filter(Boolean)
  return leftIds.some((id) => rightIds.includes(id))
}

function NetlifyLogo() {
  return (
    <svg
      viewBox="0 0 128 128"
      aria-label="Netlify"
      className="netlify-logo"
      style={{
        '--logoDiamond': 'transparent',
        '--logoN': 'var(--mantine-color-text)',
        '--logoSpark': 'var(--mantine-primary-color-4)',
      } as CSSProperties}
    >
      <path
        fill="var(--logoDiamond)"
        d="m125.2 54.8-52-52L71.3.9 69.2 0H58.8l-2.1.9-1.9 1.9-52 52-1.9 1.9-.9 2.1v10.3l.9 2.1 1.9 1.9 52 52 1.9 1.9 2.1.9h10.3l2.1-.9 1.9-1.9 52-52 1.9-1.9.9-2.1V58.8l-.9-2.1-1.8-1.9z"
      />
      <path
        fill="var(--logoN)"
        d="M78.9 80.5H71l-.7-.7V61.3c0-3.3-1.3-5.9-5.3-6-2-.1-4.4 0-6.9.1l-.4.4v24l-.7.7h-7.9l-.7-.7V48.1l.7-.7H67c6.9 0 12.6 5.6 12.6 12.6v19.8l-.7.7z"
      />
      <path
        fill="var(--logoSpark)"
        d="m38.4 30.8 7.3 7.3v5.8l-.8.8h-5.8l-7.3-7.3v-1.1l5.5-5.5h1.1zm.2 37.2v-8l-.7-.7h-28l-.7.7v8l.7.7H38l.6-.7zm.5 15.7L31.8 91v1.1l5.5 5.5h1.1l7.3-7.3v-5.8l-.8-.8h-5.8zM60 11.3l-.6.7v25l.7.7H68l.7-.7V12l-.7-.7h-8zm0 79.1-.7.7v25l.7.7h8l.7-.7v-25l-.7-.7h-8zm58.1-31h-28l-.7.6v8l.7.7h28.1l.7-.7v-8l-.8-.6z"
      />
    </svg>
  )
}

export default function App() {
  const [navbarOpened, { toggle: toggleNavbar }] = useDisclosure(false)
  const [eventDiagnosticsOpened, { open: openEventDiagnostics, close: closeEventDiagnostics }] = useDisclosure(false)
  const { colorScheme, toggleColorScheme } = useMantineColorScheme()
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [projectRoot, setProjectRoot] = useState('')
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(initialWorkflowFromUrl)
  const [selectedNode, setSelectedNode] = useState<WorkflowGraphNodeData | null>(null)
  const [graph, setGraph] = useState<WorkflowGraph | null>(null)
  const [loadingWorkflows, setLoadingWorkflows] = useState(true)
  const [loadingGraph, setLoadingGraph] = useState(false)
  const [dryRunOptions, setDryRunOptions] = useState<DryRunOptions>({
    branch: 'master',
    transport: 'netlify-api',
    models: [],
    stepModels: {},
    context: '',
    step: '',
    fromStep: '',
  })
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null)
  const [dryRunRunning, setDryRunRunning] = useState(false)
  const [dryRunError, setDryRunError] = useState('')
  const [activeRun, setActiveRun] = useState<DashboardRun | null>(null)
  const [runs, setRuns] = useState<DashboardRun[]>([])
  const [selectedRunId, setSelectedRunId] = useState('')
  const [runOutput, setRunOutput] = useState('')
  const [runRunning, setRunRunning] = useState(false)
  const [cancelRunning, setCancelRunning] = useState(false)
  const [runError, setRunError] = useState('')
  const [liveRunState, dispatchLiveRun] = useReducer(liveRunReducer, initialLiveRunState())
  const liveStepStatuses = liveRunState.stepStatuses
  const liveAgentStatuses = liveRunState.agentStatuses
  const setLiveStepStatuses = useCallback((update: Record<string, string> | ((value: Record<string, string>) => Record<string, string>)) => {
    dispatchLiveRun({ type: 'patch_step_statuses', update })
  }, [])
  const setLiveAgentStatuses = useCallback((update: Record<string, Record<string, string>> | ((value: Record<string, Record<string, string>>) => Record<string, Record<string, string>>)) => {
    dispatchLiveRun({ type: 'patch_agent_statuses', update })
  }, [])
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [contextModalAction, setContextModalAction] = useState<ContextModalAction>('')
  const [contextDraft, setContextDraft] = useState('')
  const [promptNode, setPromptNode] = useState<WorkflowGraphNodeData | null>(null)
  const [detailsModalContext, setDetailsModalContext] = useState<DetailsModalContext | null>(null)
  const dryRunSimulationTimers = useRef<number[]>([])
  const runEventsRef = useRef<RunEventStream | null>(null)
  const runReconnectTimerRef = useRef<number | null>(null)
  const skipWorkflowGraphLoadRef = useRef('')
  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedWorkflowId) || null,
    [workflows, selectedWorkflowId],
  )

  const refreshRuns = useCallback(async (): Promise<DashboardRun[]> => {
    const response = await listRuns()
    const combined = mergeRunLists(response.active, response.durable)
    setRuns(combined)
    return combined
  }, [])

  const clearDryRunSimulation = useCallback(() => {
    for (const timer of dryRunSimulationTimers.current) window.clearTimeout(timer)
    dryRunSimulationTimers.current = []
  }, [])

  const closeRunEvents = useCallback(() => {
    if (runReconnectTimerRef.current) {
      window.clearTimeout(runReconnectTimerRef.current)
      runReconnectTimerRef.current = null
    }
    runEventsRef.current?.close()
    runEventsRef.current = null
  }, [])

  const simulateDryRunStepStatuses = useCallback((options: DryRunOptions) => {
    clearDryRunSimulation()
    const graphNodes = graph?.nodes || []
    const fallbackNodes = (selectedWorkflow?.steps || []).map((step, index) => ({
      data: {
        stepId: step.id,
        agents: step.agents,
        selectedAgents: step.agents,
        graphIndex: index,
      },
    }))
    const nodes = [...(graphNodes.length > 0 ? graphNodes : fallbackNodes)]
      .filter((node) => node.data.stepId && Array.isArray(node.data.agents))
      .sort((a, b) => a.data.graphIndex - b.data.graphIndex)
    const startIndex = options.fromStep ? nodes.findIndex((node) => node.data.stepId === options.fromStep) : 0
    const selectedNodes = options.step
      ? nodes.filter((node) => node.data.stepId === options.step)
      : nodes.slice(Math.max(startIndex, 0))

    setLiveStepStatuses({})
    setLiveAgentStatuses({})
    let elapsedMs = 0
    const firstAgentDelayMs = 5000
    const nextAgentDelayPatternMs = [5000, 4000]
    const nextStepDelayMs = 700

    selectedNodes.forEach((node) => {
      const selectedAgents = Object.prototype.hasOwnProperty.call(options.stepModels, node.data.stepId)
        ? options.stepModels[node.data.stepId]
        : node.data.selectedAgents || node.data.agents
      const completionOrder = ['claude', 'codex', 'gemini']
      const activeAgents = node.data.agents
        .filter((agent) => selectedAgents.includes(agent))
        .sort((left, right) => {
          const leftIndex = completionOrder.indexOf(left)
          const rightIndex = completionOrder.indexOf(right)
          if (leftIndex === -1 && rightIndex === -1) return node.data.agents.indexOf(left) - node.data.agents.indexOf(right)
          if (leftIndex === -1) return 1
          if (rightIndex === -1) return -1
          return leftIndex - rightIndex
        })
      if (activeAgents.length === 0) return

      const stepId = node.data.stepId
      const stepStartMs = elapsedMs
      const startTimer = window.setTimeout(() => {
        setLiveStepStatuses((value) => ({
          ...value,
          [stepId]: 'running',
        }))
        setLiveAgentStatuses((value) => ({
          ...value,
          [stepId]: Object.fromEntries(activeAgents.map((agent) => [agent, 'running'])),
        }))
      }, stepStartMs)
      dryRunSimulationTimers.current.push(startTimer)

      let stepDurationMs = firstAgentDelayMs
      activeAgents.forEach((agent, agentIndex) => {
        if (agentIndex > 0) {
          stepDurationMs += nextAgentDelayPatternMs[(agentIndex - 1) % nextAgentDelayPatternMs.length]
        }
        const agentTimer = window.setTimeout(() => {
          setLiveAgentStatuses((value) => ({
            ...value,
            [stepId]: {
              ...(value[stepId] || {}),
              [agent]: 'completed',
            },
          }))
        }, stepStartMs + stepDurationMs)
        dryRunSimulationTimers.current.push(agentTimer)
      })

      const completeTimer = window.setTimeout(() => {
        setLiveStepStatuses((value) => ({
          ...value,
          [stepId]: 'dry-run',
        }))
      }, stepStartMs + stepDurationMs + 180)
      dryRunSimulationTimers.current.push(completeTimer)
      elapsedMs = stepStartMs + stepDurationMs + nextStepDelayMs
    })
  }, [clearDryRunSimulation, graph, selectedWorkflow])

  useEffect(() => {
    let cancelled = false
    getHealth()
      .then((response) => {
        if (!cancelled) setProjectRoot(response.projectRoot || '')
      })
      .catch(() => {
        if (!cancelled) setProjectRoot('')
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  useEffect(() => () => clearDryRunSimulation(), [clearDryRunSimulation])
  useEffect(() => () => closeRunEvents(), [closeRunEvents])

  useEffect(() => {
    let cancelled = false
    setLoadingWorkflows(true)
    listWorkflows()
      .then((response) => {
        if (cancelled) return
        setWorkflows(response.items)
        setError('')
        const requested = selectedWorkflowId
        const next = response.items.some((workflow) => workflow.id === requested)
          ? requested
          : response.items[0]?.id || ''
        setSelectedWorkflowId(next)
        if (next) setWorkflowUrl(next)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoadingWorkflows(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  useEffect(() => {
    if (!selectedWorkflowId) {
      setGraph(null)
      clearDryRunSimulation()
      dispatchLiveRun({ type: 'reset' })
      return
    }
    if (skipWorkflowGraphLoadRef.current === selectedWorkflowId) {
      skipWorkflowGraphLoadRef.current = ''
      setWorkflowUrl(selectedWorkflowId)
      return
    }
    if (skipWorkflowGraphLoadRef.current) skipWorkflowGraphLoadRef.current = ''
    clearDryRunSimulation()
    dispatchLiveRun({ type: 'reset' })
    setDryRunOptions((options) => ({
      ...options,
      context: '',
      models: [],
      stepModels: {},
      step: '',
      fromStep: '',
    }))
    let cancelled = false
    setLoadingGraph(true)
    getWorkflowGraph(selectedWorkflowId)
      .then((response) => {
        if (cancelled) return
        setGraph(response.graph)
        setSelectedNode(null)
        setError('')
        setWorkflowUrl(selectedWorkflowId)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoadingGraph(false)
      })
    return () => {
      cancelled = true
    }
  }, [clearDryRunSimulation, selectedWorkflowId, refreshKey])

  useEffect(() => {
    let cancelled = false
    refreshRuns()
      .then(() => {
        // State is updated in refreshRuns.
      })
      .catch(() => {
        if (!cancelled) setRuns([])
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey, activeRun?.status, refreshRuns])

  useEffect(() => {
    if (!runRunning || !activeRun) return undefined
    let cancelled = false

    const reconcile = async () => {
      try {
        const latestRuns = await refreshRuns()
        if (cancelled) return
        const latest = latestRuns.find((run) => sameRun(run, activeRun))
        if (!latest || !isTerminalRunStatus(latest.status || '')) return
        setActiveRun((value) => value ? { ...value, ...latest } : latest)
        setRunRunning(false)
        setCancelRunning(false)
        closeRunEvents()
      } catch {
        // Keep the EventSource path as the primary signal; polling is only a stale-state repair path.
      }
    }

    void reconcile()
    const timer = window.setInterval(() => {
      void reconcile()
    }, 2500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeRun, closeRunEvents, refreshRuns, runRunning])

  const toggleStepAgent = useCallback((stepId: string, agent: string, allAgents: string[]) => {
    setDryRunOptions((options) => {
      const current = Object.prototype.hasOwnProperty.call(options.stepModels, stepId)
        ? options.stepModels[stepId]
        : allAgents
      const next = current.includes(agent)
        ? current.filter((candidate) => candidate !== agent)
        : [...current, agent].filter((candidate, index, list) => list.indexOf(candidate) === index)
      const ordered = allAgents.filter((candidate) => next.includes(candidate))
      const nextStepModels = { ...options.stepModels }
      if (ordered.length === allAgents.length) delete nextStepModels[stepId]
      else nextStepModels[stepId] = ordered
      return {
        ...options,
        models: [],
        stepModels: nextStepModels,
      }
    })
  }, [])

  const openContextModal = (action: Exclude<ContextModalAction, ''>) => {
    setContextDraft('')
    setContextModalAction(action)
  }

  const closeContextModal = () => setContextModalAction('')

  const runDryRun = async (optionsOverride: DryRunOptions = dryRunOptions) => {
    if (!selectedWorkflow) return
    setDryRunRunning(true)
    setDryRunError('')
    setDryRunResult(null)
    simulateDryRunStepStatuses(optionsOverride)
    try {
      const response = await runWorkflowDryRun(selectedWorkflow.id, optionsOverride)
      setDryRunResult(response.dryRun)
    } catch (err) {
      setDryRunError(err instanceof Error ? err.message : String(err))
      clearDryRunSimulation()
      setLiveAgentStatuses({})
    } finally {
      setDryRunRunning(false)
    }
  }

  const openAgentResult = useCallback((node: WorkflowGraphNodeData, agent: string) => {
    const savedRun = runForAgent(node, agent)
    const runnerId = runValue(savedRun, 'runnerId')
    const sessionId = runValue(savedRun, 'sessionId')
    setDetailsModalContext({
      node,
      agent,
      runId: selectedRunId || activeRun?.runId || '',
      selector: {
        stepId: node.stepId,
        agent,
        runnerId,
        sessionId,
      },
    })
  }, [activeRun?.runId, selectedRunId])

  const runWorkflow = async (workflowOverride?: Workflow, optionsOverride: DryRunOptions = dryRunOptions, confirmed = false) => {
    const workflow = workflowOverride || selectedWorkflow
    if (!workflow) return
    const stepOverrideCount = Object.keys(optionsOverride.stepModels).length
    const models = stepOverrideCount > 0 ? `${stepOverrideCount} step override${stepOverrideCount === 1 ? '' : 's'}` : 'all configured agents'
    const allowed = confirmed || window.confirm([
      `Start "${workflow.title}"?`,
      '',
      `Branch: ${optionsOverride.branch || 'default'}`,
      `Transport: ${optionsOverride.transport}`,
      `Models: ${models}`,
      '',
      'This can create remote work and spend Netlify agent credits.',
    ].join('\n'))
    if (!allowed) return
    setRunRunning(true)
    setRunError('')
    setRunOutput('')
    clearDryRunSimulation()
    closeRunEvents()
    dispatchLiveRun({ type: 'reset' })
    try {
      const response = await startWorkflowRun(workflow.id, optionsOverride)
      setActiveRun(response.run)
      dispatchLiveRun({ type: 'reset', run: response.run })
      setSelectedRunId(response.run.runId || response.run.id)
      let eventCursor = 0
      let terminal = false
      const dispatchEvent = (event: Event) => {
        const data = parseRunEvent(event)
        const cursor = Number(data.seq ?? data.id ?? 0)
        if (Number.isFinite(cursor) && cursor > eventCursor) eventCursor = cursor
        dispatchLiveRun({ type: 'event', event: data })
        if (typeof data.text === 'string' && (data.type === 'stdout' || data.type === 'stderr')) {
          setRunOutput((value) => `${value}${data.text}`)
        }
        if (data.type === 'workflow_started' && data.runId) {
          setSelectedRunId(data.runId)
          setActiveRun((value) => value ? {
            ...value,
            runId: data.runId,
            flowId: data.flowId || value.flowId,
            flowTitle: data.flowTitle || value.flowTitle,
            status: typeof data.status === 'string' ? data.status : 'running',
            command: Array.isArray(data.command) ? data.command : value.command,
            startedAt: typeof data.at === 'string' ? data.at : value.startedAt,
          } : value)
        }
        if (typeof data.message === 'string' && (data.type === 'error' || data.type === 'runner_event_error')) {
          setRunError(data.message)
        }
      }
      const connectEvents = (since = 0) => {
        runReconnectTimerRef.current = null
        if (terminal) return
        runEventsRef.current?.close()
        const events = runEventsStream(response.run.id, since, {
          onEvent(event) {
            if (event.type === 'exited') {
              terminal = true
              const data = parseRunEvent(event)
              const cursor = Number(data.seq ?? data.id ?? 0)
              if (Number.isFinite(cursor) && cursor > eventCursor) eventCursor = cursor
              dispatchLiveRun({ type: 'event', event: data })
              setActiveRun((value) => value ? {
                ...value,
                status: typeof data.status === 'string' ? data.status : value.status,
                exitCode: typeof data.exitCode === 'number' ? data.exitCode : value.exitCode,
                signal: typeof data.signal === 'string' ? data.signal : value.signal,
                exitedAt: typeof data.at === 'string' ? data.at : value.exitedAt,
              } : value)
              setRunRunning(false)
              events.close()
              if (runEventsRef.current === events) runEventsRef.current = null
              return
            }
            dispatchEvent(event)
          },
          onError(event) {
            if (event instanceof MessageEvent) dispatchEvent(event)
            events.close()
            if (terminal) return
            if (runEventsRef.current === events) runEventsRef.current = null
            if (!runReconnectTimerRef.current) {
              runReconnectTimerRef.current = window.setTimeout(() => connectEvents(eventCursor), 1200)
            }
          },
        })
        runEventsRef.current = events
      }
      connectEvents()
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err))
      setRunRunning(false)
    }
  }

  const cancelActiveRun = async () => {
    if (!activeRun?.id || !runRunning) return
    setCancelRunning(true)
    setRunError('')
    try {
      const response = await cancelWorkflowRun(activeRun.id)
      setActiveRun(response.run)
      const statusMaps = liveStatusMapsFromRun(response.run)
      setLiveStepStatuses((current) => ({ ...current, ...statusMaps.stepStatuses }))
      setLiveAgentStatuses((current) => {
        const next = { ...current }
        for (const [stepId, statuses] of Object.entries(statusMaps.agentStatuses)) {
          next[stepId] = {
            ...(next[stepId] || {}),
            ...statuses,
          }
        }
        return next
      })
      if (!response.cancelled) {
        setRunError('This run is no longer cancellable.')
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err))
    } finally {
      setCancelRunning(false)
    }
  }

  const selectRun = async (run: DashboardRun) => {
    const id = run.runId || run.id
    if (!id) return
    setSelectedRunId(id)
    setLoadingGraph(true)
    try {
      const response = await getRunGraph(id)
      const runOptions = response.run.options || {}
      if (response.workflow.id !== selectedWorkflowId) {
        skipWorkflowGraphLoadRef.current = response.workflow.id
      }
      setSelectedWorkflowId(response.workflow.id)
      setGraph(response.graph)
      dispatchLiveRun({ type: 'reset' })
      setDryRunOptions((options) => ({
        ...options,
        branch: typeof runOptions.branch === 'string' ? runOptions.branch : response.run.branch || options.branch,
        transport: typeof runOptions.transport === 'string' ? runOptions.transport : response.run.transport || options.transport,
        context: '',
        step: typeof runOptions.step === 'string' ? runOptions.step : '',
        fromStep: typeof runOptions.fromStep === 'string' ? runOptions.fromStep : '',
        models: [],
        stepModels: stepModelsFromRunGraph(response.graph),
      }))
      setSelectedNode(null)
      setError('')
      setWorkflowUrl(response.workflow.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingGraph(false)
    }
  }

  useEffect(() => {
    if (!selectedRunId || !graphHasActiveRemoteRuns(graph)) return undefined
    let stopped = false
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        const response = await getRunGraph(selectedRunId)
        if (stopped) return
        if (response.workflow.id !== selectedWorkflowId) {
          skipWorkflowGraphLoadRef.current = response.workflow.id
          setSelectedWorkflowId(response.workflow.id)
        }
        setGraph(response.graph)
        setRuns((current) => replaceRunInList(current, response.run))
      } catch {
        // Keep the last rendered graph if remote sync is temporarily unavailable.
      } finally {
        polling = false
      }
    }
    const timer = window.setInterval(() => {
      void poll()
    }, 7000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [graph, selectedRunId, selectedWorkflowId])

  const handleRunUpdated = async (updated: DashboardRun) => {
    const latestRuns = await refreshRuns()
    const updatedRunId = updated.runId || updated.id
    if (!updatedRunId) return
    const nextRun = latestRuns.find((candidate) => candidate.runId === updatedRunId || candidate.id === updatedRunId) || updated
    await selectRun(nextRun)
  }

  const handleFollowupSubmitted = async (response: RunFollowupResponse) => {
    const persisted = response.followup.sourceWorkflow || response.followup.persistedWorkflow
    if (!persisted?.runId) return
    await handleRunUpdated(persisted)
  }

  const resumeRun = async (run: DashboardRun) => {
    const flowId = run.flowId
    if (!flowId) return
    const confirmed = window.confirm(`Resume "${run.flowTitle || flowId}" run ${run.runId || run.id}?`)
    if (!confirmed) return
    const workflow = workflows.find((candidate) => candidate.id === flowId)
    if (!workflow) return
    setSelectedWorkflowId(flowId)
    await runWorkflow(workflow, dryRunOptions, true)
  }

  const submitContextModal = async () => {
    if (!contextModalAction) return
    const action = contextModalAction
    const nextOptions = {
      ...dryRunOptions,
      context: contextDraft.trim(),
    }
    setDryRunOptions({
      ...nextOptions,
      context: '',
    })
    setContextDraft('')
    closeContextModal()
    if (action === 'dry-run') {
      await runDryRun(nextOptions)
    } else {
      await runWorkflow(undefined, nextOptions, true)
    }
  }

  const statusText = loadingWorkflows
    ? 'Loading workflows'
    : loadingGraph
      ? 'Loading graph'
      : selectedWorkflow
        ? `${selectedWorkflow.title} · ${selectedWorkflow.steps.length} steps`
        : 'No workflow selected'
  const repoName = repoNameFromPath(projectRoot)
  const projectedGraph = useMemo(() => projectWorkflowGraph({
    graph,
    stepModels: dryRunOptions.stepModels,
    stepStatuses: liveStepStatuses,
    stepAgentStatuses: liveAgentStatuses,
  }), [dryRunOptions.stepModels, graph, liveAgentStatuses, liveStepStatuses])
  const selectedRunSnapshot = useMemo(() => {
    if (!selectedRunId) return null
    return runs.find((run) => run.runId === selectedRunId || run.id === selectedRunId) || activeRun
  }, [activeRun, runs, selectedRunId])
  const detailsLiveRevision = useMemo(() => {
    const eventKey = liveRunState.rawEvents
      .map(eventRevisionPart)
      .filter(Boolean)
      .slice(-24)
      .join('|')
    return [
      selectedRunId,
      selectedRunSnapshot?.status || '',
      selectedRunSnapshot?.updatedAt || '',
      selectedRunSnapshot?.eventCount || '',
      liveRunState.run?.status || '',
      eventKey,
    ].join('::')
  }, [
    liveRunState.rawEvents,
    liveRunState.run?.status,
    selectedRunId,
    selectedRunSnapshot?.eventCount,
    selectedRunSnapshot?.status,
    selectedRunSnapshot?.updatedAt,
  ])

  const activeRunResult = activeRun ? {
    status: liveRunState.run?.status || activeRun.status,
    command: activeRun.command || [],
    startedAt: activeRun.startedAt || '',
    exitedAt: liveRunState.run?.exitedAt || activeRun.exitedAt || '',
    durationMs: liveRunState.run?.durationMs || activeRun.durationMs || 0,
    exitCode: liveRunState.run?.exitCode ?? activeRun.exitCode ?? null,
    signal: liveRunState.run?.signal || activeRun.signal || null,
    stdout: liveRunState.output || runOutput,
    stderr: '',
  } : null
  const detailsModalLiveContext = useMemo<RunDetailsLiveContext | null>(() => {
    if (!detailsModalContext) return null
    const latestNode = workflowGraphNodeByStepId(projectedGraph, detailsModalContext.node.stepId) || detailsModalContext.node
    const event = latestAgentEvent(liveRunState.rawEvents, latestNode, detailsModalContext.agent)
    const savedRun = runForAgent(latestNode, detailsModalContext.agent)
    const savedStatus = runValue(savedRun, 'status')
    const status = latestNode.agentStatuses?.[detailsModalContext.agent] ||
      event?.status ||
      (savedStatus ? visualStatus(savedStatus) : '')
    return {
      selector: {
        ...detailsModalContext.selector,
        runnerId: detailsModalContext.selector.runnerId || runValue(savedRun, 'runnerId') || event?.runnerId || '',
        sessionId: detailsModalContext.selector.sessionId || runValue(savedRun, 'sessionId') || event?.sessionId || '',
      },
      stepTitle: latestNode.title,
      status,
      runnerId: event?.runnerId || runValue(savedRun, 'runnerId'),
      sessionId: event?.sessionId || runValue(savedRun, 'sessionId'),
      submittedAfterSeconds: typeof event?.submittedAfterSeconds === 'number' ? event.submittedAfterSeconds : null,
      lastEventAt: event?.at || '',
      url: liveAgentUrl(event) || savedRunUrl(savedRun),
    }
  }, [detailsModalContext, liveRunState.rawEvents, projectedGraph])

  return (
    <ReactFlowProvider>
      <AppShell
        header={{ height: 60 }}
        footer={{ height: 32 }}
        navbar={{ width: 300, breakpoint: 'sm', collapsed: { mobile: !navbarOpened } }}
        padding={0}
        transitionDuration={120}
      >
        <AppShell.Header>
          <Group h="100%" px="md" justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap" miw={0} className="header-title-group">
              <Burger opened={navbarOpened} onClick={toggleNavbar} hiddenFrom="sm" size="sm" />
              <NetlifyLogo />
              <Box miw={0} className="header-title-wrap">
                <Title order={1} size="h4" lh={1.15} className="header-title">Netlify Agent Executor</Title>
              </Box>
            </Group>
            <Group gap="xs" wrap="nowrap" className="header-actions">
              <Tooltip label={projectRoot || 'Project root'}>
                <Group gap={6} wrap="nowrap" className="header-repo">
                  <FolderGit2 size={15} />
                  <Text size="sm" fw={700} truncate>{repoName}</Text>
                </Group>
              </Tooltip>
              <TextInput
                aria-label="Branch"
                className="header-branch"
                leftSection={<GitBranch size={14} />}
                value={dryRunOptions.branch}
                onChange={(event) => setDryRunOptions((options) => ({ ...options, branch: event.currentTarget.value }))}
                size="xs"
              />
              <Tooltip label={`Switch to ${colorScheme === 'dark' ? 'light' : 'dark'} mode`}>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label="Toggle color scheme"
                  onClick={() => toggleColorScheme()}
                >
                  {colorScheme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Refresh workflows">
                <ActionIcon
                  variant="light"
                  aria-label="Refresh workflows"
                  onClick={() => setRefreshKey((value) => value + 1)}
                >
                  <RefreshCw size={17} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Group>
        </AppShell.Header>

        <AppShell.Navbar>
          <WorkflowList
            workflows={workflows}
            selectedWorkflowId={selectedWorkflowId}
            loading={loadingWorkflows}
            onSelect={setSelectedWorkflowId}
          />
        </AppShell.Navbar>

        <AppShell.Main className="app-main">
          <Splitter className="main-workspace" lineSize={1} handleColor="blue">
            <Splitter.Pane defaultSize={78} min={55}>
              <Box component="section" className="center-column">
                <WorkflowControls
                  workflow={selectedWorkflow}
                  options={dryRunOptions}
                  running={dryRunRunning}
                  realRunning={runRunning}
                  cancelling={cancelRunning}
                  onChange={setDryRunOptions}
                  onDryRun={() => openContextModal('dry-run')}
                  onRun={() => openContextModal('run')}
                  onCancelRun={cancelActiveRun}
                />
                <Box className="workflow-splitter-shell">
                  <Badge className="workflow-status-badge" variant="light" color={error ? 'red' : 'blue'}>
                    {error ? 'Error' : statusText}
                  </Badge>
                  <Splitter orientation="vertical" className="workflow-splitter" lineSize={1} handleColor="blue">
                    <Splitter.Pane defaultSize={72} min={35}>
                      <WorkflowCanvas
                        graph={projectedGraph}
                        loading={loadingGraph}
                        onToggleStepAgent={toggleStepAgent}
                        onSelectNode={setSelectedNode}
                        onViewPrompt={setPromptNode}
                        onViewAgentResult={openAgentResult}
                      />
                    </Splitter.Pane>
                    <Splitter.Pane defaultSize={28} min={18}>
                      <WorkflowOutputTabs
                        dryRun={{ result: dryRunResult, running: dryRunRunning, error: dryRunError }}
                        run={{ result: activeRunResult, running: runRunning, error: runError, target: activeRun?.target || null }}
                        events={liveRunState.rawEvents}
                        eventErrors={liveRunState.errors}
                        onViewEvents={openEventDiagnostics}
                      />
                    </Splitter.Pane>
                  </Splitter>
                </Box>
              </Box>
            </Splitter.Pane>
            <Splitter.Pane defaultSize={22} min={16}>
              <Box component="aside" className="right-column">
                <Inspector
                  workflow={selectedWorkflow}
                  selectedNode={selectedNode}
                  graph={graph}
                  onViewPrompt={setPromptNode}
                />
                <RecentRuns
                  runs={runs}
                  selectedRunId={selectedRunId}
                  onSelect={selectRun}
                  onResume={resumeRun}
                  onFollowupSubmitted={handleFollowupSubmitted}
                />
              </Box>
            </Splitter.Pane>
          </Splitter>
        </AppShell.Main>

        <AppShell.Footer>
          <Group h="100%" px="md" justify="space-between" wrap="nowrap" className="statusbar">
            <Text size="xs" c={error ? 'red' : 'dimmed'} truncate>{error || statusText}</Text>
          {graph ? (
            <Text size="xs" c="dimmed" truncate>
              {graph.nodes.length} nodes · {graph.edges.length} edges · {graph.metadata.agents.join(', ') || 'no agents'}
            </Text>
          ) : null}
          </Group>
        </AppShell.Footer>
      </AppShell>
      <Modal
        opened={Boolean(contextModalAction)}
        onClose={closeContextModal}
        title={contextModalAction === 'dry-run' ? 'Dry run workflow' : `Run ${selectedWorkflow?.title || 'workflow'}`}
        size="lg"
        centered
      >
        <Stack gap="md">
          <Textarea
            label="Optional context"
            description="Add instructions or constraints to append to this workflow run."
            placeholder="Example: focus on frontend polish and avoid unrelated refactors."
            value={contextDraft}
            onChange={(event) => setContextDraft(event.currentTarget.value)}
            minRows={10}
            autosize
          />
          {contextModalAction === 'run' ? (
            <Text size="xs" c="dimmed">
              This can create remote work and spend Netlify agent credits.
            </Text>
          ) : null}
          <Group justify="flex-end">
            <Button variant="subtle" color="gray" onClick={closeContextModal}>Cancel</Button>
            <Button
              color={contextModalAction === 'run' ? 'violet' : undefined}
              onClick={submitContextModal}
              loading={contextModalAction === 'run' ? runRunning : dryRunRunning}
            >
              {contextModalAction === 'run' ? 'Run' : 'Dry Run'}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={eventDiagnosticsOpened}
        onClose={closeEventDiagnostics}
        title="Workflow event diagnostics"
        size="52rem"
        centered
        scrollAreaComponent={ScrollArea.Autosize}
      >
        <Stack gap="sm">
          {liveRunState.errors.length > 0 ? (
            <Alert color="red" variant="light">
              <Stack gap={4}>
                {liveRunState.errors.map((message, index) => (
                  <Text key={`${index}-${message}`} size="sm">{message}</Text>
                ))}
              </Stack>
            </Alert>
          ) : (
            <Text size="sm" c="dimmed">No event parser diagnostics.</Text>
          )}
          <Group justify="space-between" wrap="nowrap">
            <Text size="xs" c="dimmed">{liveRunState.rawEvents.length} recent structured events</Text>
            <CopyButton value={JSON.stringify(liveRunState.rawEvents, null, 2)} timeout={1500}>
              {({ copied, copy }) => (
                <Button
                  size="xs"
                  variant="subtle"
                  color={copied ? 'green' : 'gray'}
                  leftSection={copied ? <Check size={14} /> : <Copy size={14} />}
                  disabled={liveRunState.rawEvents.length === 0}
                  onClick={copy}
                >
                  {copied ? 'Copied' : 'Copy events'}
                </Button>
              )}
            </CopyButton>
          </Group>
          <Textarea
            aria-label="Raw workflow events"
            value={JSON.stringify(liveRunState.rawEvents, null, 2)}
            readOnly
            autosize
            minRows={16}
            maxRows={24}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
          />
        </Stack>
      </Modal>
      <Modal
        opened={Boolean(promptNode)}
        onClose={() => setPromptNode(null)}
        title={promptNode ? `${promptNode.promptTitle || promptNode.title} prompt` : 'Prompt'}
        size="48rem"
        centered
        scrollAreaComponent={ScrollArea.Autosize}
      >
        <Stack gap="sm">
          {promptNode?.promptPath ? <Code block className="path-code">{shortHomePath(promptNode.promptPath, projectRoot)}</Code> : null}
          <Box className="prompt-markdown prompt-preview-markdown">
            {promptNode?.promptMarkdown ? (
              <MarkdownRenderer fallback="Rendering prompt...">{promptNode.promptMarkdown}</MarkdownRenderer>
            ) : (
              <Text c="dimmed">No prompt markdown available.</Text>
            )}
          </Box>
        </Stack>
      </Modal>
      <RunDetailsModal
        opened={Boolean(detailsModalContext)}
        onClose={() => setDetailsModalContext(null)}
        runId={detailsModalContext?.runId || ''}
        initialSelector={detailsModalLiveContext?.selector || detailsModalContext?.selector}
        liveContext={detailsModalLiveContext}
        liveRevision={detailsLiveRevision}
        missingRunMessage="Load a saved workflow run before opening agent results."
        onFollowupSubmitted={handleFollowupSubmitted}
        onRunUpdated={handleRunUpdated}
      />
    </ReactFlowProvider>
  )
}
