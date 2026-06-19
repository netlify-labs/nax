import { useEffect, useMemo, useState } from 'react'
import { ActionIcon, Alert, Anchor, Badge, Box, Code, Group, Modal, Paper, ScrollArea, Stack, Text, Timeline, Title, Tooltip, UnstyledButton } from '@mantine/core'
import { GitBranch, History, RotateCcw } from 'lucide-react'
import { getRunDetails } from '../api'
import { AgentIcon } from './AgentIcon'
import { MarkdownRenderer } from './MarkdownRenderer'
import type { RunDetailsResponse, RunDetailsSection, VisualizeRun } from '../types'

type Props = {
  runs: VisualizeRun[]
  selectedRunId: string
  onSelect: (run: VisualizeRun) => void
  onResume: (run: VisualizeRun) => void
}

type StepItem = {
  id: string
  title: string
  status: string
  agents: string[]
  section?: RunDetailsSection
}

type TimelineEntry = {
  id: string
  kind: 'summary' | 'step' | 'session' | 'final'
  title: string
  subtitle: string
  status: string
  path: string
  markdown: string
  section?: RunDetailsSection
}

function runId(run: Partial<VisualizeRun>): string {
  return run.runId || run.id || ''
}

function recordValue(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function recordList(record: Record<string, unknown> | undefined, key: string): string[] {
  const value = record?.[key]
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

function isDoneStatus(status: string): boolean {
  return ['complete', 'completed', 'dry-run'].includes(status.toLowerCase())
}

function agentLabel(agent: string): string {
  return agent.replace(/(^|-)([a-z])/g, (_match, prefix, char) => `${prefix}${char.toUpperCase()}`)
}

function statusColor(status: string): string {
  if (isDoneStatus(status)) return 'green'
  if (['running', 'submitted'].includes(status.toLowerCase())) return 'yellow'
  if (['failed', 'timeout', 'cancelled', 'dismissed'].includes(status.toLowerCase())) return 'red'
  return 'gray'
}

function buildStepItems(details: RunDetailsResponse['details'] | undefined, run: VisualizeRun | undefined): StepItem[] {
  const stepSections = details?.sections.filter((section) => section.kind === 'step') || []
  if (stepSections.length > 0) {
    return stepSections.map((section) => ({
      id: section.stepId || section.id,
      title: section.stepTitle || section.title,
      status: section.status || 'unknown',
      agents: [],
      section,
    }))
  }

  return (run?.steps || []).map((step, index) => ({
    id: recordValue(step, 'id') || `step-${index + 1}`,
    title: recordValue(step, 'title') || recordValue(step, 'id') || `Step ${index + 1}`,
    status: recordValue(step, 'status') || 'unknown',
    agents: recordList(step, 'agents'),
  }))
}

function stepDescription(step: StepItem, sessions: RunDetailsSection[]): string {
  const parts = [step.status]
  if (sessions.length > 0) parts.push(`${sessions.length} result${sessions.length === 1 ? '' : 's'}`)
  if (step.agents.length > 0) parts.push(step.agents.join(', '))
  return parts.filter(Boolean).join(' · ')
}

function buildTimelineEntries(
  details: RunDetailsResponse['details'] | undefined,
  run: VisualizeRun | undefined,
  steps: StepItem[],
): TimelineEntry[] {
  if (!details) return []
  const sessionSections = details.sections.filter((section) => section.kind === 'session')
  const entries: TimelineEntry[] = [{
    id: 'summary',
    kind: 'summary',
    title: 'Workflow summary',
    subtitle: run?.status || 'summary',
    status: run?.status || 'completed',
    path: details.summaryPath || run?.summaryPath || runId(run || {}),
    markdown: details.summaryMarkdown,
  }]

  steps.forEach((step, index) => {
    const sessions = sessionSections.filter((section) => section.stepId === step.id)
    entries.push({
      id: `step:${step.id}`,
      kind: 'step',
      title: `${index + 1}. ${step.title}`,
      subtitle: stepDescription(step, sessions),
      status: step.status,
      path: step.section?.path || '',
      markdown: step.section?.markdown || '',
      section: step.section,
    })
    sessions.forEach((section) => {
      entries.push({
        id: `session:${section.id}`,
        kind: 'session',
        title: `${agentLabel(section.agent)} · ${section.stepTitle || step.title}`,
        subtitle: section.status || section.runnerId || section.sessionId,
        status: section.status,
        path: section.path,
        markdown: section.markdown,
        section,
      })
    })
  })

  entries.push({
    id: 'final',
    kind: 'final',
    title: details.finalTitle || 'Final result',
    subtitle: run?.status || 'final',
    status: run?.status || 'completed',
    path: '',
    markdown: details.finalMarkdown,
  })

  return entries
}

export function RecentRuns({ runs, selectedRunId, onSelect, onResume }: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsError, setDetailsError] = useState('')
  const [detailsResponse, setDetailsResponse] = useState<RunDetailsResponse | null>(null)

  const openRunDetails = async (run: VisualizeRun) => {
    const id = runId(run)
    if (!id) return
    setDetailsOpen(true)
    setDetailsLoading(true)
    setDetailsError('')
    setDetailsResponse(null)
    try {
      setDetailsResponse(await getRunDetails(id))
    } catch (err) {
      setDetailsError(err instanceof Error ? err.message : String(err))
    } finally {
      setDetailsLoading(false)
    }
  }

  const details = detailsResponse?.details
  const detailRun = detailsResponse?.run
  const stepItems = useMemo(() => buildStepItems(details, detailRun), [details, detailRun])
  const timelineEntries = useMemo(() => buildTimelineEntries(details, detailRun, stepItems), [details, detailRun, stepItems])
  const parentTimelineEntries = useMemo(() => {
    const summaryEntry = timelineEntries.find((entry) => entry.kind === 'summary')
    const stepEntries = timelineEntries.filter((entry) => entry.kind === 'step')
    return summaryEntry ? [...stepEntries, summaryEntry] : stepEntries
  }, [timelineEntries])
  const [activeTimelineId, setActiveTimelineId] = useState('summary')
  const activeTimelineIndex = Math.max(0, timelineEntries.findIndex((entry) => entry.id === activeTimelineId))
  const timelineProgressIndex = Math.max(0, parentTimelineEntries.length - 1)
  const activeEntry = timelineEntries[activeTimelineIndex] || null

  useEffect(() => {
    setActiveTimelineId('summary')
  }, [detailsResponse?.run.runId, detailsResponse?.run.id])

  return (
    <>
      <Box className="recent-runs" component="section" aria-label="Recent runs">
        <Group className="panel-header" justify="space-between" wrap="nowrap">
          <Title order={2} size="sm">Runs</Title>
          <Badge variant="light" color="gray">{runs.length}</Badge>
        </Group>
        <ScrollArea className="run-list-scroll">
          <Stack gap="xs" p="sm">
            {runs.length === 0 ? <Text className="empty-state" size="sm" c="dimmed">No runs</Text> : null}
            {runs.map((run) => (
              <Paper
                key={runId(run)}
                className={`run-item${selectedRunId === runId(run) ? ' selected' : ''}`}
                withBorder
                p="xs"
                radius="sm"
              >
                <Box className="run-item-main">
                  <Group className="run-item-title-row" gap={6} justify="space-between" wrap="nowrap">
                    <UnstyledButton
                      className="run-item-details-button"
                      onClick={() => {
                        void openRunDetails(run)
                      }}
                    >
                      <Group gap={6} wrap="nowrap">
                        <History size={14} />
                        <Text fw={700} size="sm" truncate>{run.flowTitle || run.flowId || runId(run)}</Text>
                      </Group>
                    </UnstyledButton>
                    <Group gap={4} wrap="nowrap">
                      <Tooltip label="Load run graph">
                        <ActionIcon
                          type="button"
                          variant={selectedRunId === runId(run) ? 'filled' : 'subtle'}
                          color="teal"
                          size="xs"
                          aria-label="Load run graph"
                          onClick={(event) => {
                            event.stopPropagation()
                            onSelect(run)
                          }}
                        >
                          <GitBranch size={13} />
                        </ActionIcon>
                      </Tooltip>
                      {run.resumable ? (
                        <Tooltip label="Resume run">
                          <ActionIcon
                            type="button"
                            variant="light"
                            color="yellow"
                            size="xs"
                            aria-label="Resume run"
                            onClick={(event) => {
                              event.stopPropagation()
                              onResume(run)
                            }}
                          >
                            <RotateCcw size={13} />
                          </ActionIcon>
                        </Tooltip>
                      ) : null}
                    </Group>
                  </Group>
                  <UnstyledButton
                    className="run-item-details-button"
                    onClick={() => {
                      void openRunDetails(run)
                    }}
                  >
                    <Badge className={`run-status ${run.status}`} variant="light" size="xs">{run.status || 'unknown'}</Badge>
                    <Text size="xs" c="dimmed" truncate>{runId(run)}</Text>
                  </UnstyledButton>
                </Box>
              </Paper>
            ))}
          </Stack>
        </ScrollArea>
      </Box>

      <Modal
        opened={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        title={detailRun ? `${detailRun.flowTitle || detailRun.flowId || runId(detailRun)} results` : 'Run results'}
        size="90rem"
        centered
        classNames={{ content: 'run-details-modal-content', body: 'run-details-modal-body' }}
        scrollAreaComponent={ScrollArea.Autosize}
      >
        {detailsLoading ? (
          <Text c="dimmed">Loading run results...</Text>
        ) : detailsError ? (
          <Alert color="red" variant="light">{detailsError}</Alert>
        ) : details ? (
          <Stack gap="md">
            <Group gap="xs" wrap="wrap">
              <Badge variant="light" color="gray">{detailRun?.status || 'unknown'}</Badge>
              {detailRun?.transport ? <Badge variant="light" color="blue">{detailRun.transport}</Badge> : null}
              {detailRun?.branch ? <Badge variant="light" color="gray">{detailRun.branch}</Badge> : null}
            </Group>
            <Code block className="path-code">{details.summaryPath || detailRun?.summaryPath || runId(detailRun || {})}</Code>
            <Box className="run-details-layout">
              {timelineEntries.length > 0 ? (
                <Box className="run-details-timeline" component="nav" aria-label="Workflow timeline">
                  <Timeline active={timelineProgressIndex} bulletSize={18} lineWidth={2}>
                    {parentTimelineEntries.map((entry) => {
                      const childEntries = entry.kind === 'step'
                        ? timelineEntries.filter((child) => child.kind === 'session' && child.section?.stepId && entry.id === `step:${child.section.stepId}`)
                        : []
                      return (
                        <Timeline.Item
                          key={entry.id}
                          className="run-details-timeline-item"
                          color={statusColor(entry.status)}
                          title={(
                            <Stack gap={4}>
                              <UnstyledButton
                                className={`run-details-timeline-button${entry.id === activeTimelineId ? ' active' : ''}`}
                                onClick={() => setActiveTimelineId(entry.id)}
                              >
                                <Group gap={6} wrap="nowrap" className="run-details-timeline-title">
                                  <Text size="sm" fw={700} truncate>{entry.title}</Text>
                                </Group>
                                {entry.subtitle ? <Text size="xs" c="dimmed" truncate>{entry.subtitle}</Text> : null}
                              </UnstyledButton>
                              {childEntries.length > 0 ? (
                                <Stack className="run-details-timeline-children" gap={2}>
                                  {childEntries.map((child) => (
                                    <UnstyledButton
                                      key={child.id}
                                      className={`run-details-timeline-child-button${child.id === activeTimelineId ? ' active' : ''}`}
                                      onClick={() => setActiveTimelineId(child.id)}
                                    >
                                      <Group gap={6} wrap="nowrap" className="run-details-timeline-title session">
                                        {child.section?.agent ? <AgentIcon agent={child.section.agent} /> : null}
                                        <Text size="xs" fw={600} truncate>{child.title}</Text>
                                      </Group>
                                      {child.subtitle ? <Text size="10px" c="dimmed" truncate>{child.subtitle}</Text> : null}
                                    </UnstyledButton>
                                  ))}
                                </Stack>
                              ) : null}
                            </Stack>
                          )}
                        />
                      )
                    })}
                  </Timeline>
                </Box>
              ) : null}
              <Box className="run-details-content">
                {activeEntry ? (
                  <Stack gap="sm">
                    <Group gap="xs" wrap="wrap">
                      <Title order={2} size="h3">{activeEntry.title}</Title>
                      {activeEntry.status ? (
                        <Badge className={`run-status ${activeEntry.status}`} variant="light" size="xs">
                          {activeEntry.status}
                        </Badge>
                      ) : null}
                    </Group>
                    {activeEntry.section ? <RunSectionMeta section={activeEntry.section} /> : null}
                    {!activeEntry.section && activeEntry.path ? <Code block className="path-code">{activeEntry.path}</Code> : null}
                    <Box className="prompt-markdown run-details-markdown">
                      {activeEntry.markdown ? (
                        <MarkdownRenderer>{activeEntry.markdown}</MarkdownRenderer>
                      ) : (
                        <Text c="dimmed">No result text.</Text>
                      )}
                    </Box>
                  </Stack>
                ) : (
                  <Text c="dimmed">No run details were found.</Text>
                )}
              </Box>
            </Box>
          </Stack>
        ) : null}
      </Modal>
    </>
  )
}

function RunSectionMeta({ section }: { section: RunDetailsSection }) {
  const sessionUrl = section.links.sessionUrl || section.links.agentRunUrl
  return (
    <Stack gap={6} mb="sm">
      <Group gap="xs" wrap="wrap">
        {section.runnerId ? <Badge variant="light" color="gray">runner {section.runnerId}</Badge> : null}
        {section.sessionId ? <Badge variant="light" color="gray">session {section.sessionId}</Badge> : null}
        {sessionUrl ? <Anchor href={sessionUrl} target="_blank" rel="noreferrer" size="xs">Open in Netlify</Anchor> : null}
      </Group>
      {section.path ? <Code block className="path-code">{section.path}</Code> : null}
    </Stack>
  )
}
