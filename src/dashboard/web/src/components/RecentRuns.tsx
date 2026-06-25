import { ActionIcon, Badge, Box, Button, Group, Paper, ScrollArea, Stack, Text, Title, Tooltip } from '@mantine/core'
import { History, Info, RotateCcw } from 'lucide-react'
import { runId, statusBadgeStyle, statusColor, statusLabel } from '../run-format'
import { statusKey } from '../status-model'
import type { DashboardRun } from '../types'

type Props = {
  runs: DashboardRun[]
  selectedRunId: string
  hasMore: boolean
  loadingMore: boolean
  durableShownCount: number
  durableTotal: number
  onSelect: (run: DashboardRun) => void
  onOpenDetails: (run: DashboardRun) => void
  onLoadMore: () => void
  onResume: (run: DashboardRun) => void
}

export function RecentRuns({
  runs,
  selectedRunId,
  hasMore,
  loadingMore,
  durableShownCount,
  durableTotal,
  onSelect,
  onOpenDetails,
  onLoadMore,
  onResume,
}: Props) {
  const showCount = durableTotal > 0
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
                role="button"
                tabIndex={0}
                onClick={() => onSelect(run)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  onSelect(run)
                }}
              >
                <Box className="run-item-main">
                  <Group className="run-item-title-row" gap={6} justify="space-between" wrap="nowrap">
                    <Box className="run-item-details-button">
                      <Group gap={6} wrap="nowrap">
                        <History size={14} />
                        <Text fw={700} size="sm" truncate>{run.flowTitle || run.flowId || runId(run)}</Text>
                      </Group>
                    </Box>
                    <Group gap={4} wrap="nowrap">
                      <Tooltip label="View run details">
                        <ActionIcon
                          type="button"
                          variant="subtle"
                          color="gray"
                          size="xs"
                          aria-label="View run details"
                          onClick={(event) => {
                            event.stopPropagation()
                            onOpenDetails(run)
                          }}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <Info size={13} />
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
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            <RotateCcw size={13} />
                          </ActionIcon>
                        </Tooltip>
                      ) : null}
                    </Group>
                  </Group>
                  <Box className="run-item-details-button">
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
                  </Box>
                </Box>
              </Paper>
            ))}
            {showCount ? (
              <Text size="xs" c="dimmed" ta="center">
                Showing {Math.min(durableShownCount, durableTotal)} of {durableTotal} saved runs
              </Text>
            ) : null}
            {hasMore ? (
              <Button
                leftSection={<History size={14} />}
                loading={loadingMore}
                onClick={onLoadMore}
                size="xs"
                variant="light"
                fullWidth
              >
                Load older
              </Button>
            ) : null}
          </Stack>
        </ScrollArea>
    </Box>
  )
}
