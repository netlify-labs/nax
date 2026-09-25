// Collapsible table of a run's structured findings (findings.json) inside the run details modal.
// Renders nothing when the run's workflow declares no findings.
import { Accordion, ActionIcon, Badge, CopyButton, Group, Table, Text, Tooltip } from '@mantine/core'
import { Check, Copy, ListChecks } from 'lucide-react'
import type { Finding, FindingsArtifact } from '../types'

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'red',
  high: 'orange',
  medium: 'yellow',
  low: 'green',
  info: 'gray',
}

function location(finding: Finding): string {
  if (!finding.file) return ''
  return `${finding.file}${finding.line ? `:${finding.line}${finding.lineEnd ? `-${finding.lineEnd}` : ''}` : ''}`
}

function findingSummaryLine(finding: Finding): string {
  const where = location(finding)
  return `[${finding.severity}] ${finding.title}${where ? ` — ${where}` : ''}`
}

export function FindingsPanel({ artifact }: { artifact: FindingsArtifact | null | undefined }) {
  if (!artifact || artifact.findings.length === 0) return null
  const consensus = artifact.findings.filter((finding) => finding.bucket === 'consensus').length
  return (
    <Accordion variant="contained" className="findings-panel" defaultValue={null}>
      <Accordion.Item value="findings">
        <Accordion.Control icon={<ListChecks size={16} />}>
          <Group gap="xs">
            <Text fw={600} size="sm">Findings</Text>
            <Badge size="sm" variant="light">{consensus} consensus</Badge>
            {artifact.findings.length > consensus ? <Badge size="sm" variant="light" color="gray">{artifact.findings.length - consensus} other</Badge> : null}
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <Table striped highlightOnHover className="findings-table">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Rank</Table.Th>
                <Table.Th>Severity</Table.Th>
                <Table.Th>Finding</Table.Th>
                <Table.Th>Location</Table.Th>
                <Table.Th>Agents</Table.Th>
                <Table.Th aria-label="Copy" />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {artifact.findings.map((finding) => (
                <Table.Tr key={finding.key} className="findings-row">
                  <Table.Td>{finding.rank ?? '-'}</Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="light" color={SEVERITY_COLORS[finding.severity] || 'gray'}>{finding.severity}</Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" fw={500}>{finding.title}</Text>
                    {finding.bucket !== 'consensus' || finding.status ? (
                      <Text size="xs" c="dimmed">{[finding.bucket !== 'consensus' ? finding.bucket : '', finding.status].filter(Boolean).join(' · ')}</Text>
                    ) : null}
                  </Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{location(finding)}</Text></Table.Td>
                  <Table.Td><Text size="xs">{finding.agents.join(', ')}</Text></Table.Td>
                  <Table.Td>
                    <CopyButton value={findingSummaryLine(finding)}>
                      {({ copied, copy }) => (
                        <Tooltip label={copied ? 'Copied' : 'Copy finding'} withArrow>
                          <ActionIcon variant="subtle" size="sm" onClick={copy} aria-label={`Copy ${finding.localId}`}>
                            {copied ? <Check size={14} /> : <Copy size={14} />}
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </CopyButton>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {artifact.diagnostics.length > 0 ? (
            <Text size="xs" c="dimmed" mt="xs">{artifact.diagnostics.length} diagnostic{artifact.diagnostics.length === 1 ? '' : 's'}: {artifact.diagnostics.map((diagnostic) => diagnostic.code).join(', ')}</Text>
          ) : null}
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  )
}
