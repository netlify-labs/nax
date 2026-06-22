import { useMemo, useState } from 'react'
import { Badge, Box, Group, NavLink, ScrollArea, Stack, Text, TextInput, Title } from '@mantine/core'
import { Search } from 'lucide-react'
import type { Workflow } from '../types'

function modelSummary(workflow: Workflow): string {
  const seen = new Set<string>()
  for (const step of workflow.steps) {
    for (const agent of step.agents) seen.add(agent)
  }
  return [...seen].join(', ')
}

type Props = {
  workflows: Workflow[]
  selectedWorkflowId: string
  loading: boolean
  onSelect: (id: string) => void
}

export function WorkflowList({ workflows, selectedWorkflowId, loading, onSelect }: Props) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return workflows
    return workflows.filter((workflow) => [
      workflow.id,
      workflow.title,
      workflow.description,
      workflow.sourceLabel,
      modelSummary(workflow),
    ].join(' ').toLowerCase().includes(normalized))
  }, [query, workflows])

  return (
    <Box className="workflow-sidebar" aria-label="Workflows">
      <Group className="panel-header" justify="space-between" wrap="nowrap">
        <Title order={2} size="sm">Workflows</Title>
        <Badge variant="light" color="gray">{workflows.length}</Badge>
      </Group>
      <Box p="sm">
        <TextInput
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search"
          aria-label="Search workflows"
          leftSection={<Search size={16} />}
          size="sm"
        />
      </Box>
      <ScrollArea className="workflow-list-scroll">
        <Stack gap="xs" px="sm" pb="sm">
          {loading ? <Text className="empty-state" size="sm" c="dimmed">Loading</Text> : null}
          {!loading && filtered.length === 0 ? <Text className="empty-state" size="sm" c="dimmed">No matches</Text> : null}
        {filtered.map((workflow) => (
          <NavLink
            key={workflow.id}
            component="button"
            active={workflow.id === selectedWorkflowId}
            variant="light"
            color="blue"
            className="workflow-item"
            py={6}
            onClick={() => onSelect(workflow.id)}
            label={<Text fw={700} size="sm" truncate>{workflow.title}</Text>}
            description={(
              <Stack gap={2}>
                <Text size="xs" c="dimmed" truncate>{workflow.steps.length} steps · {modelSummary(workflow) || 'no agents'}</Text>
                {workflow.source !== 'bundled' ? (
                  <Badge variant="light" color="indigo" size="xs">{workflow.sourceLabel || workflow.source}</Badge>
                ) : null}
              </Stack>
            )}
          />
        ))}
        </Stack>
      </ScrollArea>
    </Box>
  )
}
