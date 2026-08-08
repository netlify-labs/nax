import { Button, Group, MultiSelect, Popover, SegmentedControl, Select, Stack, Text } from '@mantine/core'
import { Crown, Gauge, Layers3, Network, Plus, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'

import { MAX_STEP_AGENT_INSTANCES, agentInstanceId } from '../agent-instances'
import type { AgentInstanceDescriptor } from '../types'
import { AgentProviderSelect } from './AgentProviderSelect'
import { defaultAgentConfig, type AgentCatalog } from './ModelEffortFields'

type Props = {
  catalog: AgentCatalog
  disabled?: boolean
  existingInstances?: AgentInstanceDescriptor[]
  maxInstances?: number
  onAdd: (instances: AgentInstanceDescriptor[]) => void
}

type AddMode = 'single' | 'multiple'

function modelSelection(
  catalog: AgentCatalog,
  agent: string,
  model: string,
  existingIds: ReadonlySet<string>,
): { models: string[]; efforts: string[] } {
  if (!model || model === 'auto') return { models: [], efforts: [] }
  const provider = catalog.providers.find((candidate) => candidate.id === agent)
  const definition = provider?.models.find((candidate) => candidate.id === model)
  const effortCandidates = [
    ...[...(definition?.efforts || [])].reverse().map((candidate) => candidate.id),
    'auto',
  ]
  const effort = effortCandidates.find((candidate) => !existingIds.has(agentInstanceId(agent, model, candidate)))
  return {
    models: [model],
    efforts: effort && effort !== 'auto' ? [effort] : [],
  }
}

function flagshipSelection(
  catalog: AgentCatalog,
  agent: string,
  existingIds: ReadonlySet<string> = new Set(),
): { models: string[]; efforts: string[] } {
  const { model } = defaultAgentConfig(catalog, agent)
  return modelSelection(catalog, agent, model, existingIds)
}

export function AddAgentInstances({ catalog, disabled, existingInstances = [], maxInstances = MAX_STEP_AGENT_INSTANCES, onAdd }: Props) {
  const firstProvider = catalog.providers[0]?.id || ''
  const existingIds = useMemo(() => new Set(existingInstances.map((instance) => instance.id)), [existingInstances])
  const [opened, setOpened] = useState(false)
  const [mode, setMode] = useState<AddMode>('single')
  const [agent, setAgent] = useState(firstProvider)
  const provider = catalog.providers.find((candidate) => candidate.id === agent)
  const allModelsPresetLabel = `All ${provider?.label || 'provider'} models`
  const initialSelection = flagshipSelection(catalog, firstProvider, existingIds)
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
  const existingEffortLabelsByModel = useMemo(() => new Map(orderedModels.map((model) => {
    const existingEfforts = existingInstances
      .filter((instance) => instance.agent === agent && instance.model === model.id)
      .map((instance) => {
        if (!instance.effort || instance.effort === 'auto') return 'Auto'
        return model.efforts.find((effort) => effort.id === instance.effort)?.label || instance.effort
      })
    return [model.id, existingEfforts] as const
  })), [agent, existingInstances, orderedModels])
  const modelOptions = orderedModels.map((model) => {
    const availableEfforts = ['auto', ...model.efforts.map((effort) => effort.id)]
    return {
      value: model.id,
      label: model.label,
      disabled: availableEfforts.every((effort) => existingIds.has(agentInstanceId(agent, model.id, effort))),
    }
  })
  const singleModelOptions = [
    { value: 'auto', label: 'Auto', disabled: existingIds.has(agentInstanceId(agent)) },
    ...modelOptions,
  ]
  const singleModel = models[0] || 'auto'
  const singleModelDefinition = orderedModels.find((model) => model.id === singleModel)
  const singleEffortOptions = singleModel === 'auto'
    ? [{ value: 'auto', label: 'Auto', disabled: existingIds.has(agentInstanceId(agent)) }]
    : [
        {
          value: 'auto',
          label: 'Auto',
          disabled: existingIds.has(agentInstanceId(agent, singleModel)),
        },
        ...(singleModelDefinition?.efforts || []).map((effort) => ({
          value: effort.id,
          label: effort.label,
          disabled: existingIds.has(agentInstanceId(agent, singleModel, effort.id)),
        })),
      ]
  const effortOptions = useMemo(() => {
    const ids = new Set<string>()
    const definitions = models.length > 0
      ? orderedModels.filter((model) => models.includes(model.id))
      : []
    return definitions.flatMap((model) => model.efforts).filter((effort) => {
      if (ids.has(effort.id)) return false
      ids.add(effort.id)
      return true
    }).map((effort) => ({
      value: effort.id,
      label: effort.label,
      disabled: models.length > 0 && models.every((model) => existingIds.has(agentInstanceId(agent, model, effort.id))),
    }))
  }, [agent, existingIds, models, orderedModels])
  const selectedModels = orderedModels.filter((model) => models.includes(model.id))
  const candidateModels = mode === 'single' ? selectedModels.slice(0, 1) : selectedModels
  const candidateEfforts = mode === 'single' ? efforts.slice(0, 1) : efforts
  const candidateCombinations: AgentInstanceDescriptor[] = candidateModels.length === 0
    ? [{ agent, id: agentInstanceId(agent), resolvedFrom: 'open' }]
    : candidateModels.flatMap((model) => {
        const selectedEfforts = candidateEfforts.length > 0 ? candidateEfforts : [undefined]
        return selectedEfforts.map((effort) => ({
          agent,
          model: model.id,
          ...(effort ? { effort } : {}),
          id: agentInstanceId(agent, model.id, effort),
          resolvedFrom: 'pinned' as const,
        }))
      })
  const newCombinations = candidateCombinations.filter((instance) => !existingIds.has(instance.id))
  const duplicateCount = candidateCombinations.length - newCombinations.length
  const combinationCount = newCombinations.length
  const overLimit = combinationCount > maxInstances
  const noNewConfigurations = combinationCount === 0
  const addDisabled = disabled || maxInstances < 1 || catalog.providers.length === 0
  const addDisabledTitle = maxInstances < 1
    ? `This step already has the maximum of ${MAX_STEP_AGENT_INSTANCES} agent instances.`
    : catalog.providers.length === 0
      ? 'No agent providers are available.'
      : disabled
        ? 'Agents cannot be added to this step.'
        : undefined

  const changeMode = (nextMode: AddMode) => {
    if (nextMode === 'single') {
      setModels((current) => current.slice(0, 1))
      setEfforts((current) => current.slice(0, 1))
    }
    setMode(nextMode)
  }

  const add = () => {
    if (!agent || overLimit || noNewConfigurations) return
    onAdd(newCombinations)
    setOpened(false)
  }

  const selectFlagshipPreset = () => {
    const selection = flagshipSelection(catalog, agent, existingIds)
    setMode('single')
    setModels(selection.models)
    setEfforts(selection.efforts)
  }

  const addFlagshipOfEveryProvider = () => {
    const instances = catalog.providers.flatMap((candidate) => {
      const selection = flagshipSelection(catalog, candidate.id, existingIds)
      const model = selection.models[0]
      if (!model) return []
      const effort = selection.efforts[0]
      const instance = {
        agent: candidate.id,
        model,
        ...(effort ? { effort } : {}),
        id: agentInstanceId(candidate.id, model, effort),
        resolvedFrom: 'pinned' as const,
      }
      return existingIds.has(instance.id) ? [] : [instance]
    }).slice(0, maxInstances)
    if (instances.length === 0) return
    onAdd(instances)
    setOpened(false)
  }

  const selectAllEffortsForModel = () => {
    const model = models[0]
    const definition = orderedModels.find((candidate) => candidate.id === model)
    if (!model || !definition) return
    const availableEfforts = definition.efforts
      .map((effort) => effort.id)
      .filter((effort) => !existingIds.has(agentInstanceId(agent, model, effort)))
    setMode('multiple')
    setModels([model])
    setEfforts(availableEfforts.length > 0
      ? availableEfforts
      : definition.efforts.map((effort) => effort.id))
  }

  const selectAllProviderModels = () => {
    const availableModels = orderedModels
      .filter((model) => !existingIds.has(agentInstanceId(agent, model.id)))
      .slice(0, maxInstances)
      .map((model) => model.id)
    setMode('multiple')
    setModels(availableModels.length > 0
      ? availableModels
      : orderedModels.slice(0, maxInstances).map((model) => model.id))
    setEfforts([])
  }

  const selectAutoPreset = () => {
    setMode('single')
    setModels([])
    setEfforts([])
  }

  return (
    <Popover opened={opened} onChange={setOpened} width={720} position="bottom-start" withArrow shadow="md" trapFocus>
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
            if (!opened) {
              const selection = flagshipSelection(catalog, agent, existingIds)
              setMode('single')
              setModels(selection.models)
              setEfforts(selection.efforts)
            }
            setOpened((value) => !value)
          }}
        >
          Add agent
        </Button>
      </Popover.Target>
      <Popover.Dropdown
        className="agent-config-popover agent-add-popover"
        role="dialog"
        aria-label="Add new agents"
        onClick={(event) => event.stopPropagation()}
      >
        <Stack gap="sm">
          <Text component="h2" size="md" fw={700} lh={1.2}>Add new agent(s)</Text>
          <div className="agent-add-layout">
            <Stack className="agent-add-fields" gap="sm">
              <AgentProviderSelect
                catalog={catalog}
                agent={agent}
                withinPortal={false}
                onChange={(value) => {
                  const nextAgent = value || firstProvider
                  const selection = flagshipSelection(catalog, nextAgent, existingIds)
                  setAgent(nextAgent)
                  setModels(selection.models)
                  setEfforts(selection.efforts)
                }}
              />
              <SegmentedControl
                className="agent-add-mode"
                aria-label="Agent selection mode"
                size="xs"
                fullWidth
                value={mode}
                data={[
                  { value: 'single', label: 'Single agent' },
                  { value: 'multiple', label: 'Multiple agents' },
                ]}
                onChange={(value) => changeMode(value as AddMode)}
              />
              {mode === 'single' ? (
                <>
                  <Select
                    label="Model"
                    description="Choose one model, or Auto to let Agent Runner decide."
                    size="xs"
                    data={singleModelOptions}
                    value={singleModel}
                    searchable
                    allowDeselect={false}
                    comboboxProps={{ withinPortal: false }}
                    renderOption={({ option }) => {
                      const existingEfforts = option.value === 'auto'
                        ? existingIds.has(agentInstanceId(agent)) ? ['Already selected'] : []
                        : existingEffortLabelsByModel.get(option.value) || []
                      const note = option.value === 'auto'
                        ? existingEfforts[0] || ''
                        : existingEfforts.length > 0 ? `${existingEfforts.join(', ')} already selected` : ''
                      return (
                        <Group className="agent-selection-option" gap="xs" wrap="nowrap">
                          <Text className="agent-selection-option-label" size="sm">{option.label}</Text>
                          {note ? <Text className="agent-selection-option-note" size="xs">{note}</Text> : null}
                        </Group>
                      )
                    }}
                    onChange={(value) => {
                      const selection = modelSelection(catalog, agent, value || 'auto', existingIds)
                      setModels(selection.models)
                      setEfforts(selection.efforts)
                    }}
                  />
                  <Select
                    label="Reasoning effort"
                    description={singleModel === 'auto'
                      ? 'Choose a model to configure effort.'
                      : singleModelDefinition && singleModelDefinition.efforts.length === 0
                        ? 'This model does not expose configurable reasoning effort.'
                        : 'Choose one effort for this agent instance.'}
                    size="xs"
                    data={singleEffortOptions}
                    value={efforts[0] || 'auto'}
                    disabled={singleModel === 'auto' || Boolean(singleModelDefinition && singleModelDefinition.efforts.length === 0)}
                    allowDeselect={false}
                    comboboxProps={{ withinPortal: false }}
                    renderOption={({ option }) => {
                      const alreadySelected = existingIds.has(agentInstanceId(agent, singleModel, option.value))
                      return (
                        <Group className="agent-selection-option" gap="xs" wrap="nowrap">
                          <Text className="agent-selection-option-label" size="sm">{option.label}</Text>
                          {alreadySelected ? <Text className="agent-selection-option-note" size="xs">Already selected</Text> : null}
                        </Group>
                      )
                    }}
                    onChange={(value) => setEfforts(value && value !== 'auto' ? [value] : [])}
                  />
                </>
              ) : (
                <>
                  <MultiSelect
                    label="Models"
                    description="Each selected model creates a separate agent instance."
                    size="xs"
                    data={modelOptions}
                    value={models}
                    maxValues={Math.max(1, maxInstances)}
                    searchable
                    comboboxProps={{ withinPortal: false }}
                    renderOption={({ option }) => {
                      const existingEfforts = existingEffortLabelsByModel.get(option.value) || []
                      return (
                        <Group className="agent-selection-option" gap="xs" wrap="nowrap">
                          <Text className="agent-selection-option-label" size="sm">{option.label}</Text>
                          {existingEfforts.length > 0 ? (
                            <Text className="agent-selection-option-note" size="xs">
                              {existingEfforts.join(', ')} already selected
                            </Text>
                          ) : null}
                        </Group>
                      )
                    }}
                    onChange={(value) => {
                      setModels(value)
                      setEfforts([])
                    }}
                  />
                  <MultiSelect
                    label="Reasoning efforts"
                    description="Every selected effort combines with every selected model."
                    size="xs"
                    data={effortOptions}
                    value={efforts}
                    disabled={models.length === 0 || effortOptions.length === 0}
                    comboboxProps={{ withinPortal: false }}
                    renderOption={({ option }) => {
                      const existingModelCount = models.filter((model) => (
                        existingIds.has(agentInstanceId(agent, model, option.value))
                      )).length
                      const note = existingModelCount === models.length && models.length > 0
                        ? 'Already selected'
                        : existingModelCount > 0
                          ? `Already selected for ${existingModelCount} of ${models.length} models`
                          : ''
                      return (
                        <Group className="agent-selection-option" gap="xs" wrap="nowrap">
                          <Text className="agent-selection-option-label" size="sm">{option.label}</Text>
                          {note ? <Text className="agent-selection-option-note" size="xs">{note}</Text> : null}
                        </Group>
                      )
                    }}
                    onChange={setEfforts}
                  />
                </>
              )}
            </Stack>
            <Stack className="agent-add-presets" gap="xs">
              <div className="agent-add-presets-heading">
                <Text size="xs" fw={700}>Quick presets</Text>
                <Text size="xs" c="dimmed">Build common lineups without configuring each instance.</Text>
              </div>
              <button className="agent-preset-card" type="button" onClick={selectFlagshipPreset}>
                <span className="agent-preset-icon"><Crown size={16} /></span>
                <span className="agent-preset-copy">
                  <span className="agent-preset-title">Flagship / highest</span>
                  <span className="agent-preset-description">Select this provider’s strongest model and effort.</span>
                </span>
              </button>
              <button
                className="agent-preset-card"
                type="button"
                disabled={models.length !== 1}
                onClick={selectAllEffortsForModel}
              >
                <span className="agent-preset-icon"><Gauge size={16} /></span>
                <span className="agent-preset-copy">
                  <span className="agent-preset-title">This model × all efforts</span>
                  <span className="agent-preset-description">Run the selected model at every supported effort.</span>
                </span>
              </button>
              <button className="agent-preset-card" type="button" onClick={selectAllProviderModels}>
                <span className="agent-preset-icon"><Layers3 size={16} /></span>
                <span className="agent-preset-copy">
                  <span className="agent-preset-title">{allModelsPresetLabel}</span>
                  <span className="agent-preset-description">Select this provider’s strongest available models.</span>
                </span>
              </button>
              <button className="agent-preset-card" type="button" onClick={addFlagshipOfEveryProvider}>
                <span className="agent-preset-icon"><Network size={16} /></span>
                <span className="agent-preset-copy">
                  <span className="agent-preset-title">Add flagship of every provider</span>
                  <span className="agent-preset-description">Immediately add one top configuration per provider.</span>
                </span>
              </button>
              <button className="agent-preset-card" type="button" onClick={selectAutoPreset}>
                <span className="agent-preset-icon"><Sparkles size={16} /></span>
                <span className="agent-preset-copy">
                  <span className="agent-preset-title">Auto</span>
                  <span className="agent-preset-description">Let Agent Runner choose the model and effort.</span>
                </span>
              </button>
            </Stack>
          </div>
          <Text size="xs" c={overLimit ? 'red' : 'dimmed'}>
            {overLimit
              ? `Choose at most ${maxInstances} instance${maxInstances === 1 ? '' : 's'} for the remaining capacity.`
              : noNewConfigurations
                ? 'That exact provider, model, and effort configuration is already selected.'
                : duplicateCount > 0
                  ? `Adds ${combinationCount} new instance${combinationCount === 1 ? '' : 's'}; skips ${duplicateCount} already selected.`
                  : models.length === 0
                    ? 'Adds 1 Auto instance.'
                    : `Adds ${combinationCount} instance${combinationCount === 1 ? '' : 's'}.`}
          </Text>
          <Group justify="flex-end">
            <Button size="xs" variant="subtle" color="gray" onClick={() => setOpened(false)}>Cancel</Button>
            <Button size="xs" disabled={overLimit || noNewConfigurations} onClick={add}>Add</Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}
