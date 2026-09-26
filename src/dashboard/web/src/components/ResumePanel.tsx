// Resume controls in the run details modal: previews per agent what resume would keep, poll,
// resubmit or skip, then starts the resume. Shown only for failed or interrupted runs.
import { Accordion, Alert, Badge, Button, Checkbox, Group, Stack, Table, Text } from '@mantine/core'
import { RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useResumeRunMutation } from '../queries/dashboard-mutations'
import { useResumePreviewQuery } from '../queries/dashboard-queries'
import type { ResumeAction } from '../types'

const RESUMABLE_STATUSES = new Set(['failed', 'interrupted'])

const ACTION_COLORS: Record<ResumeAction, string> = {
  keep: 'green',
  poll: 'blue',
  resubmit: 'orange',
  submit: 'orange',
  skip: 'gray',
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : ''
}

export function ResumePanel({ runId, status }: { runId: string; status: string }) {
  const [opened, setOpened] = useState(false)
  const [includeCancelled, setIncludeCancelled] = useState(false)
  const previewQuery = useResumePreviewQuery(runId, includeCancelled, { enabled: opened })
  const resumeMutation = useResumeRunMutation()
  if (!runId || !RESUMABLE_STATUSES.has(status)) return null
  const response = previewQuery.data
  const preview = response?.preview
  const loadError = errorMessage(previewQuery.error)
  const resumeError = errorMessage(resumeMutation.error)
  return (
    <Accordion variant="contained" className="resume-panel" value={opened ? 'resume' : null} onChange={(value) => setOpened(value === 'resume')}>
      <Accordion.Item value="resume">
        <Accordion.Control icon={<RotateCcw size={16} />}>
          <Text fw={600} size="sm">Resume run</Text>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack gap="sm">
            {previewQuery.isPending && opened ? <Text size="sm" c="dimmed">Checking what resume would do…</Text> : null}
            {loadError ? <Alert color="red" variant="light">{loadError}</Alert> : null}
            {preview?.step ? (
              <Text size="sm">Step {preview.step.index + 1}/{preview.step.total}: {preview.step.title}</Text>
            ) : null}
            {preview && preview.actions.length > 0 ? (
              <Table className="resume-table">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Agent</Table.Th>
                    <Table.Th>Action</Table.Th>
                    <Table.Th>Why</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {preview.actions.map((action) => (
                    <Table.Tr key={action.instanceId} className="resume-row">
                      <Table.Td><Text size="sm" ff="monospace">{action.instanceId}</Text></Table.Td>
                      <Table.Td><Badge size="sm" variant="light" color={ACTION_COLORS[action.action]}>{action.action}</Badge></Table.Td>
                      <Table.Td><Text size="sm">{action.detail}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            ) : null}
            {preview?.step && !preview.step.started ? <Text size="sm" c="dimmed">This step has not started; every agent runs fresh.</Text> : null}
            {preview ? (
              <Text size="sm" className="resume-counts">
                New agent runs: {preview.counts.newRuns} · Kept: {preview.counts.kept} · Polling: {preview.counts.polling} · Skipped: {preview.counts.skipped}
              </Text>
            ) : null}
            {response?.blocked ? (
              <Alert color="yellow" variant="light" className="resume-blocked">
                {response.blocked.message}
              </Alert>
            ) : null}
            {resumeError ? <Alert color="red" variant="light">{resumeError}</Alert> : null}
            {resumeMutation.isSuccess ? <Alert color="green" variant="light">Resume started.</Alert> : null}
            <Group justify="space-between">
              <Checkbox
                size="xs"
                label="Also resubmit cancelled agents"
                checked={includeCancelled}
                onChange={(event) => setIncludeCancelled(event.currentTarget.checked)}
              />
              <Button
                size="xs"
                leftSection={<RotateCcw size={14} />}
                disabled={!response?.resumable || resumeMutation.isPending || resumeMutation.isSuccess}
                loading={resumeMutation.isPending}
                onClick={() => resumeMutation.mutate({ runId, includeCancelled })}
              >
                Resume
              </Button>
            </Group>
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  )
}
