import { useState } from 'react'
import { Badge, Box, Button, Code, Divider, Group, Modal, ScrollArea, Stack, Table, Text, ThemeIcon, Title } from '@mantine/core'
import { FileText, GitBranch, Layers, Route } from 'lucide-react'
import { MarkdownRenderer } from './MarkdownRenderer'
import type { Workflow, WorkflowGraph, WorkflowGraphNodeData } from '../types'

type Props = {
  workflow: Workflow | null
  selectedNode: WorkflowGraphNodeData | null
  graph: WorkflowGraph | null
}

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <Table.Tr>
      <Table.Td><Text size="xs" c="dimmed">{label}</Text></Table.Td>
      <Table.Td><Text size="xs" fw={700} ta="right" className="field-value">{value || '-'}</Text></Table.Td>
    </Table.Tr>
  )
}

export function Inspector({ workflow, selectedNode, graph }: Props) {
  const [promptOpen, setPromptOpen] = useState(false)
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
            {selectedNode.description ? <Text size="sm" c="dimmed">{selectedNode.description}</Text> : null}
            <Button
              variant="light"
              size="xs"
              leftSection={<FileText size={14} />}
              onClick={() => setPromptOpen(true)}
              disabled={!promptMarkdown}
            >
              View prompt
            </Button>
            <Table variant="vertical" layout="fixed" withRowBorders={false}>
              <Table.Tbody>
                <Field label="Action" value={selectedNode.action} />
                <Field label="Submit" value={selectedNode.submit} />
                <Field label="Wait for" value={selectedNode.waitFor} />
                <Field label="Status" value={selectedNode.status} />
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
      <Modal
        opened={promptOpen && Boolean(selectedNode)}
        onClose={() => setPromptOpen(false)}
        title={selectedNode ? `${selectedNode.promptTitle || selectedNode.title} prompt` : 'Prompt'}
        size="80rem"
        centered
        scrollAreaComponent={ScrollArea.Autosize}
      >
        <Stack gap="sm">
          {selectedNode?.promptPath ? <Code block className="path-code">{selectedNode.promptPath}</Code> : null}
          <Box className="prompt-markdown">
            {promptMarkdown ? (
              <MarkdownRenderer fallback="Rendering prompt...">{promptMarkdown}</MarkdownRenderer>
            ) : (
              <Text c="dimmed">No prompt markdown available.</Text>
            )}
          </Box>
        </Stack>
      </Modal>
    </Box>
  )
}
