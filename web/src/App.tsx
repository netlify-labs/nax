import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActionIcon,
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Code,
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
import { FolderGit2, GitBranch, Moon, RefreshCw, Sun } from 'lucide-react'
import { ReactFlowProvider } from '@xyflow/react'
import { cancelWorkflowRun, getHealth, getRunGraph, getWorkflowGraph, listRuns, listWorkflows, runEventsUrl, runWorkflowDryRun, startWorkflowRun } from './api'
import { WorkflowOutputTabs } from './components/DryRunPanel'
import { Inspector } from './components/Inspector'
import { MarkdownRenderer } from './components/MarkdownRenderer'
import { RecentRuns } from './components/RecentRuns'
import { WorkflowCanvas } from './components/WorkflowCanvas'
import { WorkflowControls } from './components/WorkflowControls'
import { WorkflowList } from './components/WorkflowList'
import type { DryRunOptions, DryRunResult, VisualizeRun, Workflow, WorkflowGraph, WorkflowGraphNodeData } from './types'

type ContextModalAction = '' | 'dry-run' | 'run'

function parseRunEvent(event: Event): Record<string, unknown> {
  try {
    return JSON.parse((event as MessageEvent).data) as Record<string, unknown>
  } catch {
    return {}
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
  const [activeRun, setActiveRun] = useState<VisualizeRun | null>(null)
  const [runs, setRuns] = useState<VisualizeRun[]>([])
  const [selectedRunId, setSelectedRunId] = useState('')
  const [runOutput, setRunOutput] = useState('')
  const [runRunning, setRunRunning] = useState(false)
  const [cancelRunning, setCancelRunning] = useState(false)
  const [runError, setRunError] = useState('')
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [contextModalAction, setContextModalAction] = useState<ContextModalAction>('')
  const [contextDraft, setContextDraft] = useState('')
  const [promptNode, setPromptNode] = useState<WorkflowGraphNodeData | null>(null)

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
      return
    }
    setDryRunOptions((options) => ({
      ...options,
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
  }, [selectedWorkflowId, refreshKey])

  useEffect(() => {
    let cancelled = false
    listRuns()
      .then((response) => {
        if (cancelled) return
        const seen = new Set<string>()
        const combined = [...response.active, ...response.durable].filter((run) => {
          const id = run.runId || run.id
          if (!id || seen.has(id)) return false
          seen.add(id)
          return true
        })
        setRuns(combined)
      })
      .catch(() => {
        if (!cancelled) setRuns([])
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey, activeRun?.status])

  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedWorkflowId) || null,
    [workflows, selectedWorkflowId],
  )

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
    setContextDraft(dryRunOptions.context)
    setContextModalAction(action)
  }

  const closeContextModal = () => setContextModalAction('')

  const runDryRun = async (optionsOverride: DryRunOptions = dryRunOptions) => {
    if (!selectedWorkflow) return
    setDryRunRunning(true)
    setDryRunError('')
    setDryRunResult(null)
    try {
      const response = await runWorkflowDryRun(selectedWorkflow.id, optionsOverride)
      setDryRunResult(response.dryRun)
    } catch (err) {
      setDryRunError(err instanceof Error ? err.message : String(err))
    } finally {
      setDryRunRunning(false)
    }
  }

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
    try {
      const response = await startWorkflowRun(workflow.id, optionsOverride)
      setActiveRun(response.run)
      setSelectedRunId(response.run.runId || response.run.id)
      const events = new EventSource(runEventsUrl(response.run.id))
      events.addEventListener('started', (event) => {
        const data = parseRunEvent(event)
        setActiveRun((value) => value ? {
          ...value,
          status: 'running',
          command: Array.isArray(data.command) ? data.command as string[] : value.command,
          startedAt: typeof data.at === 'string' ? data.at : value.startedAt,
        } : value)
      })
      events.addEventListener('stdout', (event) => {
        const data = parseRunEvent(event)
        setRunOutput((value) => `${value}${typeof data.text === 'string' ? data.text : ''}`)
      })
      events.addEventListener('stderr', (event) => {
        const data = parseRunEvent(event)
        setRunOutput((value) => `${value}${typeof data.text === 'string' ? data.text : ''}`)
      })
      events.addEventListener('exited', (event) => {
        const data = parseRunEvent(event)
        setActiveRun((value) => value ? {
          ...value,
          status: typeof data.status === 'string' ? data.status : value.status,
          exitCode: typeof data.exitCode === 'number' ? data.exitCode : value.exitCode,
          signal: typeof data.signal === 'string' ? data.signal : value.signal,
          exitedAt: typeof data.at === 'string' ? data.at : value.exitedAt,
        } : value)
        setRunRunning(false)
        events.close()
      })
      events.addEventListener('error', (event) => {
        const data = parseRunEvent(event)
        if (typeof data.message === 'string') setRunError(data.message)
      })
      events.onerror = () => {
        events.close()
        setRunRunning(false)
      }
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
      if (!response.cancelled) {
        setRunError('This run is no longer cancellable.')
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err))
    } finally {
      setCancelRunning(false)
    }
  }

  const selectRun = async (run: VisualizeRun) => {
    const id = run.runId || run.id
    if (!id) return
    setSelectedRunId(id)
    try {
      const response = await getRunGraph(id)
      const runOptions = response.run.options || {}
      setSelectedWorkflowId(response.workflow.id)
      setGraph(response.graph)
      setDryRunOptions((options) => ({
        ...options,
        branch: typeof runOptions.branch === 'string' ? runOptions.branch : response.run.branch || options.branch,
        transport: typeof runOptions.transport === 'string' ? runOptions.transport : response.run.transport || options.transport,
        context: typeof runOptions.context === 'string' ? runOptions.context : options.context,
        step: typeof runOptions.step === 'string' ? runOptions.step : '',
        fromStep: typeof runOptions.fromStep === 'string' ? runOptions.fromStep : '',
        models: [],
        stepModels: stepModelsFromRunGraph(response.graph),
      }))
      setSelectedNode(null)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const resumeRun = async (run: VisualizeRun) => {
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
    setDryRunOptions(nextOptions)
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

  const activeRunResult = activeRun ? {
    status: activeRun.status,
    command: activeRun.command || [],
    startedAt: activeRun.startedAt || '',
    exitedAt: activeRun.exitedAt || '',
    durationMs: activeRun.durationMs || 0,
    exitCode: activeRun.exitCode ?? null,
    signal: activeRun.signal || null,
    stdout: runOutput,
    stderr: '',
  } : null

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
                        graph={graph}
                        loading={loadingGraph}
                        stepModels={dryRunOptions.stepModels}
                        onToggleStepAgent={toggleStepAgent}
                        onSelectNode={setSelectedNode}
                        onViewPrompt={setPromptNode}
                      />
                    </Splitter.Pane>
                    <Splitter.Pane defaultSize={28} min={18}>
                      <WorkflowOutputTabs
                        dryRun={{ result: dryRunResult, running: dryRunRunning, error: dryRunError }}
                        run={{ result: activeRunResult, running: runRunning, error: runError }}
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
        opened={Boolean(promptNode)}
        onClose={() => setPromptNode(null)}
        title={promptNode ? `${promptNode.promptTitle || promptNode.title} prompt` : 'Prompt'}
        size="48rem"
        centered
        scrollAreaComponent={ScrollArea.Autosize}
      >
        <Stack gap="sm">
          {promptNode?.promptPath ? <Code block className="path-code">{promptNode.promptPath}</Code> : null}
          <Box className="prompt-markdown prompt-preview-markdown">
            {promptNode?.promptMarkdown ? (
              <MarkdownRenderer fallback="Rendering prompt...">{promptNode.promptMarkdown}</MarkdownRenderer>
            ) : (
              <Text c="dimmed">No prompt markdown available.</Text>
            )}
          </Box>
        </Stack>
      </Modal>
    </ReactFlowProvider>
  )
}
