import { useEffect, useMemo, useRef } from 'react'
import { ActionIcon, Alert, Badge, Box, Code, CopyButton, Group, Paper, ScrollArea, Stack, Text, Tooltip } from '@mantine/core'
import { Check, Copy, ListTree, Terminal } from 'lucide-react'
import type { DryRunResult, RunnerEvent } from '../types'

type OutputPanel = {
  title: string
  result: DryRunResult | null
  running: boolean
  error: string
}

type Props = {
  dryRun: Omit<OutputPanel, 'value' | 'title'>
  run: Omit<OutputPanel, 'value' | 'title'>
  events?: RunnerEvent[]
  eventErrors?: string[]
  onViewEvents?: () => void
}

function statusColor(panel: OutputPanel): string {
  if (panel.running) return 'yellow'
  if (panel.result?.status === 'completed') return 'green'
  if (panel.result) return 'red'
  return 'gray'
}

function statusText(panel: OutputPanel): string {
  const { result, running } = panel
  return result ? `${result.status} · ${result.durationMs}ms · exit ${result.exitCode ?? '-'}` : running ? 'running' : 'idle'
}

function stripAnsi(value: string): string {
  return value.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    '',
  )
}

function OutputBadge({ panel }: { panel: OutputPanel }) {
  return (
    <Group gap={7} wrap="nowrap">
      <Badge variant="light" color={statusColor(panel)} size="xs">{statusText(panel)}</Badge>
    </Group>
  )
}

function hasPanelContent(panel: OutputPanel): boolean {
  return Boolean(panel.running || panel.error || panel.result)
}

function panelOutputText(panel: OutputPanel): string {
  const output = panel.result ? [panel.result.stdout, panel.result.stderr].filter(Boolean).join('\n') : ''
  return output ? stripAnsi(output) : panel.running ? 'Running...' : `No ${panel.title.toLowerCase()} output`
}

function OutputSection({ panel }: { panel: OutputPanel }) {
  const visibleOutput = panelOutputText(panel)

  return (
    <Box className="output-section">
      <Group gap={7} wrap="nowrap" className="output-section-title">
        <Terminal size={14} />
        <Text fw={700} size="sm">{panel.title}</Text>
        <OutputBadge panel={panel} />
      </Group>
      {panel.error ? <Alert color="red" variant="light" py={6} radius={0}>{panel.error}</Alert> : null}
      {panel.result?.command?.length ? (
        <Box>
          <Code block className="command-line">{panel.result.command.join(' ')}</Code>
        </Box>
      ) : null}
      <Text component="pre" className="terminal-output">
        {visibleOutput}
      </Text>
    </Box>
  )
}

export function WorkflowOutputTabs({ dryRun, run, events = [], eventErrors = [], onViewEvents }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const panels: OutputPanel[] = [
    { title: 'Dry Run', ...dryRun },
    { title: 'Run', ...run },
  ]
  const visiblePanels = panels.filter(hasPanelContent)
  const outputVersion = useMemo(
    () => visiblePanels.map((panel) => [
      panel.title,
      panel.running,
      panel.error,
      panel.result?.stdout,
      panel.result?.stderr,
      panel.result?.status,
    ].join(':')).join('|'),
    [visiblePanels],
  )

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
  }, [outputVersion])

  const copyText = visiblePanels.map((panel) => `${panel.title}\n${panelOutputText(panel)}`).join('\n\n')

  return (
    <Paper className="dry-run-panel" component="section" aria-label="Workflow output" radius={0} withBorder>
      <Group className="dry-run-header" justify="space-between" wrap="nowrap">
        <Group gap={7} wrap="nowrap">
          <Terminal size={15} />
          <Text fw={700} size="sm">Output</Text>
        </Group>
        <Group gap={6} wrap="nowrap">
          {visiblePanels.map((panel) => <OutputBadge key={panel.title} panel={panel} />)}
          {onViewEvents ? (
            <Tooltip label={eventErrors.length > 0 ? 'View event diagnostics' : 'View raw events'} withArrow>
              <ActionIcon
                variant="subtle"
                color={eventErrors.length > 0 ? 'red' : 'gray'}
                size="sm"
                aria-label="View workflow event diagnostics"
                disabled={events.length === 0 && eventErrors.length === 0}
                onClick={onViewEvents}
              >
                <ListTree size={14} />
              </ActionIcon>
            </Tooltip>
          ) : null}
          <CopyButton value={copyText} timeout={1500}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : 'Copy output'} withArrow>
                <ActionIcon
                  variant="subtle"
                  color={copied ? 'green' : 'gray'}
                  size="sm"
                  aria-label="Copy output to clipboard"
                  disabled={!copyText}
                  onClick={copy}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        </Group>
      </Group>
      <ScrollArea className="dry-run-output" viewportRef={viewportRef}>
        {visiblePanels.length > 0 ? (
          <Stack gap={0}>
            {visiblePanels.map((panel) => <OutputSection key={panel.title} panel={panel} />)}
          </Stack>
        ) : (
          <Text component="pre" className="terminal-output">No workflow output</Text>
        )}
      </ScrollArea>
    </Paper>
  )
}
