import { useEffect, useMemo, useState } from 'react'
import { ActionIcon, Alert, Anchor, Badge, Box, Button, Checkbox, Code, Group, Modal, Paper, ScrollArea, SegmentedControl, Select, Spoiler, Stack, Text, Textarea, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { Check, CheckCircle2, ExternalLink, FileSearch, Play, RefreshCw } from 'lucide-react'
import { openLocalFile, startRunFollowup } from '../api'
import { agentLabel, workflowName } from '../run-format'
import { buildRunFollowupRequest, defaultFollowupArtifactIds, defaultFollowupMode, defaultFollowupModels, defaultFollowupTarget, defaultFollowupThreadTarget, followupPlanLine, followupThreadTargets, formatArtifactBytes, selectedFollowupArtifacts, SUPPORTED_FOLLOWUP_MODELS } from '../run-followup-composer'
import type { RunDetails, RunFollowupResponse, DashboardRun } from '../types'
import { AgentIcon } from './AgentIcon'

type RunFollowupModalProps = {
  opened: boolean
  onClose: () => void
  run: DashboardRun
  details: RunDetails
  onSubmitted: (response: RunFollowupResponse) => void | Promise<void>
}

type RunFollowupContentProps = Omit<RunFollowupModalProps, 'opened'> & {
  closeLabel?: string
  onSubmittingChange?: (submitting: boolean) => void
}

type FollowupArtifact = RunDetails['followupArtifacts'][number]
const VISIBLE_ARTIFACT_LIMIT = 5

function openArtifactPath(filePath: string) {
  if (!filePath) return
  void openLocalFile(filePath).catch((error) => {
    notifications.show({
      color: 'red',
      title: 'Could not open artifact',
      message: error instanceof Error ? error.message : String(error),
    })
  })
}

function targetNetlifyUrl(target?: RunDetails['followupTargets'][number] | null): string {
  return target?.links.sessionUrl || target?.links.agentRunUrl || ''
}

function targetSelectLabel(target: RunDetails['followupTargets'][number]): string {
  if (target.kind === 'agent-result' && target.agent) {
    const prefix = target.stepNumber ? `Step ${target.stepNumber}: ` : ''
    const title = target.stepTitle || target.label.replace(/^Step\s+\d+:\s*/, '').split(' · ')[0] || 'Agent run'
    return `${prefix}${title} · ${agentLabel(target.agent)} result`
  }
  return target.label
}

function ArtifactRow({ artifact, advanced = false }: { artifact: FollowupArtifact; advanced?: boolean }) {
  return (
    <Group className="run-followup-artifact-row" gap="xs" wrap="nowrap">
      <Checkbox
        className="run-followup-artifact-checkbox"
        value={artifact.id}
        label={(
          <Group gap={6} wrap="nowrap" className="run-followup-artifact-label">
            <Text size="sm" truncate>{artifact.label}</Text>
            <Text size="xs" c="dimmed">{formatArtifactBytes(artifact.sizeBytes)}</Text>
            {advanced ? <Badge size="xs" color="gray" variant="light">advanced</Badge> : null}
          </Group>
        )}
      />
      <Tooltip label="Open artifact in editor" withArrow>
        <ActionIcon
          type="button"
          size="sm"
          variant="subtle"
          color="gray"
          aria-label={`Open ${artifact.label}`}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            openArtifactPath(artifact.absolutePath)
          }}
        >
          <FileSearch size={15} />
        </ActionIcon>
      </Tooltip>
    </Group>
  )
}

function notifyFollowupSubmitted(response: RunFollowupResponse) {
  const warnings = response.followup.warnings || []
  const firstLink = response.followup.submissions.find((submission) => submission.links.agentRunUrl)?.links.agentRunUrl || ''
  const firstLocalArtifact = response.followup.submissions.find((submission) => submission.sessionArtifactPath || submission.runnerArtifactPath)
  const localPath = firstLocalArtifact?.sessionArtifactPath || firstLocalArtifact?.runnerArtifactPath || ''
  notifications.show({
    color: warnings.length > 0 ? 'yellow' : 'green',
    title: warnings.length > 0 ? 'Follow-up started, but local artifact persistence needs attention' : 'Follow-up started',
    message: (
      <Stack gap={6}>
        <Text size="sm">
          {response.followup.submissions.length} submission{response.followup.submissions.length === 1 ? '' : 's'} accepted.
          {response.followup.sourceWorkflow ? ' Updating source workflow.' : response.followup.persistedWorkflow ? ' Opening fresh run view.' : ''}
        </Text>
        {warnings.length > 0 ? <Text size="xs" c="dimmed">{warnings.join(' · ')}</Text> : null}
        <Group gap="xs">
          {firstLink ? (
            <Button component="a" href={firstLink} target="_blank" rel="noreferrer" size="compact-xs" variant="light" rightSection={<ExternalLink size={12} />}>
              Open Netlify run
            </Button>
          ) : null}
          {localPath ? (
            <Button size="compact-xs" variant="light" onClick={() => void openLocalFile(localPath)}>
              Open local artifact
            </Button>
          ) : null}
        </Group>
      </Stack>
    ),
    autoClose: warnings.length > 0 ? 8000 : 5000,
  })
}

export function RunFollowupContent({ onClose, run, details, onSubmitted, closeLabel = 'Back to results', onSubmittingChange }: RunFollowupContentProps) {
  const initialThreadTarget = useMemo(() => defaultFollowupThreadTarget(details), [details])
  const initialTarget = useMemo(() => initialThreadTarget || defaultFollowupTarget(details), [details, initialThreadTarget])
  const threadTargets = useMemo(() => followupThreadTargets(details), [details])
  const [targetId, setTargetId] = useState(initialTarget?.id || '')
  const [mode, setMode] = useState<'follow-up-thread' | 'fresh-runner'>(defaultFollowupMode(details))
  const [models, setModels] = useState<string[]>(defaultFollowupModels(initialTarget))
  const [artifactIds, setArtifactIds] = useState<string[]>(defaultFollowupArtifactIds(details))
  const [noContextConfirmed, setNoContextConfirmed] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState<RunFollowupResponse | null>(null)

  useEffect(() => {
    const threadTarget = defaultFollowupThreadTarget(details)
    const target = threadTarget || defaultFollowupTarget(details)
    setTargetId(target?.id || '')
    setMode(defaultFollowupMode(details))
    setModels(defaultFollowupModels(target))
    setArtifactIds(defaultFollowupArtifactIds(details))
    setNoContextConfirmed(false)
    setPrompt('')
    setError('')
    setSuccess(null)
  }, [details])

  useEffect(() => {
    onSubmittingChange?.(submitting)
  }, [onSubmittingChange, submitting])

  const target = useMemo(
    () => details.followupTargets.find((candidate) => candidate.id === targetId) || initialTarget,
    [details.followupTargets, initialTarget, targetId],
  )
  const selectedArtifacts = useMemo(
    () => selectedFollowupArtifacts(details.followupArtifacts, artifactIds),
    [artifactIds, details.followupArtifacts],
  )
  const visibleArtifacts = details.followupArtifacts.slice(0, VISIBLE_ARTIFACT_LIMIT)
  const extraArtifacts = details.followupArtifacts.slice(VISIBLE_ARTIFACT_LIMIT)
  const totalArtifactBytes = selectedArtifacts.reduce((sum, artifact) => sum + (artifact.sizeBytes || 0), 0)
  const targetUrl = targetNetlifyUrl(target)
  const artifactSelectionValid = selectedArtifacts.length > 0 || noContextConfirmed
  const submitDisabled = submitting || !target || !prompt.trim() || models.length === 0 || !artifactSelectionValid

  const toggleModel = (model: string) => {
    setModels((value) => (
      value.includes(model)
        ? value.filter((item) => item !== model)
        : [...value, model]
    ))
  }

  const changeMode = (value: string) => {
    const nextMode = value as 'follow-up-thread' | 'fresh-runner'
    setMode(nextMode)
    if (nextMode !== 'follow-up-thread') return
    const nextTarget = target?.runnerId ? target : initialThreadTarget
    if (!nextTarget) return
    setTargetId(nextTarget.id)
    setModels(defaultFollowupModels(nextTarget))
  }

  const submit = async () => {
    if (!run.runId || submitDisabled) return
    setSubmitting(true)
    setError('')
    setSuccess(null)
    try {
      const response = await startRunFollowup(run.runId, buildRunFollowupRequest({
        mode,
        prompt,
        target,
        models,
        artifacts: selectedArtifacts,
      }))
      setSuccess(response)
      notifyFollowupSubmitted(response)
      await onSubmitted(response)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Stack gap="md" className="run-followup-content">
      <Box className="run-followup-scroll">
        <Group gap="xs" wrap="wrap" className="run-followup-context">
          <Badge variant="light">{workflowName(run)}</Badge>
          {run.branch ? <Badge color="gray" variant="light">{run.branch}</Badge> : null}
          {run.target?.sha ? <Code>{run.target.sha.slice(0, 12)}</Code> : null}
        </Group>

        {error ? <Alert color="red" variant="light">{error}</Alert> : null}
        {success ? (
          <Alert color="green" variant="light" icon={<CheckCircle2 size={16} />}>
            <Stack gap={4}>
              <Text fw={700}>Follow-up started</Text>
              {success.followup.submissions.map((submission) => (
                <Group key={`${submission.agent}:${submission.runnerId}:${submission.sessionId}`} gap="xs" wrap="nowrap">
                  <Text size="sm">{agentLabel(submission.agent)} · {submission.mode === 'continue-runner' ? 'follow-up thread' : 'fresh runner'}</Text>
                  {submission.links.agentRunUrl ? (
                    <Button
                      component="a"
                      href={submission.links.agentRunUrl}
                      target="_blank"
                      rel="noreferrer"
                      size="compact-xs"
                      variant="subtle"
                      rightSection={<ExternalLink size={12} />}
                    >
                      Open
                    </Button>
                  ) : null}
                </Group>
              ))}
            </Stack>
          </Alert>
        ) : null}

        <Box className="run-followup-grid">
          <Stack gap="md" className="run-followup-form-column">
            <Paper className="run-followup-panel" withBorder>
              <Stack gap="sm">
                <SegmentedControl
                  value={mode}
                  onChange={changeMode}
                  data={[
                    { value: 'follow-up-thread', label: 'Follow-up prompt on previous Agent Run', disabled: threadTargets.length === 0 },
                    { value: 'fresh-runner', label: 'Start fresh agent runner' },
                  ]}
                  fullWidth
                />

                {mode === 'follow-up-thread' ? (
                  <Select
                    classNames={{
                      dropdown: 'run-followup-target-select-dropdown',
                      option: 'run-followup-target-select-option',
                    }}
                    label={(
                      <Group component="span" gap={6} wrap="nowrap" className="run-followup-target-label">
                        <Text component="span" inherit>Select the previous Agent Run to follow up on</Text>
                        {targetUrl ? (
                          <Tooltip label="Open selected run in Netlify" withArrow>
                            <ActionIcon
                              component="a"
                              href={targetUrl}
                              target="_blank"
                              rel="noreferrer"
                              aria-label="Open selected follow-up target in Netlify"
                              className="run-followup-target-link"
                              onClick={(event) => event.stopPropagation()}
                              size="xs"
                              variant="subtle"
                            >
                              <ExternalLink size={12} />
                            </ActionIcon>
                          </Tooltip>
                        ) : null}
                      </Group>
                    )}
                    data={threadTargets.map((candidate) => ({
                      value: candidate.id,
                      label: targetSelectLabel(candidate),
                    }))}
                    leftSection={target?.agent ? <AgentIcon agent={target.agent} /> : null}
                    leftSectionWidth={34}
                    value={target?.runnerId ? targetId : initialThreadTarget?.id || ''}
                    onChange={(value) => {
                      const nextTarget = threadTargets.find((candidate) => candidate.id === value)
                      setTargetId(value || '')
                      setModels(defaultFollowupModels(nextTarget || null))
                    }}
                    renderOption={({ option, checked }) => {
                      const optionTarget = threadTargets.find((candidate) => candidate.id === option.value)
                      return (
                        <Group className="run-followup-target-option-content" data-checked={checked || undefined} gap="xs" wrap="nowrap">
                          {optionTarget?.agent ? (
                            <Box className={`run-followup-target-option-icon ${optionTarget.agent}`}>
                              <AgentIcon agent={optionTarget.agent} />
                            </Box>
                          ) : null}
                          <Text className="run-followup-target-option-label" size="sm" fw={checked ? 800 : 600} truncate>
                            {option.label}
                          </Text>
                          <Box className="run-followup-target-option-check" aria-hidden="true">
                            {checked ? <Check size={16} strokeWidth={3} /> : null}
                          </Box>
                        </Group>
                      )
                    }}
                    withCheckIcon={false}
                    searchable
                    nothingFoundMessage="No existing runner targets"
                  />
                ) : null}

                <Box>
                  <Text size="xs" fw={800} c="dimmed" className="run-followup-section-label">Models</Text>
                  <Group className="run-followup-model-row" gap="xs" mt={6} role="group" aria-label="Models">
                    {SUPPORTED_FOLLOWUP_MODELS.map((model) => {
                      const active = models.includes(model)
                      return (
                        <button
                          key={model}
                          type="button"
                          className={`agent-chip run-followup-model-chip ${model}${active ? '' : ' inactive'}`}
                          aria-pressed={active}
                          aria-label={agentLabel(model)}
                          onClick={() => toggleModel(model)}
                        >
                          <AgentIcon agent={model} />
                          <span>{agentLabel(model)}</span>
                        </button>
                      )
                    })}
                  </Group>
                </Box>
              </Stack>
            </Paper>

            <Textarea
              className="run-followup-prompt"
              label="What should the next agent do?"
              placeholder="Tell the next agent exactly what to do with these results..."
              minRows={9}
              autosize
              value={prompt}
              onChange={(event) => setPrompt(event.currentTarget.value)}
              required
            />

            <Paper className="run-followup-plan" withBorder>
              <Stack gap={4}>
                <Text size="xs" fw={800} c="dimmed" className="run-followup-section-label">Submission plan</Text>
                {models.length > 0 && target ? models.map((model) => (
                  <Text key={model} size="sm">
                    {targetUrl && mode === 'follow-up-thread' && target.agent === model ? (
                      <Anchor href={targetUrl} target="_blank" rel="noreferrer">
                        {followupPlanLine(model, mode, target)}
                      </Anchor>
                    ) : followupPlanLine(model, mode, target)}
                  </Text>
                )) : (
                  <Text size="sm" c="dimmed">Select a target and at least one model.</Text>
                )}
                {mode === 'follow-up-thread' && target?.runnerId ? (
                  <Text size="xs" c="dimmed">
                    Existing runner:{' '}
                    {targetUrl ? (
                      <Anchor href={targetUrl} target="_blank" rel="noreferrer">
                        <Code>{target.runnerId}</Code>
                      </Anchor>
                    ) : <Code>{target.runnerId}</Code>}
                  </Text>
                ) : null}
              </Stack>
            </Paper>
          </Stack>

          <Paper className="run-followup-panel run-followup-artifacts-panel" withBorder>
            <Stack gap="xs">
              <Group justify="space-between" align="center">
                <Text size="xs" fw={800} c="dimmed" className="run-followup-section-label">Artifacts</Text>
                <Text size="xs" c="dimmed">{selectedArtifacts.length} selected · {formatArtifactBytes(totalArtifactBytes)}</Text>
              </Group>
              <Checkbox.Group value={artifactIds} onChange={setArtifactIds}>
                <Stack gap={4}>
                  {visibleArtifacts.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact} advanced={artifact.advanced} />)}
                  {extraArtifacts.length > 0 ? (
                    <Spoiler
                      maxHeight={0}
                      showLabel={`Show ${extraArtifacts.length} more artifacts`}
                      hideLabel="Hide extra artifacts"
                    >
                      <Stack gap={4} mt={4}>
                        {extraArtifacts.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact} advanced={artifact.advanced} />)}
                      </Stack>
                    </Spoiler>
                  ) : null}
                </Stack>
              </Checkbox.Group>
              {selectedArtifacts.length === 0 ? (
                <Alert color="yellow" variant="light">
                  <Checkbox
                    checked={noContextConfirmed}
                    onChange={(event) => setNoContextConfirmed(event.currentTarget.checked)}
                    label="Run without attaching prior result artifacts"
                  />
                </Alert>
              ) : null}
            </Stack>
          </Paper>
        </Box>
      </Box>

      <Group justify="space-between" align="center" className="run-followup-footer">
        <Group gap="xs" wrap="nowrap">
          <Tooltip disabled={Boolean(prompt.trim())} label="Instructions are required" withArrow>
            <Button
              leftSection={submitting ? <RefreshCw size={16} className="spin" /> : <Play size={16} />}
              onClick={submit}
              disabled={submitDisabled}
              loading={submitting}
            >
              Run follow-up
            </Button>
          </Tooltip>
          {targetUrl ? (
            <Button
              component="a"
              href={targetUrl}
              target="_blank"
              rel="noreferrer"
              variant="subtle"
              color="gray"
              rightSection={<ExternalLink size={14} />}
            >
              Open selected run
            </Button>
          ) : null}
        </Group>
        <Button variant="subtle" color="gray" onClick={onClose} disabled={submitting}>{closeLabel}</Button>
      </Group>
    </Stack>
  )
}

export function RunFollowupModal({ opened, onClose, run, details, onSubmitted }: RunFollowupModalProps) {
  const [submitting, setSubmitting] = useState(false)

  return (
    <Modal
      opened={opened}
      onClose={submitting ? () => undefined : onClose}
      title={<Text fw={800}>Send to next agent</Text>}
      size="52rem"
      centered
      classNames={{ content: 'run-followup-modal-content' }}
      scrollAreaComponent={ScrollArea.Autosize}
    >
      <RunFollowupContent
        onClose={onClose}
        run={run}
        details={details}
        onSubmitted={onSubmitted}
        closeLabel="Close"
        onSubmittingChange={setSubmitting}
      />
    </Modal>
  )
}
