import { ActionIcon, Badge, Box, Code, Divider, Group, ScrollArea, Stack, Table, Text, ThemeIcon, Title } from '@mantine/core'
import { GitBranch, Info, Layers, Route } from 'lucide-react'
import { statusLabel } from '../run-format'
import type { Workflow, WorkflowGraph, WorkflowGraphNodeData } from '../types'

type Props = {
  workflow: Workflow | null
  selectedNode: WorkflowGraphNodeData | null
  graph: WorkflowGraph | null
  onViewPrompt: (node: WorkflowGraphNodeData) => void
}

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <Table.Tr>
      <Table.Td><Text size="xs" c="dimmed">{label}</Text></Table.Td>
      <Table.Td><Text size="xs" fw={700} ta="right" className="field-value">{value || '-'}</Text></Table.Td>
    </Table.Tr>
  )
}

export function Inspector({ workflow, selectedNode, graph, onViewPrompt }: Props) {
  const promptMarkdown = selectedNode?.promptMarkdown || ''

  return (
    <Box className="inspector" aria-label="Inspector">
      <Group className="panel-header" justify="space-between" wrap="nowrap">
        <Title order={2} size="sm">{selectedNode ? 'Step' : 'Inspector'}</Title>
        {selectedNode ? <Badge variant="light" color="gray">{selectedNode.stepId}</Badge> : null}
      </Group>

      {selectedNode ? (
        <ScrollArea className="inspector-scroll">
          <Stack gap="sm" p="md">
            <Group gap="xs" align="flex-start" wrap="nowrap">
              <ThemeIcon variant="light" color="blue" size="md"><Route size={18} /></ThemeIcon>
              <Title order={3} size="md">{selectedNode.title}</Title>
            </Group>
            <Group gap="xs" align="flex-start" wrap="nowrap">
              {selectedNode.description ? <Text size="sm" c="dimmed">{selectedNode.description}</Text> : null}
              {promptMarkdown ? (
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  aria-label={`View ${selectedNode.title} prompt`}
                  title="View prompt"
                  onClick={() => {
                    if (selectedNode) onViewPrompt(selectedNode)
                  }}
                >
                  <Info size={16} />
                </ActionIcon>
              ) : null}
            </Group>
            <Table variant="vertical" layout="fixed" withRowBorders={false}>
              <Table.Tbody>
                <Field label="Action" value={selectedNode.action} />
                <Field label="Submit" value={selectedNode.submit} />
                <Field label="Wait for" value={selectedNode.waitFor} />
                <Field label="Status" value={statusLabel(selectedNode.status)} />
              </Table.Tbody>
            </Table>
            <Group gap="xs">
              {selectedNode.agents.map((agent) => <Badge variant="light" color="blue" key={agent}>{agent}</Badge>)}
            </Group>
          {selectedNode.input.length > 0 ? (
            <Stack gap="xs">
              <Divider label="Inputs" labelPosition="left" />
              {selectedNode.input.map((input, index) => (
                <Code block key={`${selectedNode.stepId}-${index}`}>{JSON.stringify(input)}</Code>
              ))}
            </Stack>
          ) : null}
          </Stack>
        </ScrollArea>
      ) : workflow ? (
        <ScrollArea className="inspector-scroll">
          <Stack gap="sm" p="md">
            <Group gap="xs" align="flex-start" wrap="nowrap">
              <ThemeIcon variant="light" color="blue" size="md"><Layers size={18} /></ThemeIcon>
              <Title order={3} size="md">{workflow.title}</Title>
            </Group>
            {workflow.description ? <Text size="sm" c="dimmed">{workflow.description}</Text> : null}
            <Table variant="vertical" layout="fixed" withRowBorders={false}>
              <Table.Tbody>
                <Field label="Workflow" value={workflow.id} />
                <Field label="Source" value={workflow.sourceLabel || workflow.source} />
                <Field label="Steps" value={workflow.steps.length} />
                <Field label="Rendered" value={graph?.nodes.length || 0} />
              </Table.Tbody>
            </Table>
            <Divider label={<Group gap={5}><GitBranch size={14} />Definition</Group>} labelPosition="left" />
            <Code block className="path-code">{workflow.file || workflow.dir}</Code>
          </Stack>
        </ScrollArea>
      ) : (
        <Text className="empty-state" size="sm" c="dimmed">No selection</Text>
      )}
    </Box>
  )
}
