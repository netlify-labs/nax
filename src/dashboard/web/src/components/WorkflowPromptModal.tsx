import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert, Box, Group, Modal, Paper, ScrollArea, Stack, Text, Title } from '@mantine/core'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ArtifactActions, MarkdownTableOfContents, RunDetailsTimeline, useResetMarkdownScroll, type TimelineEntry } from './RunDetailsModal'
import type { Workflow, WorkflowGraph, WorkflowGraphNodeData, WorkflowStep } from '../types'

type Props = {
  opened: boolean
  onClose: () => void
  workflow: Workflow | null
  graph: WorkflowGraph | null
  initialStepId?: string
  projectRoot?: string
  canOpenLocalFiles?: boolean
  onStepSelect?: (stepId: string) => void
}

type PromptStepMetadata = {
  stepId: string
  action: string
  submit: string
  waitFor: string
  agents: string
  promptTitle: string
  promptFile: string
  promptFilePath: string
}

type PromptTimelineEntry = TimelineEntry & {
  metadata: PromptStepMetadata
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

function fileNameFromPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').pop() || value
}

function graphDataByStepId(graph: WorkflowGraph | null): Map<string, WorkflowGraphNodeData> {
  return new Map((graph?.nodes || []).map((node) => [node.data.stepId, node.data]))
}

function valueOrDash(value: string): string {
  return value.trim() || '-'
}

function agentsLabel(agents: string[]): string {
  return agents.length > 0 ? agents.join(', ') : 'none'
}

function promptPathForStep(step: WorkflowStep, node?: WorkflowGraphNodeData): string {
  return node?.promptPath || step.prompt || ''
}

function promptMarkdownForStep(node?: WorkflowGraphNodeData): string {
  return node?.promptMarkdown || ''
}

function trimLeadingMarkdownH1(markdown: string): string {
  return markdown.replace(/^\s*#\s+[^\n]+(?:\n+|$)/, '').trimStart()
}

function promptTitleForStep(step: WorkflowStep, node?: WorkflowGraphNodeData): string {
  return node?.promptTitle || step.title || step.id
}

function stepSubtitle(step: WorkflowStep, node?: WorkflowGraphNodeData): string {
  const agents = node?.agents || step.agents || []
  return [
    valueOrDash(node?.action || step.action || ''),
    valueOrDash(node?.submit || step.submit || ''),
    agents.length > 0 ? agents.join(', ') : 'no agents',
  ].filter((value) => value !== '-').join(' · ')
}

function stepMetadataForStep({
  node,
  projectRoot,
  step,
}: {
  node?: WorkflowGraphNodeData
  projectRoot?: string
  step: WorkflowStep
}): PromptStepMetadata {
  const agents = node?.agents || step.agents || []
  const promptPath = promptPathForStep(step, node)
  return {
    stepId: step.id,
    action: node?.action || step.action || '',
    submit: node?.submit || step.submit || '',
    waitFor: node?.waitFor || step.waitFor || '',
    agents: agentsLabel(agents),
    promptTitle: promptTitleForStep(step, node),
    promptFile: promptPath ? fileNameFromPath(shortHomePath(promptPath, projectRoot)) : '',
    promptFilePath: promptPath,
  }
}

function stepPromptMarkdown({
  node,
  step,
}: {
  node?: WorkflowGraphNodeData
  step: WorkflowStep
}): string {
  const promptMarkdown = trimLeadingMarkdownH1(promptMarkdownForStep(node))
  const description = node?.description || step.description || ''

  return [
    description,
    promptMarkdown || '_No prompt markdown is configured for this step._',
  ].filter(Boolean).join('\n\n')
}

function buildPromptEntries({
  graph,
  projectRoot,
  workflow,
}: {
  graph: WorkflowGraph | null
  projectRoot?: string
  workflow: Workflow | null
}): PromptTimelineEntry[] {
  if (!workflow) return []
  const nodeByStepId = graphDataByStepId(graph)
  return workflow.steps.map((step, index) => {
    const node = nodeByStepId.get(step.id)
    const promptPath = promptPathForStep(step, node)
    return {
      id: `prompt-step:${step.id}`,
      kind: 'step',
      title: step.title || step.id,
      subtitle: stepSubtitle(step, node),
      status: 'pending',
      sourceType: node?.submit || step.submit,
      path: promptPath,
      absolutePath: promptPath,
      markdown: stepPromptMarkdown({ node, step }),
      promptMarkdown: promptMarkdownForStep(node),
      promptPath,
      promptTitle: promptTitleForStep(step, node),
      stepNumber: index + 1,
      metadata: stepMetadataForStep({ node, projectRoot, step }),
    }
  })
}

function MetadataField({
  actions = null,
  label,
  truncate = false,
  value,
}: {
  actions?: ReactNode
  label: string
  truncate?: boolean
  value: string
}) {
  if (!value) return null
  return (
    <Box>
      <Text size="10px" fw={800} c="dimmed" tt="uppercase">{label}</Text>
      <Group gap={6} wrap="nowrap" className="metadata-field-row">
        <Text size="xs" className={`field-value${truncate ? ' field-value-truncated' : ''}`} title={value}>{value}</Text>
        {actions}
      </Group>
    </Box>
  )
}

function PromptStepMetadataPanel({ canOpenLocalFiles = true, entry }: { canOpenLocalFiles?: boolean; entry: PromptTimelineEntry | null }) {
  if (!entry) return null
  return (
    <Paper className="run-details-meta" withBorder>
      <Text size="xs" fw={800} c="dimmed" className="run-details-meta-heading">Metadata</Text>
      <Stack gap={10}>
        <MetadataField label="Step ID" value={entry.metadata.stepId} />
        <MetadataField label="Action" value={entry.metadata.action} />
        <MetadataField label="Submit" value={entry.metadata.submit} />
        <MetadataField label="Wait for" value={entry.metadata.waitFor} />
        <MetadataField label="Agents" value={entry.metadata.agents} />
        <MetadataField label="Prompt title" value={entry.metadata.promptTitle} />
        <MetadataField
          actions={<ArtifactActions canOpenLocalFiles={canOpenLocalFiles} filePath={entry.metadata.promptFilePath} />}
          label="Prompt file"
          truncate
          value={entry.metadata.promptFile}
        />
      </Stack>
    </Paper>
  )
}

export function WorkflowPromptModal({ opened, onClose, workflow, graph, initialStepId = '', projectRoot = '', canOpenLocalFiles = true, onStepSelect }: Props) {
  const [activeTimelineId, setActiveTimelineId] = useState('')
  const markdownScrollRef = useRef<HTMLDivElement>(null)
  const entries = useMemo(
    () => buildPromptEntries({ graph, projectRoot, workflow }),
    [graph, projectRoot, workflow],
  )
  const preferredTimelineId = initialStepId ? `prompt-step:${initialStepId}` : entries[0]?.id || ''
  const activeEntry: PromptTimelineEntry | null = entries.find((entry) => entry.id === activeTimelineId) || entries[0] || null
  const activeIndex = Math.max(0, entries.findIndex((entry) => entry.id === activeEntry?.id))
  const tocEntry = activeEntry ? { ...activeEntry, id: `${activeEntry.id}:config` } : null

  useEffect(() => {
    if (!opened) return
    setActiveTimelineId(entries.some((entry) => entry.id === preferredTimelineId) ? preferredTimelineId : entries[0]?.id || '')
  }, [entries, opened, preferredTimelineId])

  useResetMarkdownScroll(markdownScrollRef, activeEntry?.id || '', opened)

  const selectTimelineEntry = (entry: TimelineEntry) => {
    const entryId = entry.id
    setActiveTimelineId(entryId)
    const promptEntry = entries.find((candidate) => candidate.id === entryId)
    const stepId = promptEntry?.metadata.stepId || entryId.replace(/^prompt-step:/, '')
    if (stepId && stepId !== activeEntry?.metadata.stepId) onStepSelect?.(stepId)
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={workflow ? `"${workflow.title}" workflow details` : 'Workflow details'}
      size="90rem"
      centered
      classNames={{ content: 'run-details-modal-content', body: 'run-details-modal-body' }}
      scrollAreaComponent={ScrollArea.Autosize}
    >
      {!workflow ? (
        <Alert color="yellow" variant="light">Select a workflow before opening prompt details.</Alert>
      ) : entries.length === 0 ? (
        <Alert color="yellow" variant="light">This workflow has no configured steps.</Alert>
      ) : (
        <Box className="run-details-layout">
          <RunDetailsTimeline
            activeTimelineId={activeEntry?.id || ''}
            parentTimelineEntries={entries}
            timelineEntries={entries}
            timelineProgressIndex={Math.max(activeIndex, entries.length - 1)}
            timelineColor="gray"
            heading="Workflow prompts"
            onSelect={selectTimelineEntry}
            canRunFollowup={false}
            onRunFollowup={() => undefined}
          />
          <Box className="run-details-content">
            {activeEntry ? (
              <Stack gap="sm" style={{ marginTop: -4 }}>
                <Group gap="xs" wrap="wrap">
                  <Title order={2} size="h4">Step {activeEntry.stepNumber}: {activeEntry.title}</Title>
                  <ArtifactActions canOpenLocalFiles={canOpenLocalFiles} filePath={activeEntry.absolutePath} />
                </Group>
                <Box className="run-details-markdown-shell">
                  <Box className="prompt-markdown run-details-markdown workflow-prompt-markdown" ref={markdownScrollRef}>
                    <MarkdownRenderer copyLabel="Copy prompt markdown">{activeEntry.markdown}</MarkdownRenderer>
                  </Box>
                </Box>
              </Stack>
            ) : (
              <Text c="dimmed">No prompt details were found.</Text>
            )}
          </Box>
          <Stack className="run-details-side" gap="md">
            <MarkdownTableOfContents entry={tocEntry} scrollRootRef={markdownScrollRef} />
            <PromptStepMetadataPanel canOpenLocalFiles={canOpenLocalFiles} entry={activeEntry} />
          </Stack>
        </Box>
      )}
    </Modal>
  )
}
