import { ActionIcon, Badge, Box, Button, Group, Paper, ScrollArea, Select, Stack, Text, TextInput, Title, Tooltip } from '@mantine/core'
import { History, Info, RotateCcw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { filterRuns, runId, statusLabel, usageBadgeText } from '../run-format'
import { StatusBadge } from './StatusBadge'
import type { DashboardRun } from '../types'

const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
]

type Props = {
  runs: DashboardRun[]
  selectedRunId: string
  hasMore: boolean
  loadingMore: boolean
  shownCount: number
  totalCount: number
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
  shownCount,
  totalCount,
  onSelect,
  onOpenDetails,
  onLoadMore,
  onResume,
}: Props) {
  const showCount = totalCount > 0
  const [filterText, setFilterText] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const filterActive = filterText.trim() !== '' || filterStatus !== 'all'
  const visibleRuns = useMemo(
    () => filterRuns(runs, { text: filterText, status: filterStatus }),
    [runs, filterText, filterStatus],
  )
  return (
    <Box className="recent-runs" component="section" aria-label="Recent runs">
        <Group className="panel-header" justify="space-between" wrap="nowrap">
          <Title order={2} size="sm">Runs</Title>
          <Badge variant="light" color="gray">{filterActive ? `${visibleRuns.length}/${runs.length}` : runs.length}</Badge>
        </Group>
        <Group gap="xs" px="sm" pb={4} wrap="nowrap">
          <TextInput
            value={filterText}
            onChange={(event) => setFilterText(event.currentTarget.value)}
            placeholder="Search runs"
            aria-label="Search runs"
            leftSection={<Search size={14} />}
            size="xs"
            style={{ flex: 1 }}
          />
          <Select
            value={filterStatus}
            onChange={(value) => setFilterStatus(value || 'all')}
            data={STATUS_FILTER_OPTIONS}
            aria-label="Filter runs by status"
            size="xs"
            w={124}
          />
        </Group>
        <ScrollArea className="run-list-scroll">
          <Stack gap="xs" p="sm">
            {visibleRuns.length === 0 ? (
              <Text className="empty-state" size="sm" c="dimmed">
                {filterActive ? 'No matching runs — clear the filter to see all.' : 'No runs'}
              </Text>
            ) : null}
            {visibleRuns.map((run) => (
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
                    <StatusBadge status={run.status || ''} label={statusLabel(run.status || 'unknown')} size="xs" />
                    {run.stalled ? (
                      <Tooltip label={run.lastEventAt ? `No events since ${new Date(run.lastEventAt).toLocaleTimeString()}` : 'No recent events'}>
                        <Badge className="run-stalled" variant="outline" color="yellow" size="xs">Stalled</Badge>
                      </Tooltip>
                    ) : null}
                    <Text size="xs" c="dimmed" truncate>{runId(run)}</Text>
                    {usageBadgeText(run.usageTotals) ? (
                      <Text className="run-usage" size="xs" c="dimmed" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>{usageBadgeText(run.usageTotals)}</Text>
                    ) : null}
                  </Box>
                </Box>
              </Paper>
            ))}
            {showCount ? (
              <Text size="xs" c="dimmed" ta="center">
                Showing {Math.min(shownCount, totalCount)} of {totalCount} saved runs
                {filterActive && hasMore ? ' · searching loaded runs only' : ''}
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
