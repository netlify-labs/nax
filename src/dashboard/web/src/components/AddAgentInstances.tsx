import { Button, Divider, Group, MultiSelect, Popover, Select, Stack, Text } from '@mantine/core'
import { Bot, ChevronLeft, Crown, Gauge, Layers3, Network, Plus, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

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
type WizardStep = 'choose' | 'configure'

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
  const [step, setStep] = useState<WizardStep>('choose')
  const [mode, setMode] = useState<AddMode>('single')
  const [agent, setAgent] = useState(firstProvider)

  // Close on Escape even when focus has left the dropdown (e.g. after clicking a
  // preset), which Mantine's own trapFocus/closeOnEscape path can miss.
  useEffect(() => {
    if (!opened) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpened(false)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [opened])

  const provider = catalog.providers.find((candidate) => candidate.id === agent)
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
    const model = models[0] || flagshipSelection(catalog, agent, existingIds).models[0] || orderedModels[0]?.id
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

  const startSingle = () => {
    selectFlagshipPreset()
    setStep('configure')
  }

  const startMultiple = () => {
    selectAllProviderModels()
    setStep('configure')
  }

  // Which quick preset the current selection corresponds to, so its card reads
  // as selected. Derived from state so it stays accurate as the user edits.
  const activePreset = useMemo(() => {
    const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((value) => b.includes(value))
    if (mode === 'single') {
      if (models.length === 0) return 'auto'
      const flagship = flagshipSelection(catalog, agent, existingIds)
      if (sameSet(models, flagship.models) && sameSet(efforts, flagship.efforts)) return 'flagship'
      return null
    }
    if (models.length === 1 && efforts.length > 0) return 'all-efforts'
    if (models.length >= 1 && efforts.length === 0) return 'all-models'
    return null
  }, [agent, catalog, efforts, existingIds, models, mode])

  const presetClass = (key: string) => `agent-preset-card${activePreset === key ? ' selected' : ''}`

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
              setStep('choose')
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
        {step === 'choose' ? (
          <Stack gap="sm">
            <div className="agent-add-heading">
              <Text component="h2" size="md" fw={700} lh={1.2}>Add new agents</Text>
              <Text size="xs" c="dimmed">Start by choosing how many agents to add.</Text>
            </div>
            <div className="agent-choose-grid">
              <button className="agent-choose-card" type="button" onClick={startSingle}>
                <span className="agent-choose-icon"><Bot size={20} /></span>
                <span className="agent-choose-title">One agent</span>
                <span className="agent-choose-description">Configure a single model and reasoning effort.</span>
              </button>
              <button className="agent-choose-card" type="button" onClick={startMultiple}>
                <span className="agent-choose-icon"><Layers3 size={20} /></span>
                <span className="agent-choose-title">Several agents</span>
                <span className="agent-choose-description">Build a lineup across models and efforts.</span>
              </button>
            </div>
            <Divider my={2} label="or" labelPosition="center" />
            <button className="agent-preset-card" type="button" onClick={addFlagshipOfEveryProvider}>
              <span className="agent-preset-icon"><Network size={16} /></span>
              <span className="agent-preset-copy">
                <span className="agent-preset-title">One of each provider</span>
                <span className="agent-preset-description">Add the best config for every provider at once.</span>
              </span>
            </button>
            <Group justify="flex-end">
              <Button size="xs" variant="subtle" color="gray" onClick={() => setOpened(false)}>Cancel</Button>
            </Group>
          </Stack>
        ) : (
          <Stack gap="sm">
            <div className="agent-add-heading-row">
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<ChevronLeft size={13} />}
                onClick={() => setStep('choose')}
              >
                Back
              </Button>
              <Text component="h2" size="md" fw={700} lh={1.2}>
                {mode === 'single' ? 'Configure one agent' : 'Configure several agents'}
              </Text>
            </div>
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
                      clearable
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
                      clearable
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
                  <Text size="xs" c="dimmed">
                    {mode === 'single' ? 'Fill in one agent fast.' : 'Build a lineup of agents fast.'}
                  </Text>
                </div>
                {mode === 'single' ? (
                  <>
                    <button className={presetClass('flagship')} aria-pressed={activePreset === 'flagship'} type="button" onClick={selectFlagshipPreset}>
                      <span className="agent-preset-icon"><Crown size={16} /></span>
                      <span className="agent-preset-copy">
                        <span className="agent-preset-title">Best {provider?.label || 'provider'} model available</span>
                        <span className="agent-preset-description">The strongest {provider?.label || 'provider'} model at its highest effort.</span>
                      </span>
                    </button>
                    <button className={presetClass('auto')} aria-pressed={activePreset === 'auto'} type="button" onClick={selectAutoPreset}>
                      <span className="agent-preset-icon"><Sparkles size={16} /></span>
                      <span className="agent-preset-copy">
                        <span className="agent-preset-title">Auto</span>
                        <span className="agent-preset-description">Let Netlify pick the model and effort.</span>
                      </span>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className={presetClass('all-efforts')}
                      aria-pressed={activePreset === 'all-efforts'}
                      type="button"
                      onClick={selectAllEffortsForModel}
                    >
                      <span className="agent-preset-icon"><Gauge size={16} /></span>
                      <span className="agent-preset-copy">
                        <span className="agent-preset-title">Every effort level</span>
                        <span className="agent-preset-description">Run one model at each supported effort.</span>
                      </span>
                    </button>
                    <button className={presetClass('all-models')} aria-pressed={activePreset === 'all-models'} type="button" onClick={selectAllProviderModels}>
                      <span className="agent-preset-icon"><Layers3 size={16} /></span>
                      <span className="agent-preset-copy">
                        <span className="agent-preset-title">Every {provider?.label || 'provider'} model</span>
                        <span className="agent-preset-description">One agent instance per available model.</span>
                      </span>
                    </button>
                  </>
                )}
              </Stack>
            </div>
            <Text size="xs" c={overLimit ? 'red' : 'dimmed'}>
              {overLimit
                ? `Choose at most ${maxInstances} agent${maxInstances === 1 ? '' : 's'} for the remaining capacity.`
                : noNewConfigurations
                  ? 'That exact provider, model, and effort configuration is already selected.'
                  : duplicateCount > 0
                    ? `Adds ${combinationCount} new agent${combinationCount === 1 ? '' : 's'}; skips ${duplicateCount} already selected.`
                    : models.length === 0
                      ? 'Adds 1 Auto agent.'
                      : `Adds ${combinationCount} agent${combinationCount === 1 ? '' : 's'}.`}
            </Text>
            <Group justify="flex-end">
              <Button size="xs" variant="subtle" color="gray" onClick={() => setOpened(false)}>Cancel</Button>
              <Button size="xs" disabled={overLimit || noNewConfigurations} onClick={add}>Add</Button>
            </Group>
          </Stack>
        )}
      </Popover.Dropdown>
    </Popover>
  )
}
