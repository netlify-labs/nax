import { ActionIcon, Badge, Box, Group, Paper, ScrollArea, Stack, Text, Title, Tooltip, UnstyledButton } from '@mantine/core'
import { GitBranch, History, RotateCcw } from 'lucide-react'
import { runId, statusBadgeStyle, statusColor, statusLabel } from '../run-format'
import { statusKey } from '../status-model'
import type { DashboardRun } from '../types'

type Props = {
  runs: DashboardRun[]
  selectedRunId: string
  onSelect: (run: DashboardRun) => void
  onOpenDetails: (run: DashboardRun) => void
  onResume: (run: DashboardRun) => void
}

export function RecentRuns({ runs, selectedRunId, onSelect, onOpenDetails, onResume }: Props) {
  return (
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
                      onClick={() => onOpenDetails(run)}
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
                    onClick={() => onOpenDetails(run)}
                  >
                    <Badge
                      className={`run-status ${statusKey(run.status || '')}`}
                      variant="light"
                      color={statusColor(run.status || '')}
                      size="xs"
                      style={statusBadgeStyle(run.status || '')}
                    >
                      {statusLabel(run.status || 'unknown')}
                    </Badge>
                    <Text size="xs" c="dimmed" truncate>{runId(run)}</Text>
                  </UnstyledButton>
                </Box>
              </Paper>
            ))}
          </Stack>
        </ScrollArea>
    </Box>
  )
}
