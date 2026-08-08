import { Box, Button, Group, MultiSelect, Popover, Select, Stack, Text } from '@mantine/core'
import { Check, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'

import { MAX_STEP_AGENT_INSTANCES, agentInstanceId } from '../agent-instances'
import type { AgentInstanceDescriptor } from '../types'
import { AgentIcon } from './AgentIcon'
import type { AgentCatalog } from './ModelEffortFields'

type Props = {
  catalog: AgentCatalog
  disabled?: boolean
  maxInstances?: number
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

export function AddAgentInstances({ catalog, disabled, maxInstances = MAX_STEP_AGENT_INSTANCES, onAdd }: Props) {
  const firstProvider = catalog.providers[0]?.id || ''
  const [opened, setOpened] = useState(false)
  const [agent, setAgent] = useState(firstProvider)
  const provider = catalog.providers.find((candidate) => candidate.id === agent)
  const allModelsPresetLabel = `All ${provider?.label || 'provider'} models`
  const initialSelection = flagshipSelection(catalog, firstProvider)
  const [models, setModels] = useState<string[]>(initialSelection.models)
  const [efforts, setEfforts] = useState<string[]>(initialSelection.efforts)
  const orderedModels = useMemo(() => {
    const availableModels = provider?.models || []
    if (!provider?.defaultModel) return availableModels
    return [
      ...availableModels.filter((model) => model.id === provider.defaultModel),
      ...availableModels.filter((model) => model.id !== provider.defaultModel),
    ]
  }, [provider])
  const modelOptions = orderedModels.map((model) => ({ value: model.id, label: model.label }))
  const effortOptions = useMemo(() => {
    const ids = new Set<string>()
    const definitions = models.length > 0
      ? orderedModels.filter((model) => models.includes(model.id))
      : []
    return definitions.flatMap((model) => model.efforts).filter((effort) => {
      if (ids.has(effort.id)) return false
      ids.add(effort.id)
      return true
    }).map((effort) => ({ value: effort.id, label: effort.label }))
  }, [models, orderedModels])
  const combinationCount = models.length === 0 ? 1 : models.length * Math.max(efforts.length, 1)
  const overLimit = combinationCount > maxInstances
  const addDisabled = disabled || maxInstances < 1 || catalog.providers.length === 0
  const addDisabledTitle = maxInstances < 1
    ? `This step already has the maximum of ${MAX_STEP_AGENT_INSTANCES} agent instances.`
    : catalog.providers.length === 0
      ? 'No agent providers are available.'
      : disabled
        ? 'Agents cannot be added to this step.'
        : undefined

  const add = () => {
    if (!agent || overLimit) return
    const selectedModels = orderedModels.filter((model) => models.includes(model.id))
    const combinations = selectedModels.length === 0
      ? [{ agent, id: agentInstanceId(agent), resolvedFrom: 'open' as const }]
      : selectedModels.flatMap((model) => {
          const selectedEfforts = efforts.length > 0 ? efforts : [undefined]
          return selectedEfforts.map((effort) => ({
            agent,
            model: model.id,
            ...(effort ? { effort } : {}),
            id: agentInstanceId(agent, model.id, effort),
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
    }).slice(0, maxInstances)
    onAdd(instances)
    setOpened(false)
  }

  const selectAllEffortsForModel = () => {
    const model = models[0]
    const definition = orderedModels.find((candidate) => candidate.id === model)
    if (!model || !definition) return
    setModels([model])
    setEfforts(definition.efforts.map((effort) => effort.id))
  }

  const selectAllProviderModels = () => {
    setModels(orderedModels.slice(0, maxInstances).map((model) => model.id))
    setEfforts([])
  }

  return (
    <Popover opened={opened} onChange={setOpened} width={320} position="bottom-start" withArrow shadow="md" trapFocus>
      <Popover.Target>
        <Button
          className="add-agent-button"
          size="compact-xs"
          variant="subtle"
          leftSection={<Plus size={13} />}
          disabled={addDisabled}
          title={addDisabledTitle}
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
            leftSection={agent ? (
              <Box className="agent-provider-select-logo">
                <AgentIcon agent={agent} />
              </Box>
            ) : null}
            leftSectionWidth={36}
            allowDeselect={false}
            comboboxProps={{ withinPortal: false }}
            renderOption={({ option, checked }) => (
              <Group className="agent-provider-option-content" data-checked={checked || undefined} gap="xs" wrap="nowrap">
                <Box className="agent-provider-option-logo">
                  <AgentIcon agent={option.value} />
                </Box>
                <Text className="agent-provider-option-label" size="sm" fw={checked ? 700 : 500}>
                  {option.label}
                </Text>
                <Box className="agent-provider-option-check" aria-hidden="true">
                  {checked ? <Check size={15} strokeWidth={3} /> : null}
                </Box>
              </Group>
            )}
            withCheckIcon={false}
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
            maxValues={Math.max(1, maxInstances)}
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
              <Button size="compact-xs" variant="light" onClick={selectAllProviderModels}>{allModelsPresetLabel}</Button>
              <Button size="compact-xs" variant="light" onClick={addFlagshipOfEveryProvider}>Flagship of every provider</Button>
              <Button size="compact-xs" variant="subtle" color="gray" onClick={() => { setModels([]); setEfforts([]) }}>Auto</Button>
            </Group>
          </Stack>
          <Text size="xs" c={overLimit ? 'red' : 'dimmed'}>
            {overLimit
              ? `Choose at most ${maxInstances} instance${maxInstances === 1 ? '' : 's'} for the remaining capacity.`
              : models.length === 0
                ? 'Adds 1 Auto instance.'
                : `Adds ${combinationCount} instance${combinationCount === 1 ? '' : 's'}.`}
          </Text>
          <Group justify="flex-end">
            <Button size="xs" variant="subtle" color="gray" onClick={() => setOpened(false)}>Cancel</Button>
            <Button size="xs" disabled={overLimit} onClick={add}>Add</Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}
