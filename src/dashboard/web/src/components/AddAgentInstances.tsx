import { Button, Group, MultiSelect, Popover, Select, Stack, Text } from '@mantine/core'
import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'

import { agentInstanceId } from '../agent-instances'
import type { AgentInstanceDescriptor } from '../types'
import type { AgentCatalog } from './ModelEffortFields'

type Props = {
  catalog: AgentCatalog
  disabled?: boolean
  onAdd: (instances: AgentInstanceDescriptor[]) => void
}

function flagshipSelection(catalog: AgentCatalog, agent: string): { models: string[]; efforts: string[] } {
  const provider = catalog.providers.find((candidate) => candidate.id === agent)
  const model = provider?.defaultModel || provider?.models[0]?.id || ''
  const definition = provider?.models.find((candidate) => candidate.id === model)
  const highestEffort = definition?.efforts.at(-1)?.id || ''
  return {
    models: model ? [model] : [],
    efforts: highestEffort ? [highestEffort] : [],
  }
}

export function AddAgentInstances({ catalog, disabled, onAdd }: Props) {
  const firstProvider = catalog.providers[0]?.id || ''
  const [opened, setOpened] = useState(false)
  const [agent, setAgent] = useState(firstProvider)
  const provider = catalog.providers.find((candidate) => candidate.id === agent)
  const initialSelection = flagshipSelection(catalog, firstProvider)
  const [models, setModels] = useState<string[]>(initialSelection.models)
  const [efforts, setEfforts] = useState<string[]>(initialSelection.efforts)
  const modelOptions = (provider?.models || []).map((model) => ({ value: model.id, label: model.label }))
  const effortOptions = useMemo(() => {
    const ids = new Set<string>()
    const definitions = models.length > 0
      ? (provider?.models || []).filter((model) => models.includes(model.id))
      : []
    return definitions.flatMap((model) => model.efforts).filter((effort) => {
      if (ids.has(effort.id)) return false
      ids.add(effort.id)
      return true
    }).map((effort) => ({ value: effort.id, label: effort.label }))
  }, [models, provider])

  const add = () => {
    if (!agent) return
    const combinations = models.length === 0
      ? [{ agent, id: agentInstanceId(agent), resolvedFrom: 'open' as const }]
      : models.flatMap((model) => {
          const selectedEfforts = efforts.length > 0 ? efforts : [undefined]
          return selectedEfforts.map((effort) => ({
            agent,
            model,
            ...(effort ? { effort } : {}),
            id: agentInstanceId(agent, model, effort),
            resolvedFrom: 'pinned' as const,
          }))
        })
    onAdd(combinations)
    setOpened(false)
  }

  const selectFlagshipPreset = () => {
    const selection = flagshipSelection(catalog, agent)
    setModels(selection.models)
    setEfforts(selection.efforts)
  }

  const addFlagshipOfEveryProvider = () => {
    const instances = catalog.providers.flatMap((candidate) => {
      const selection = flagshipSelection(catalog, candidate.id)
      const model = selection.models[0]
      if (!model) return []
      const effort = selection.efforts[0]
      return [{
        agent: candidate.id,
        model,
        ...(effort ? { effort } : {}),
        id: agentInstanceId(candidate.id, model, effort),
        resolvedFrom: 'pinned' as const,
      }]
    })
    onAdd(instances)
    setOpened(false)
  }

  const selectAllEffortsForModel = () => {
    const model = models[0]
    const definition = provider?.models.find((candidate) => candidate.id === model)
    if (!model || !definition) return
    setModels([model])
    setEfforts(definition.efforts.map((effort) => effort.id))
  }

  const selectAllProviderModels = () => {
    setModels((provider?.models || []).map((model) => model.id))
    setEfforts([])
  }

  return (
    <Popover opened={opened} onChange={setOpened} width={320} position="bottom-start" withArrow shadow="md" trapFocus>
      <Popover.Target>
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<Plus size={13} />}
          disabled={disabled || catalog.providers.length === 0}
          onClick={(event) => {
            event.stopPropagation()
            setOpened((value) => !value)
          }}
        >
          Add agent
        </Button>
      </Popover.Target>
      <Popover.Dropdown className="agent-config-popover" onClick={(event) => event.stopPropagation()}>
        <Stack gap="sm">
          <Select
            label="Provider"
            size="xs"
            data={catalog.providers.map((candidate) => ({ value: candidate.id, label: candidate.label }))}
            value={agent}
            allowDeselect={false}
            comboboxProps={{ withinPortal: false }}
            onChange={(value) => {
              const nextAgent = value || firstProvider
              const selection = flagshipSelection(catalog, nextAgent)
              setAgent(nextAgent)
              setModels(selection.models)
              setEfforts(selection.efforts)
            }}
          />
          <MultiSelect
            label="Models"
            description="Leave empty for Auto. Multiple models fan out."
            size="xs"
            data={modelOptions}
            value={models}
            searchable
            comboboxProps={{ withinPortal: false }}
            onChange={(value) => {
              setModels(value)
              setEfforts([])
            }}
          />
          <MultiSelect
            label="Reasoning efforts"
            description="Multiple selections combine with every selected model."
            size="xs"
            data={effortOptions}
            value={efforts}
            disabled={models.length === 0 || effortOptions.length === 0}
            comboboxProps={{ withinPortal: false }}
            onChange={setEfforts}
          />
          <Stack gap={6}>
            <Text size="xs" fw={600}>Quick presets</Text>
            <Group gap="xs">
              <Button size="compact-xs" variant="light" onClick={selectFlagshipPreset}>Flagship / highest</Button>
              <Button
                size="compact-xs"
                variant="light"
                disabled={models.length !== 1}
                onClick={selectAllEffortsForModel}
              >
                This model × all efforts
              </Button>
              <Button size="compact-xs" variant="light" onClick={selectAllProviderModels}>All provider models</Button>
              <Button size="compact-xs" variant="light" onClick={addFlagshipOfEveryProvider}>Flagship of every provider</Button>
              <Button size="compact-xs" variant="subtle" color="gray" onClick={() => { setModels([]); setEfforts([]) }}>Auto</Button>
            </Group>
          </Stack>
          <Text size="xs" c="dimmed">
            {models.length === 0 ? 'Adds 1 Auto instance.' : `Adds ${models.length * Math.max(efforts.length, 1)} instance${models.length * Math.max(efforts.length, 1) === 1 ? '' : 's'}.`}
          </Text>
          <Group justify="flex-end">
            <Button size="xs" variant="subtle" color="gray" onClick={() => setOpened(false)}>Cancel</Button>
            <Button size="xs" onClick={add}>Add</Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}
