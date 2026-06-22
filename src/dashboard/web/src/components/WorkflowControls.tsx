import { ActionIcon, Button, Group, Paper, Select, Text, Tooltip } from '@mantine/core'
import { Info, Play, Rocket, RotateCcw, Square } from 'lucide-react'
import type { DryRunOptions, Workflow } from '../types'

type Props = {
  workflow: Workflow | null
  options: DryRunOptions
  running: boolean
  realRunning: boolean
  cancelling: boolean
  canDryRun?: boolean
  canRun?: boolean
  onChange: (options: DryRunOptions) => void
  onDryRun: () => void
  onRun: () => void
  onCancelRun: () => void
  onViewPrompts: () => void
}

const SHOW_START_CONTROLS = false
const SHOW_TRANSPORT_SELECT = false

export function WorkflowControls({ workflow, options, running, realRunning, cancelling, canDryRun = true, canRun = true, onChange, onDryRun, onRun, onCancelRun, onViewPrompts }: Props) {
  const steps = (workflow?.steps || []).map((step) => ({ value: step.id, label: step.title }))
  const startMode = options.fromStep ? 'resume' : 'beginning'
  const selectedStep = options.fromStep || null
  const update = (patch: Partial<DryRunOptions>) => onChange({ ...options, ...patch })
  const updateStartMode = (value: string) => {
    if (value === 'resume') {
      update({ fromStep: options.fromStep || workflow?.steps[0]?.id || '', step: '' })
      return
    }
    update({ step: '', fromStep: '' })
  }
  const updateSelectedStep = (value: string | null) => {
    update({ fromStep: value || '', step: '' })
  }

  return (
    <Paper className="run-controls" component="section" aria-label="Workflow controls" radius={0} withBorder>
      <Group className="run-control-title-row" gap={6} wrap="nowrap">
        <Text className="run-control-title" size="sm" fw={800} truncate>
          {workflow?.title || 'No workflow selected'}
        </Text>
        {workflow ? (
          <Tooltip label="View workflow prompts">
            <ActionIcon
              aria-label={`View ${workflow.title} prompts`}
              color="gray"
              onClick={onViewPrompts}
              size="sm"
              variant="subtle"
            >
              <Info size={16} />
            </ActionIcon>
          </Tooltip>
        ) : null}
      </Group>
      {SHOW_START_CONTROLS ? (
        <Select
          classNames={{ root: 'run-control-select', label: 'run-control-label', wrapper: 'run-control-input' }}
          label="Run mode"
          value={startMode}
          onChange={(value) => updateStartMode(value || 'beginning')}
          data={[
            { value: 'beginning', label: 'Start from beginning' },
            { value: 'resume', label: 'Choose step to start/resume from' },
          ]}
          allowDeselect={false}
          size="xs"
        />
      ) : null}
      {SHOW_START_CONTROLS && startMode === 'resume' ? (
        <Select
          classNames={{ root: 'run-control-select', label: 'run-control-label', wrapper: 'run-control-input' }}
          label="Resume from"
          value={selectedStep}
          onChange={updateSelectedStep}
          data={steps}
          allowDeselect={false}
          size="xs"
        />
      ) : null}
      {SHOW_TRANSPORT_SELECT ? (
        <Select
          classNames={{ root: 'run-control-select', label: 'run-control-label', wrapper: 'run-control-input' }}
          label="Transport"
          value={options.transport === 'github' ? 'github-actions' : options.transport}
          onChange={(value) => update({ transport: value || 'netlify-api' })}
          data={[
            { value: 'netlify-api', label: 'Local via Netlify API' },
            { value: 'github-actions', label: 'GitHub Actions' },
          ]}
          allowDeselect={false}
          size="xs"
        />
      ) : null}
      <Group gap="xs" wrap="nowrap" className="run-actions">
        {realRunning ? (
          <Button
            type="button"
            leftSection={<Square size={12} fill="currentColor" />}
            onClick={onCancelRun}
            disabled={cancelling}
            loading={cancelling}
            size="xs"
            color="red"
            variant="light"
          >
            Cancel
          </Button>
        ) : null}
        <Button
          type="button"
          leftSection={<Play size={14} />}
          onClick={onDryRun}
          disabled={!workflow || !canDryRun || running || realRunning}
          loading={running}
          size="xs"
          variant="light"
        >
          Dry run
        </Button>
        <Button
          type="button"
          leftSection={(running || realRunning) ? <RotateCcw size={16} /> : <Rocket size={16} />}
          onClick={onRun}
          disabled={!workflow || !canRun || running}
          loading={realRunning}
          size="xs"
          color="violet"
        >
          Run
        </Button>
      </Group>
    </Paper>
  )
}
