import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ActionIcon, Alert, Anchor, Badge, Box, Button, Code, Group, Menu, Modal, Paper, ScrollArea, Stack, Text, Timeline, Title, Tooltip, UnstyledButton } from '@mantine/core'
import { Check, ChevronsDownUp, ChevronsUpDown, ChevronDown, ChevronRight, ExternalLink, FileText, Files, Play } from 'lucide-react'
import { getRunDetails, openLocalFile } from '../api'
import { agentLabel, isDoneStatus, recordList, recordValue, runId, statusBadgeStyle, statusColor, statusLabel, workflowName } from '../run-format'
import { extractMarkdownToc } from '../run-details-toc'
import { selectRunDetailsSection, selectorKey, type RunDetailsSelector } from '../run-details-selection'
import type { RunDetailsResponse, RunDetailsSection, RunFollowupResponse, Target, VisualizeRun } from '../types'
import { AgentIcon } from './AgentIcon'
import { MarkdownRenderer } from './MarkdownRenderer'
import { RunFollowupContent } from './RunFollowupModal'

export type RunDetailsLiveContext = {
  selector: RunDetailsSelector
  stepTitle: string
  status: string
  runnerId?: string
  sessionId?: string
  submittedAfterSeconds?: number | null
  lastEventAt?: string
  url?: string
}

type RunDetailsModalProps = {
  opened: boolean
  onClose: () => void
  runId?: string
  initialSelector?: RunDetailsSelector
  liveContext?: RunDetailsLiveContext | null
  missingRunMessage?: string
  onFollowupSubmitted?: (response: RunFollowupResponse) => void | Promise<void>
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
  promptMarkdown?: string
  promptPath?: string
  promptTitle?: string
  stepNumber?: number
  section?: RunDetailsSection
  liveContext?: RunDetailsLiveContext
}

function targetLabel(target?: Target | null): string {
  if (!target) return ''
  const confidence = target.verified ? 'verified' : 'unverified'
  return `${target.branch || 'unknown'} (${target.sourceType || 'unknown'}, ${confidence})`
}

function targetCaveats(target?: Target | null): string {
  return target?.caveats?.length ? target.caveats.join(', ') : ''
}

function linkWithSession(url: string, sessionId: string): string {
  if (!url || !sessionId || url.includes('session=')) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}session=${encodeURIComponent(sessionId)}`
}

function sessionHref(section?: RunDetailsSection, liveContext?: RunDetailsLiveContext): string {
  const sessionId = section?.sessionId || liveContext?.sessionId || ''
  if (section?.links.sessionUrl) return linkWithSession(section.links.sessionUrl, sessionId)
  if (section?.links.agentRunUrl) return linkWithSession(section.links.agentRunUrl, sessionId)
  if (liveContext?.url) return linkWithSession(liveContext.url, sessionId)
  return ''
}

function timelineContentTitle(entry: TimelineEntry, name: string): string {
  if (entry.kind === 'step' && entry.stepNumber) return `Step ${entry.stepNumber}: ${entry.title}`
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

function liveEntryId(context: RunDetailsLiveContext): string {
  return `live:${context.selector.stepId}:${context.selector.agent}`
}

function buildTimelineEntries(
  details: RunDetailsResponse['details'] | undefined,
  run: VisualizeRun | undefined,
  steps: StepItem[],
  liveContext?: RunDetailsLiveContext | null,
): TimelineEntry[] {
  if (!details) return []
  const sessionSections = details.sections.filter((section) => section.kind === 'session')
  const entries: TimelineEntry[] = [{
    id: 'summary',
    kind: 'summary',
    title: run ? `"${workflowName(run)}" Workflow ${statusLabel(run.status || '')}` : 'Workflow results',
    subtitle: 'click to view results',
    status: run?.status || '',
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
      promptMarkdown: step.section?.promptMarkdown || '',
      promptPath: step.section?.promptPath || '',
      promptTitle: step.section?.promptTitle || step.title,
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
        promptMarkdown: section.promptMarkdown || '',
        promptPath: section.promptPath || '',
        promptTitle: section.promptTitle || section.stepTitle || step.title,
        section,
      })
    })
    if (
      liveContext &&
      liveContext.selector.stepId === step.id &&
      !sessions.some((section) => section.agent === liveContext.selector.agent)
    ) {
      entries.push({
        id: liveEntryId(liveContext),
        kind: 'session',
        title: `${agentLabel(liveContext.selector.agent)} · ${liveContext.stepTitle || step.title}`,
        subtitle: liveContext.status,
        status: liveContext.status,
        path: '',
        absolutePath: '',
        markdown: '',
        liveContext,
      })
    }
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

function resolveInitialTimelineId(
  details: RunDetailsResponse['details'] | undefined,
  entries: TimelineEntry[],
  selector?: RunDetailsSelector,
  liveContext?: RunDetailsLiveContext | null,
): { id: string; warning: string } {
  if (!selector) return { id: 'summary', warning: '' }
  if (details) {
    const result = selectRunDetailsSection(details.sections, selector)
    if (result.status === 'selected') return { id: `session:${result.section.id}`, warning: '' }
    if (result.status === 'unresolved') {
      return {
        id: 'summary',
        warning: `Multiple saved ${agentLabel(selector.agent)} results exist for this step, but none matched the requested runner/session id.`,
      }
    }
  }
  if (liveContext) {
    const id = liveEntryId(liveContext)
    if (!details || entries.some((entry) => entry.id === id)) return { id, warning: '' }
  }
  return {
    id: 'summary',
    warning: `No saved ${agentLabel(selector.agent)} result was found for this step.`,
  }
}

function isActiveLiveStatus(status: string): boolean {
  return ['running', 'submitted', 'waiting', 'retrying', 'queued'].includes(status.toLowerCase())
}

function isSuccessfulWorkflowStatus(status: string): boolean {
  return ['complete', 'completed'].includes(status.toLowerCase())
}

function RobotIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor">
      <path d="M5.68 9.925 4.607 8.85l-.013-.379 1.1-1.1.38.012 1.075 1.075.012.379-1.1 1.1zM9.96 9.925 8.886 8.85l-.013-.379 1.1-1.1.38.012 1.075 1.075.012.379-1.1 1.1z" />
      <path fillRule="evenodd" d="M9.005 2.52v1.296h2.657a3.19 3.19 0 0 1 3.191 3.192v3.356a3.19 3.19 0 0 1-3.191 3.191H4.338a3.19 3.19 0 0 1-3.191-3.19V7.007a3.19 3.19 0 0 1 3.191-3.192h2.836V2.52l.229-.245h1.373zM4.338 5.316c-.934 0-1.691.758-1.691 1.692v3.356c0 .934.758 1.691 1.691 1.691h7.324c.933 0 1.69-.757 1.691-1.69V7.007c0-.934-.757-1.692-1.691-1.692z" clipRule="evenodd" />
    </svg>
  )
}

async function copyTextToClipboard(text: string) {
  if (!text) return
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

export function RunDetailsModal({
  opened,
  onClose,
  runId: detailsRunId = '',
  initialSelector,
  liveContext,
  missingRunMessage = 'Load a saved workflow run before opening agent results.',
  onFollowupSubmitted,
}: RunDetailsModalProps) {
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsError, setDetailsError] = useState('')
  const [detailsResponse, setDetailsResponse] = useState<RunDetailsResponse | null>(null)
  const [activeTimelineId, setActiveTimelineId] = useState('summary')
  const [selectionWarning, setSelectionWarning] = useState('')
  const [detailsView, setDetailsView] = useState<'results' | 'followup'>('results')
  const [contentView, setContentView] = useState<'results' | 'prompt'>('results')
  const [followupSubmitting, setFollowupSubmitting] = useState(false)
  const details = detailsResponse?.details
  const detailRun = detailsResponse?.run
  const followupTargets = details?.followupTargets || []
  const markdownScrollRef = useRef<HTMLDivElement>(null)
  const stepItems = useMemo(() => buildStepItems(details, detailRun), [details, detailRun])
  const timelineEntries = useMemo(
    () => buildTimelineEntries(details, detailRun, stepItems, liveContext),
    [details, detailRun, liveContext, stepItems],
  )
  const parentTimelineEntries = useMemo(() => {
    const summaryEntry = timelineEntries.find((entry) => entry.kind === 'summary')
    const stepEntries = timelineEntries.filter((entry) => entry.kind === 'step')
    return summaryEntry ? [...stepEntries, summaryEntry] : stepEntries
  }, [timelineEntries])
  const activeTimelineIndex = Math.max(0, timelineEntries.findIndex((entry) => entry.id === activeTimelineId))
  const timelineProgressIndex = Math.max(0, parentTimelineEntries.length - 1)
  const activeEntry = timelineEntries[activeTimelineIndex] || null
  const activeContentMarkdown = activeEntry?.promptMarkdown && contentView === 'prompt'
    ? activeEntry.promptMarkdown
    : activeEntry?.markdown || ''
  const tocEntry = activeEntry
    ? { ...activeEntry, id: `${activeEntry.id}:${contentView}`, markdown: activeContentMarkdown }
    : null
  const detailWorkflowName = workflowName(detailRun)
  const selectorIdentity = selectorKey(initialSelector)
  const liveIdentity = liveContext
    ? [
      selectorKey(liveContext.selector),
      liveContext.status,
      liveContext.runnerId || '',
      liveContext.sessionId || '',
      liveContext.submittedAfterSeconds ?? '',
      liveContext.lastEventAt || '',
      liveContext.url || '',
    ].join('|')
    : ''

  const refreshDetails = async () => {
    if (!detailsRunId) return
    const response = await getRunDetails(detailsRunId)
    setDetailsResponse(response)
  }

  useEffect(() => {
    if (!opened) return undefined
    setSelectionWarning('')
    if (!detailsRunId) {
      setDetailsResponse(null)
      setDetailsLoading(false)
      setDetailsError('')
      return undefined
    }

    let cancelled = false
    setDetailsLoading(true)
    setDetailsError('')
    setDetailsResponse(null)
    getRunDetails(detailsRunId)
      .then((response) => {
        if (!cancelled) setDetailsResponse(response)
      })
      .catch((err) => {
        if (!cancelled) setDetailsError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setDetailsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [detailsRunId, opened, selectorIdentity])

  useEffect(() => {
    if (!opened) setDetailsView('results')
  }, [opened])

  useEffect(() => {
    setDetailsView('results')
  }, [detailsRunId, selectorIdentity])

  useEffect(() => {
    if (detailsView !== 'followup') setFollowupSubmitting(false)
  }, [detailsView])

  useEffect(() => {
    setContentView('results')
  }, [activeTimelineId, detailsRunId])

  useEffect(() => {
    if (contentView === 'prompt' && !activeEntry?.promptMarkdown) setContentView('results')
  }, [activeEntry?.promptMarkdown, contentView])

  useEffect(() => {
    if (!opened) return
    const resolved = resolveInitialTimelineId(details, timelineEntries, initialSelector, liveContext)
    setActiveTimelineId(resolved.id)
    setSelectionWarning(resolved.warning)
  }, [details, initialSelector, liveContext, liveIdentity, opened, selectorIdentity, timelineEntries])

  const title = detailWorkflowName
    ? `Workflow results for "${detailWorkflowName}"`
    : liveContext
      ? `${agentLabel(liveContext.selector.agent)} result · ${liveContext.stepTitle}`
      : 'Workflow results'
  const modalTitle = detailsView === 'followup' ? 'Send to next agent' : title

  return (
    <Modal
      opened={opened}
      onClose={detailsView === 'followup' && followupSubmitting ? () => undefined : onClose}
      title={(
        <Group component="span" gap="xs" wrap="wrap" className="run-details-modal-title">
          <Text component="span" inherit>{modalTitle}</Text>
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
        detailsView === 'followup' && detailRun && detailRun.runId && followupTargets.length > 0 ? (
          <RunFollowupContent
            onClose={() => setDetailsView('results')}
            run={detailRun}
            details={details}
            onSubmittingChange={setFollowupSubmitting}
            onSubmitted={async (_response: RunFollowupResponse) => {
              await refreshDetails()
              await onFollowupSubmitted?.(_response)
            }}
          />
        ) : (
        <Stack gap="md">
          {selectionWarning ? <Alert color="yellow" variant="light">{selectionWarning}</Alert> : null}
          <Box className="run-details-layout">
            {timelineEntries.length > 0 ? (
              <RunDetailsTimeline
                activeTimelineId={activeTimelineId}
                parentTimelineEntries={parentTimelineEntries}
                timelineEntries={timelineEntries}
                timelineProgressIndex={timelineProgressIndex}
                onSelect={setActiveTimelineId}
                canRunFollowup={Boolean(detailRun?.runId && followupTargets.length > 0)}
                onRunFollowup={() => setDetailsView('followup')}
              />
            ) : null}
            <Box className="run-details-content">
              {activeEntry ? (
                <RunDetailsContent
                  contentView={contentView}
                  entry={activeEntry}
                  onContentViewChange={setContentView}
                  workflowName={detailWorkflowName}
                  scrollRootRef={markdownScrollRef}
                />
              ) : (
                <Text c="dimmed">No run details were found.</Text>
              )}
            </Box>
            <Stack className="run-details-side" gap="md">
              <MarkdownTableOfContents entry={tocEntry} scrollRootRef={markdownScrollRef} />
              <RunDetailsMetadata run={detailRun} workflowName={detailWorkflowName} section={activeEntry?.section} liveContext={activeEntry?.liveContext} />
            </Stack>
          </Box>
        </Stack>
        )
      ) : liveContext ? (
        <RunDetailsStandaloneLivePanel context={liveContext} />
      ) : (
        <Alert color="yellow" variant="light">{missingRunMessage}</Alert>
      )}
    </Modal>
  )
}

function RunDetailsTimeline({
  activeTimelineId,
  parentTimelineEntries,
  timelineEntries,
  timelineProgressIndex,
  onSelect,
  canRunFollowup,
  onRunFollowup,
}: {
  activeTimelineId: string
  parentTimelineEntries: TimelineEntry[]
  timelineEntries: TimelineEntry[]
  timelineProgressIndex: number
  onSelect: (id: string) => void
  canRunFollowup: boolean
  onRunFollowup: () => void
}) {
  const [handoffFeedback, setHandoffFeedback] = useState('')
  const copyHandoffValue = async (value: string, label: string) => {
    if (!value) return
    try {
      await copyTextToClipboard(value)
      setHandoffFeedback(`${label} copied`)
      window.setTimeout(() => setHandoffFeedback(''), 1800)
    } catch (err) {
      setHandoffFeedback(err instanceof Error ? err.message : 'Could not copy')
    }
  }
  const handoffEntry = parentTimelineEntries.find((entry) => entry.kind === 'summary' && isSuccessfulWorkflowStatus(entry.status))

  return (
    <Box className="run-details-timeline" component="nav" aria-label="Workflow timeline">
      <Text className="run-details-timeline-heading" size="xs" fw={800} c="dimmed">Timeline</Text>
      <Timeline active={timelineProgressIndex} bulletSize={18} lineWidth={2}>
        {parentTimelineEntries.map((entry) => {
          const childEntries = entry.kind === 'step'
            ? timelineEntries.filter((child) => (
              child.kind === 'session' &&
              ((child.section?.stepId && entry.id === `step:${child.section.stepId}`) ||
                (child.liveContext?.selector.stepId && entry.id === `step:${child.liveContext.selector.stepId}`))
            ))
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
                    onClick={() => onSelect(entry.id)}
                  >
                    <Group gap={6} wrap="nowrap" className="run-details-timeline-title">
                      <Text size="sm" fw={700} truncate>{entry.title}</Text>
                    </Group>
                    {entry.subtitle ? <Text size="xs" c="dimmed" truncate>{entry.subtitle}</Text> : null}
                  </UnstyledButton>
                  {childEntries.length > 0 ? (
                    <Stack className="run-details-timeline-children" gap={2}>
                      {childEntries.map((child) => {
                        const agent = child.section?.agent || child.liveContext?.selector.agent || ''
                        return (
                          <UnstyledButton
                            key={child.id}
                            className={`run-details-timeline-child-button${child.id === activeTimelineId ? ' active' : ''}`}
                            onClick={() => onSelect(child.id)}
                          >
                            <Group gap={6} wrap="nowrap" className="run-details-timeline-title session">
                              {agent ? <AgentIcon agent={agent} /> : null}
                              <Text size="xs" truncate>
                                <Text component="span" inherit fw={600} className="run-details-timeline-agent-name">
                                  {agent ? agentLabel(agent) : child.title}
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
                        )
                      })}
                    </Stack>
                  ) : null}
                </Paper>
              )}
            />
          )
        })}
      </Timeline>
      {handoffEntry ? (
        <Box className="run-details-handoff">
          <Text className="run-details-handoff-heading" size="xs" fw={800} c="dimmed">Actions</Text>
          <Menu position="bottom-start" withinPortal>
            <Menu.Target>
              <Button
                className="run-details-handoff-button"
                fullWidth
                justify="flex-start"
                leftSection={<RobotIcon size={16} />}
                size="xs"
                variant="filled"
              >
                Send to next agent
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                disabled={!handoffEntry.absolutePath}
                leftSection={<Files size={14} />}
                onClick={() => copyHandoffValue(handoffEntry.absolutePath, 'Summary path')}
              >
                Copy file path of results output
              </Menu.Item>
              <Menu.Item
                disabled={!handoffEntry.markdown}
                leftSection={<FileText size={14} />}
                onClick={() => copyHandoffValue(handoffEntry.markdown, 'Raw markdown')}
              >
                Copy results as markdown
              </Menu.Item>
              <Menu.Item disabled={!canRunFollowup} leftSection={<Play size={14} />} onClick={onRunFollowup}>
                Run a followup
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
          {handoffFeedback ? (
            <Text className="run-details-handoff-feedback" c="dimmed" size="10px">{handoffFeedback}</Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}

function RunDetailsContent({
  contentView,
  entry,
  onContentViewChange,
  workflowName: name,
  scrollRootRef,
}: {
  contentView: 'results' | 'prompt'
  entry: TimelineEntry
  onContentViewChange: (view: 'results' | 'prompt') => void
  workflowName: string
  scrollRootRef?: RefObject<HTMLDivElement | null>
}) {
  const hasPrompt = Boolean(entry.promptMarkdown)
  const showingPrompt = contentView === 'prompt' && hasPrompt
  const markdown = showingPrompt ? entry.promptMarkdown || '' : entry.markdown
  const promptTitle = entry.promptTitle || entry.section?.stepTitle || entry.title
  const actionFilePath = showingPrompt ? entry.promptPath || '' : entry.absolutePath
  const actionSessionUrl = showingPrompt ? '' : entry.section?.links.sessionUrl || entry.section?.links.agentRunUrl
  return (
    <Stack gap="sm" style={{ marginTop: -4 }}>
      <Group gap="xs" wrap="wrap">
        <Title order={2} size="h4">{showingPrompt ? `${promptTitle} prompt` : timelineContentTitle(entry, name)}</Title>
        {!showingPrompt && entry.status ? (
          <Badge
            className={`run-status ${entry.status}`}
            variant="light"
            color={statusColor(entry.status)}
            size="xs"
            style={statusBadgeStyle(entry.status)}
          >
            {entry.status}
          </Badge>
        ) : null}
        {actionFilePath ? (
          <ArtifactActions
            filePath={actionFilePath}
            sessionUrl={actionSessionUrl}
          />
        ) : null}
      </Group>
      <Box className="run-details-markdown-shell">
        {hasPrompt ? (
          <Group gap={0} wrap="nowrap" className="run-details-content-switch" aria-label="Run details content">
            <Button
              className="run-details-content-switch-button"
              data-active={!showingPrompt || undefined}
              onClick={() => onContentViewChange('results')}
              size="compact-xs"
              variant={!showingPrompt ? 'filled' : 'subtle'}
            >
              Results
            </Button>
            <Button
              className="run-details-content-switch-button"
              data-active={showingPrompt || undefined}
              onClick={() => onContentViewChange('prompt')}
              size="compact-xs"
              variant={showingPrompt ? 'filled' : 'subtle'}
            >
              Prompt
            </Button>
          </Group>
        ) : null}
        <Box className="prompt-markdown run-details-markdown" ref={scrollRootRef}>
          {markdown ? (
            <MarkdownRenderer copyLabel={showingPrompt ? 'Copy prompt markdown' : 'Copy results markdown'}>{markdown}</MarkdownRenderer>
          ) : entry.liveContext ? (
            <LivePanel context={entry.liveContext} />
          ) : (
            <Text c="dimmed">{showingPrompt ? 'No prompt markdown available.' : 'No result text.'}</Text>
          )}
        </Box>
      </Box>
    </Stack>
  )
}

function MarkdownTableOfContents({
  entry,
  scrollRootRef,
}: {
  entry: TimelineEntry | null
  scrollRootRef: RefObject<HTMLDivElement | null>
}) {
  const headings = useMemo(() => extractMarkdownToc(entry?.markdown || ''), [entry?.markdown])
  const tocGroups = useMemo(() => {
    const groups: Array<{ heading: typeof headings[number]; children: typeof headings }> = []
    const topLevel = Math.min(...headings.map((heading) => heading.level))
    for (const heading of headings) {
      if (heading.level <= topLevel || groups.length === 0) {
        groups.push({ heading, children: [] })
      } else {
        groups[groups.length - 1].children.push(heading)
      }
    }
    return groups
  }, [headings])
  const [activeKey, setActiveKey] = useState('')
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set())
  const [expandAllPinned, setExpandAllPinned] = useState(false)
  const [collapseAllPinned, setCollapseAllPinned] = useState(false)

  useEffect(() => {
    setActiveKey('')
    setExpandAllPinned(false)
    setCollapseAllPinned(false)
    setExpandedKeys(tocGroups[0] ? new Set([tocGroups[0].heading.key]) : new Set())
  }, [entry?.id, tocGroups])

  useEffect(() => {
    const root = scrollRootRef.current
    if (!root || headings.length === 0) return undefined

    const updateActiveHeading = () => {
      const renderedHeadings = Array.from(root.querySelectorAll('h1, h2, h3, h4'))
      const rootTop = root.getBoundingClientRect().top
      let nextActive = headings[0]
      for (const heading of headings) {
        const node = renderedHeadings[heading.headingIndex]
        if (!node) continue
        if (node.getBoundingClientRect().top - rootTop <= 24) nextActive = heading
      }
      setActiveKey(nextActive.key)
    }

    updateActiveHeading()
    root.addEventListener('scroll', updateActiveHeading, { passive: true })
    return () => root.removeEventListener('scroll', updateActiveHeading)
  }, [headings, scrollRootRef])

  useEffect(() => {
    if (!activeKey || expandAllPinned || collapseAllPinned || tocGroups.length === 0) return
    const activeGroup = tocGroups.find((group) => group.heading.key === activeKey || group.children.some((child) => child.key === activeKey))
    if (!activeGroup) return
    setExpandedKeys(new Set([activeGroup.heading.key]))
  }, [activeKey, collapseAllPinned, expandAllPinned, tocGroups])

  if (headings.length === 0) return null

  const hasNestedHeadings = tocGroups.some((group) => group.children.length > 0)

  const scrollToHeading = (heading: typeof headings[number]) => {
    const root = scrollRootRef.current
    const renderedHeading = root?.querySelectorAll('h1, h2, h3, h4')[heading.headingIndex]
    if (!renderedHeading) return
    setCollapseAllPinned(false)
    setActiveKey(heading.key)
    renderedHeading.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const toggleAll = () => {
    if (expandAllPinned) {
      setExpandAllPinned(false)
      setCollapseAllPinned(true)
      setExpandedKeys(new Set())
      return
    }
    setExpandAllPinned(true)
    setCollapseAllPinned(false)
    setExpandedKeys(new Set(tocGroups.map((group) => group.heading.key)))
  }
  const toggleGroup = (key: string) => {
    setExpandAllPinned(false)
    setCollapseAllPinned(false)
    setExpandedKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <Paper className="run-details-toc" withBorder>
      <Group justify="space-between" align="center" gap="xs" className="run-details-toc-heading">
        <Text size="xs" fw={800} c="dimmed" className="run-details-meta-heading">Contents</Text>
        <Tooltip label={expandAllPinned ? 'Collapse all' : 'Expand all'} withArrow>
          <ActionIcon
            aria-label={expandAllPinned ? 'Collapse all contents sections' : 'Expand all contents sections'}
            className="run-details-toc-toggle"
            onClick={toggleAll}
            size="sm"
            variant="subtle"
          >
            {expandAllPinned ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
          </ActionIcon>
        </Tooltip>
      </Group>
      <Stack gap={2}>
        {tocGroups.map((group) => {
          const expanded = expandedKeys.has(group.heading.key)
          const groupActive = group.heading.key === activeKey || group.children.some((child) => child.key === activeKey)
          return (
            <Box key={group.heading.key} className="run-details-toc-group" data-active={groupActive || undefined}>
              <Group
                gap={2}
                wrap="nowrap"
                className="run-details-toc-row"
                data-active={group.heading.key === activeKey || undefined}
              >
                {hasNestedHeadings ? (
                  <ActionIcon
                    aria-label={expanded ? `Collapse ${group.heading.text}` : `Expand ${group.heading.text}`}
                    className="run-details-toc-section-toggle"
                    disabled={group.children.length === 0}
                    onClick={() => toggleGroup(group.heading.key)}
                    size="sm"
                    variant="subtle"
                  >
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </ActionIcon>
                ) : null}
                <UnstyledButton
                  className="run-details-toc-link"
                  data-active={group.heading.key === activeKey || undefined}
                  data-level={group.heading.level}
                  onClick={() => scrollToHeading(group.heading)}
                  type="button"
                >
                  <Text size="xs" truncate>{group.heading.text}</Text>
                </UnstyledButton>
              </Group>
              {expanded ? (
                <Stack gap={2} className="run-details-toc-children">
                  {group.children.map((heading) => (
                    <UnstyledButton
                      key={heading.key}
                      className="run-details-toc-link"
                      data-active={heading.key === activeKey || undefined}
                      data-level={heading.level}
                      onClick={() => scrollToHeading(heading)}
                      type="button"
                    >
                      <Text size="xs" truncate>{heading.text}</Text>
                    </UnstyledButton>
                  ))}
                </Stack>
              ) : null}
            </Box>
          )
        })}
      </Stack>
    </Paper>
  )
}

function RunDetailsStandaloneLivePanel({ context }: { context: RunDetailsLiveContext }) {
  return (
    <Stack gap="sm">
      <Group gap="xs" wrap="wrap">
        <Title order={2} size="h4">{`${agentLabel(context.selector.agent)} · ${context.stepTitle}`}</Title>
        <Badge
          className={`run-status ${context.status}`}
          variant="light"
          color={statusColor(context.status)}
          w="fit-content"
          style={statusBadgeStyle(context.status)}
        >
          {context.status || 'unknown'}
        </Badge>
      </Group>
      <Box className="prompt-markdown run-details-markdown">
        <LivePanel context={context} />
      </Box>
    </Stack>
  )
}

function LivePanel({ context }: { context: RunDetailsLiveContext }) {
  if (context.status === 'dry-run') return <Text c="dimmed">No results from dry runs.</Text>
  const contextSessionHref = context.sessionId ? linkWithSession(context.url || '', context.sessionId) : ''
  return (
    <Stack gap={6}>
      {isActiveLiveStatus(context.status) ? (
        <Text c="dimmed">No result yet. This remote agent run is still in progress.</Text>
      ) : (
        <Text c="dimmed">No saved markdown result was found for this agent run.</Text>
      )}
      {context.runnerId ? (
        <Group gap="xs" wrap="nowrap">
          <Text size="sm" c="dimmed" w={92}>Runner ID</Text>
          <Code>{context.runnerId}</Code>
        </Group>
      ) : null}
      {context.sessionId ? (
        <Group gap="xs" wrap="nowrap">
          <Text size="sm" c="dimmed" w={92}>Session ID</Text>
          {contextSessionHref ? (
            <Anchor href={contextSessionHref} target="_blank" rel="noreferrer" size="sm">
              <Code>{context.sessionId}</Code>
            </Anchor>
          ) : (
            <Code>{context.sessionId}</Code>
          )}
        </Group>
      ) : null}
      {typeof context.submittedAfterSeconds === 'number' ? (
        <Group gap="xs" wrap="nowrap">
          <Text size="sm" c="dimmed" w={92}>Submitted</Text>
          <Text size="sm">after {context.submittedAfterSeconds}s</Text>
        </Group>
      ) : null}
      {context.lastEventAt ? (
        <Group gap="xs" wrap="nowrap">
          <Text size="sm" c="dimmed" w={92}>Last event</Text>
          <Text size="sm">{new Date(context.lastEventAt).toLocaleTimeString()}</Text>
        </Group>
      ) : null}
      {context.url ? (
        <Anchor href={context.url} target="_blank" rel="noreferrer" size="sm">
          Open in Netlify
        </Anchor>
      ) : null}
    </Stack>
  )
}

function RunDetailsMetadata({
  run,
  workflowName: name,
  section,
  liveContext,
}: {
  run: VisualizeRun | undefined
  workflowName: string
  section?: RunDetailsSection
  liveContext?: RunDetailsLiveContext
}) {
  const sessionLink = sessionHref(section, liveContext)
  const [openingRunDir, setOpeningRunDir] = useState(false)
  const [runDirError, setRunDirError] = useState('')
  const runDir = run?.dir || ''

  const openRunDir = async () => {
    if (!runDir) return
    setOpeningRunDir(true)
    setRunDirError('')
    try {
      await openLocalFile(runDir)
    } catch (err) {
      setRunDirError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpeningRunDir(false)
    }
  }

  return (
    <Paper className="run-details-meta" withBorder>
      <Text size="xs" fw={800} c="dimmed" className="run-details-meta-heading">Metadata</Text>
      <Stack gap={10}>
        <MetadataRow label="Workflow" value={name} />
        <MetadataRow label="Status" value={run?.status || liveContext?.status || 'unknown'} />
        <MetadataRow label="Transport" value={run?.transport || ''} />
        <MetadataRow label="Branch" value={run?.branch || ''} />
        <MetadataRow label="Target" value={targetLabel(run?.target)} />
        <MetadataRow label="Target SHA" value={run?.target?.sha || ''} />
        <MetadataRow label="Target Caveats" value={targetCaveats(run?.target)} />
        <MetadataRow label="Run ID" value={runId(run || {})} onClick={runDir ? openRunDir : undefined} loading={openingRunDir} />
        {runDirError ? <Text size="xs" c="red">{runDirError}</Text> : null}
        <MetadataRow label="Runner ID" value={section?.runnerId || liveContext?.runnerId || ''} />
        <MetadataRow label="Session ID" value={section?.sessionId || liveContext?.sessionId || ''} href={sessionLink} />
      </Stack>
    </Paper>
  )
}

function MetadataRow({
  label,
  value,
  href,
  onClick,
  loading,
}: {
  label: string
  value: string
  href?: string
  onClick?: () => void
  loading?: boolean
}) {
  if (!value) return null
  return (
    <Box>
      <Text size="10px" c="dimmed" fw={800} tt="uppercase">{label}</Text>
      {href ? (
        <Anchor href={href} target="_blank" rel="noreferrer" size="xs" className="field-value">
          {value}
        </Anchor>
      ) : onClick ? (
        <Anchor component="button" type="button" onClick={onClick} size="xs" className="field-value">
          {loading ? 'Opening...' : value}
        </Anchor>
      ) : (
        <Text size="xs" className="field-value">{value}</Text>
      )}
    </Box>
  )
}

function ArtifactActions({ filePath, sessionUrl }: { filePath: string; sessionUrl?: string }) {
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
          <Files size={14} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Open file">
        <ActionIcon aria-label="Open file" variant="subtle" color="gray" size="sm" loading={opening} onClick={openPath}>
          <ExternalLink size={14} />
        </ActionIcon>
      </Tooltip>
      {sessionUrl ? <Anchor href={sessionUrl} target="_blank" rel="noreferrer" size="xs">Open in Netlify</Anchor> : null}
      {error ? <Text size="xs" c="red" mt={4}>{error}</Text> : null}
    </Group>
  )
}
