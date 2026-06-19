import { Button, Group, Menu, Paper, Select } from '@mantine/core'
import { ChevronDown, Play, Rocket, RotateCcw, Square } from 'lucide-react'
import type { DryRunOptions, Workflow } from '../types'

type Props = {
  workflow: Workflow | null
  options: DryRunOptions
  running: boolean
  realRunning: boolean
  cancelling: boolean
  onChange: (options: DryRunOptions) => void
  onDryRun: () => void
  onRun: () => void
  onCancelRun: () => void
}

export function WorkflowControls({ workflow, options, running, realRunning, cancelling, onChange, onDryRun, onRun, onCancelRun }: Props) {
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
      <Select
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
      {startMode === 'resume' ? (
        <Select
          label="Resume from"
          value={selectedStep}
          onChange={updateSelectedStep}
          data={steps}
          allowDeselect={false}
          size="xs"
        />
      ) : null}
      <Select
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
        <Button.Group>
          <Button
            type="button"
            leftSection={(running || realRunning) ? <RotateCcw size={16} /> : <Rocket size={16} />}
            onClick={onRun}
            disabled={!workflow || running}
            loading={realRunning}
            size="xs"
            color="violet"
          >
            Run
          </Button>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <Button
                type="button"
                aria-label="Run options"
                px={8}
                disabled={!workflow || running || realRunning}
                size="xs"
                color="violet"
              >
                <ChevronDown size={14} />
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<Play size={14} />}
                onClick={onDryRun}
                disabled={!workflow || running || realRunning}
              >
                Dry run
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Button.Group>
      </Group>
    </Paper>
  )
}
