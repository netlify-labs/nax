import { useEffect, useMemo, useState } from 'react'
import { Accordion, ActionIcon, Alert, Anchor, Badge, Box, Code, Divider, Group, Modal, Paper, ScrollArea, Stack, Stepper, Tabs, Text, Title, Tooltip, UnstyledButton } from '@mantine/core'
import { GitBranch, History, RotateCcw } from 'lucide-react'
import { getRunDetails } from '../api'
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

function buildStepItems(details: RunDetailsResponse['details'] | undefined, run: VisualizeRun | undefined): StepItem[] {
  const stepSections = details?.sections.filter((section) => section.kind === 'step') || []
  if (stepSections.length > 0) {
    return stepSections.map((section) => ({
      id: section.stepId || section.id,
      title: section.stepTitle || section.title,
      status: section.status || 'unknown',
      agents: [],
    }))
  }

  return (run?.steps || []).map((step, index) => ({
    id: recordValue(step, 'id') || `step-${index + 1}`,
    title: recordValue(step, 'title') || recordValue(step, 'id') || `Step ${index + 1}`,
    status: recordValue(step, 'status') || 'unknown',
    agents: recordList(step, 'agents'),
  }))
}

function stepDescription(step: StepItem): string {
  const parts = [step.status]
  if (step.agents.length > 0) parts.push(step.agents.join(', '))
  return parts.filter(Boolean).join(' · ')
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
  const firstUnfinishedStepIndex = stepItems.findIndex((step) => !isDoneStatus(step.status))
  const defaultStepIndex = firstUnfinishedStepIndex >= 0
    ? firstUnfinishedStepIndex
    : Math.max(0, stepItems.length - 1)
  const [activeStepIndex, setActiveStepIndex] = useState(0)
  const activeStep = stepItems[Math.min(activeStepIndex, Math.max(stepItems.length - 1, 0))]
  const sessionSections = details?.sections.filter((section) => section.kind === 'session') || []
  const visibleSessionSections = activeStep
    ? sessionSections.filter((section) => !section.stepId || section.stepId === activeStep.id)
    : sessionSections

  useEffect(() => {
    setActiveStepIndex(defaultStepIndex)
  }, [defaultStepIndex, detailsResponse?.run.runId, detailsResponse?.run.id])

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
              <Box className="run-details-content">
                <Tabs defaultValue="summary" keepMounted={false}>
                  <Tabs.List>
                    <Tabs.Tab value="summary">Summary</Tabs.Tab>
                    <Tabs.Tab value="sessions">Sessions</Tabs.Tab>
                    <Tabs.Tab value="final">Final</Tabs.Tab>
                  </Tabs.List>

                  <Tabs.Panel value="summary" pt="md">
                    <Box className="prompt-markdown run-details-markdown">
                      {details.summaryMarkdown ? (
                        <MarkdownRenderer>{details.summaryMarkdown}</MarkdownRenderer>
                      ) : (
                        <Text c="dimmed">No workflow summary artifact was found.</Text>
                      )}
                    </Box>
                  </Tabs.Panel>

                  <Tabs.Panel value="sessions" pt="md">
                    {visibleSessionSections.length > 0 ? (
                      <Accordion variant="separated" chevronPosition="left">
                        {visibleSessionSections.map((section) => (
                          <Accordion.Item value={section.id} key={section.id}>
                            <Accordion.Control>
                              <RunSectionHeader section={section} />
                            </Accordion.Control>
                            <Accordion.Panel>
                              <RunSectionMeta section={section} />
                              <Box className="prompt-markdown run-details-markdown">
                                <MarkdownRenderer>{section.markdown}</MarkdownRenderer>
                              </Box>
                            </Accordion.Panel>
                          </Accordion.Item>
                        ))}
                      </Accordion>
                    ) : (
                      <Text c="dimmed">No session result artifacts were found for this step.</Text>
                    )}
                  </Tabs.Panel>

                  <Tabs.Panel value="final" pt="md">
                    <Stack gap="sm">
                      <Divider label={details.finalTitle || 'Final result'} labelPosition="left" />
                      <Box className="prompt-markdown run-details-markdown">
                        {details.finalMarkdown ? (
                          <MarkdownRenderer>{details.finalMarkdown}</MarkdownRenderer>
                        ) : (
                          <Text c="dimmed">No final result artifact was found.</Text>
                        )}
                      </Box>
                    </Stack>
                  </Tabs.Panel>
                </Tabs>
              </Box>
              {stepItems.length > 0 ? (
                <Box className="run-details-stepper" component="aside" aria-label="Workflow steps">
                  <Stepper active={activeStepIndex} onStepClick={setActiveStepIndex} orientation="vertical" size="xs">
                    {stepItems.map((step) => (
                      <Stepper.Step
                        key={step.id}
                        label={step.title}
                        description={stepDescription(step)}
                        color={isDoneStatus(step.status) ? 'green' : 'yellow'}
                      />
                    ))}
                  </Stepper>
                </Box>
              ) : null}
            </Box>
          </Stack>
        ) : null}
      </Modal>
    </>
  )
}

function RunSectionHeader({ section }: { section: RunDetailsSection }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <Text size="sm" fw={700} truncate>{section.title}</Text>
      {section.status ? <Badge className={`run-status ${section.status}`} variant="light" size="xs">{section.status}</Badge> : null}
    </Group>
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
