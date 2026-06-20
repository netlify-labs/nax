import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { ActionIcon, Alert, Anchor, Badge, Box, Group, Modal, Paper, ScrollArea, Stack, Text, Timeline, Title, Tooltip, UnstyledButton } from '@mantine/core'
import { Check, Copy, ExternalLink, GitBranch, History, RotateCcw } from 'lucide-react'
import { getRunDetails, openLocalFile } from '../api'
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
  absolutePath: string
  markdown: string
  stepNumber?: number
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

function statusLabel(status: string): string {
  const normalized = status.toLowerCase()
  if (!normalized || isDoneStatus(normalized)) return 'Completed'
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function statusColor(status: string): string {
  if (isDoneStatus(status)) return 'green'
  if (['running', 'submitted', 'interrupted'].includes(status.toLowerCase())) return 'yellow'
  if (['failed', 'timeout', 'cancelled', 'dismissed'].includes(status.toLowerCase())) return 'red'
  return 'gray'
}

function statusBadgeTone(status: string): 'green' | 'yellow' | 'red' | undefined {
  if (isDoneStatus(status)) return 'green'
  if (['running', 'submitted', 'interrupted'].includes(status.toLowerCase())) return 'yellow'
  return ['failed', 'timeout', 'cancelled', 'dismissed'].includes(status.toLowerCase())
    ? 'red'
    : undefined
}

function statusBadgeStyle(status: string): CSSProperties | undefined {
  const tone = statusBadgeTone(status)
  if (!tone) return undefined

  const color = tone === 'green' ? 'green' : tone === 'yellow' ? 'yellow' : 'red'
  const shade = tone === 'green' ? '4' : tone === 'yellow' ? '4' : '5'
  const mixShadow = tone === 'green' ? '72%' : tone === 'yellow' ? '76%' : '74%'
  const mixGlow = tone === 'green' ? '86%' : tone === 'yellow' ? '84%' : '86%'
  return {
    '--badge-bg': `color-mix(in srgb, var(--mantine-color-${color}-${shade}), transparent 88%)`,
    '--badge-color': `light-dark(var(--mantine-color-${color}-9), var(--mantine-color-${color}-1))`,
    '--badge-bd': `calc(0.0625rem * var(--mantine-scale)) solid var(--mantine-color-${color}-${shade})`,
    boxShadow: `0 0 0 1px color-mix(in srgb, var(--mantine-color-${color}-${shade}), transparent ${mixShadow}), 0 0 18px color-mix(in srgb, var(--mantine-color-${color}-${shade}), transparent ${mixGlow})`,
  } as CSSProperties
}

function workflowName(run: VisualizeRun | undefined): string {
  return run ? run.flowTitle || run.flowId || runId(run) : ''
}

function timelineContentTitle(entry: TimelineEntry, name: string): string {
  if (!name) return entry.title
  if (entry.kind === 'summary') return `"${name}" workflow results`
  return entry.title
}

function timelineBullet(entry: TimelineEntry) {
  if (entry.kind === 'step') return <Text component="span" size="10px" fw={800}>{entry.stepNumber}</Text>
  if (isDoneStatus(entry.status)) return <Check size={12} strokeWidth={3} />
  return undefined
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
    title: run ? `"${workflowName(run)}" Workflow ${statusLabel(run.status || '')}` : 'Workflow Completed',
    subtitle: 'click to view results',
    status: run?.status || 'completed',
    path: details.summaryPath || run?.summaryPath || runId(run || {}),
    absolutePath: details.summaryAbsolutePath || '',
    markdown: details.summaryMarkdown,
  }]

  steps.forEach((step, index) => {
    const sessions = sessionSections.filter((section) => section.stepId === step.id)
    entries.push({
      id: `step:${step.id}`,
      kind: 'step',
      title: step.title,
      subtitle: stepDescription(step, sessions),
      status: step.status,
      path: step.section?.path || '',
      absolutePath: step.section?.absolutePath || '',
      markdown: step.section?.markdown || '',
      stepNumber: index + 1,
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
        absolutePath: section.absolutePath,
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
    absolutePath: '',
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
  const detailWorkflowName = workflowName(detailRun)

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
                    <Badge
                      className={`run-status ${run.status}`}
                      variant="light"
                      color={statusColor(run.status || '')}
                      size="xs"
                      style={statusBadgeStyle(run.status || '')}
                    >
                      {run.status || 'unknown'}
                    </Badge>
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
        title={(
          <Group component="span" gap="xs" wrap="wrap" className="run-details-modal-title">
            <Text component="span" inherit>{detailWorkflowName ? `Workflow results for "${detailWorkflowName}"` : 'Workflow results'}</Text>
          </Group>
        )}
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
            <Box className="run-details-layout">
              {timelineEntries.length > 0 ? (
                <Box className="run-details-timeline" component="nav" aria-label="Workflow timeline">
                  <Text className="run-details-timeline-heading" size="xs" fw={800} c="dimmed">Timeline</Text>
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
                          bullet={timelineBullet(entry)}
                          title={(
                            <Paper className="run-details-timeline-card" withBorder>
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
                                        <Text size="xs" truncate>
                                          <Text component="span" inherit fw={600} className="run-details-timeline-agent-name">
                                            {child.section?.agent ? agentLabel(child.section.agent) : child.title}
                                          </Text>
                                          {child.subtitle ? (
                                            <Text component="span" inherit c="dimmed">
                                              {' - '}
                                              {child.subtitle}
                                            </Text>
                                          ) : null}
                                        </Text>
                                      </Group>
                                    </UnstyledButton>
                                  ))}
                                </Stack>
                              ) : null}
                            </Paper>
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
                      <Title order={2} size="h3">{timelineContentTitle(activeEntry, detailWorkflowName)}</Title>
                      {activeEntry.status ? (
                        <Badge
                          className={`run-status ${activeEntry.status}`}
                          variant="light"
                          color={statusColor(activeEntry.status)}
                          size="xs"
                          style={statusBadgeStyle(activeEntry.status)}
                        >
                          {activeEntry.status}
                        </Badge>
                      ) : null}
                      {!activeEntry.section && activeEntry.absolutePath ? <ArtifactActions filePath={activeEntry.absolutePath} /> : null}
                    </Group>
                    {activeEntry.section ? <RunSectionMeta section={activeEntry.section} /> : null}
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
              <RunDetailsMetadata run={detailRun} workflowName={detailWorkflowName} section={activeEntry?.section} />
            </Box>
          </Stack>
        ) : null}
      </Modal>
    </>
  )
}

function RunDetailsMetadata({ run, workflowName, section }: { run: VisualizeRun | undefined; workflowName: string; section?: RunDetailsSection }) {
  return (
    <Paper className="run-details-meta" withBorder>
      <Text size="xs" fw={800} c="dimmed" className="run-details-meta-heading">Metadata</Text>
      <Stack gap={10}>
        <MetadataRow label="Workflow" value={workflowName} />
        <MetadataRow label="Status" value={run?.status || 'unknown'} />
        <MetadataRow label="Transport" value={run?.transport || ''} />
        <MetadataRow label="Branch" value={run?.branch || ''} />
        <MetadataRow label="Run ID" value={runId(run || {})} />
        <MetadataRow label="Runner ID" value={section?.runnerId || ''} />
        <MetadataRow label="Session ID" value={section?.sessionId || ''} />
      </Stack>
    </Paper>
  )
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <Box>
      <Text size="10px" c="dimmed" fw={800} tt="uppercase">{label}</Text>
      <Text size="xs" className="field-value">{value}</Text>
    </Box>
  )
}

function RunSectionMeta({ section }: { section: RunDetailsSection }) {
  const sessionUrl = section.links.sessionUrl || section.links.agentRunUrl
  return (
    <Stack gap={6} mb="sm">
      <Group gap="xs" wrap="wrap">
        {sessionUrl ? <Anchor href={sessionUrl} target="_blank" rel="noreferrer" size="xs">Open in Netlify</Anchor> : null}
        {section.absolutePath ? <ArtifactActions filePath={section.absolutePath} /> : null}
      </Group>
    </Stack>
  )
}

function ArtifactActions({ filePath }: { filePath: string }) {
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(false)
  const [copied, setCopied] = useState(false)

  const openPath = async () => {
    setOpening(true)
    setError('')
    try {
      await openLocalFile(filePath)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpening(false)
    }
  }

  const copyPath = async () => {
    setError('')
    try {
      await navigator.clipboard.writeText(filePath)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Group gap={4} wrap="nowrap" className="artifact-actions">
      <Tooltip label={copied ? 'Copied' : 'Copy file path'}>
        <ActionIcon aria-label="Copy file path" variant="subtle" color="gray" size="sm" onClick={copyPath}>
          <Copy size={14} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Open file">
        <ActionIcon aria-label="Open file" variant="subtle" color="gray" size="sm" loading={opening} onClick={openPath}>
          <ExternalLink size={14} />
        </ActionIcon>
      </Tooltip>
      {error ? <Text size="xs" c="red" mt={4}>{error}</Text> : null}
    </Group>
  )
}
