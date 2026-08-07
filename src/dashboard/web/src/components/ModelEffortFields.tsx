// Shared model + reasoning-effort selectors for agent configuration.
// Used by the workflow-launch drawer and the per-step chip popover so both apply identical Auto/unknown/xhigh rules.
import { Select, Stack } from '@mantine/core'
import { useMemo } from 'react'

import type { DashboardCapabilities } from '../types'

export type AgentCatalog = DashboardCapabilities['agentConfiguration']['catalog']

export function providerFor(catalog: AgentCatalog, agent: string) {
  return catalog.providers.find((provider) => provider.id === agent)
}

/** Resolve a stored effort (id or wire value) back to the catalog effort id, defaulting to 'auto'. */
export function displayEffort(model: string, effort: string, catalog: AgentCatalog): string {
  const definition = catalog.providers
    .flatMap((provider) => provider.models)
    .find((candidate) => candidate.id === model)
  const option = definition?.efforts.find((candidate) => candidate.id === effort || candidate.wireValue === effort)
  return option?.id || effort || 'auto'
}

/** Human labels for a chip subtitle. Auto model returns empty labels; unknown ids fall back to the raw value. */
export function describeAgentConfig(
  catalog: AgentCatalog,
  agent: string,
  model: string,
  effort: string,
): { modelLabel: string; effortLabel: string } {
  const resolvedModel = model || 'auto'
  if (resolvedModel === 'auto') return { modelLabel: '', effortLabel: '' }
  const provider = providerFor(catalog, agent)
  const modelDefinition = provider?.models.find((candidate) => candidate.id === resolvedModel)
  const modelLabel = modelDefinition?.label || resolvedModel
  const resolvedEffort = displayEffort(resolvedModel, effort || 'auto', catalog)
  if (resolvedEffort === 'auto') return { modelLabel, effortLabel: '' }
  const effortOption = modelDefinition?.efforts.find((candidate) => candidate.id === resolvedEffort)
  return { modelLabel, effortLabel: effortOption?.label || resolvedEffort }
}

type ModelEffortFieldsProps = {
  catalog: AgentCatalog
  agent: string
  model: string
  effort: string
  disabled?: boolean
  withinPortal?: boolean
  onChange: (next: { model: string; effort: string }) => void
}

export function ModelEffortFields({ catalog, agent, model, effort, disabled, withinPortal = true, onChange }: ModelEffortFieldsProps) {
  const provider = providerFor(catalog, agent)
  const selectedModel = model || 'auto'
  const selectedEffort = displayEffort(selectedModel, effort || 'auto', catalog)

  const modelOptions = useMemo(() => {
    const options = [
      { value: 'auto', label: 'Auto' },
      ...(provider?.models || []).map((candidate) => ({ value: candidate.id, label: candidate.label })),
    ]
    if (selectedModel !== 'auto' && !options.some((option) => option.value === selectedModel)) {
      options.push({ value: selectedModel, label: selectedModel })
    }
    return options
  }, [provider, selectedModel])

  const modelDefinition = provider?.models.find((candidate) => candidate.id === selectedModel)
  const effortOptions = [
    { value: 'auto', label: 'Auto' },
    ...(modelDefinition?.efforts || []).map((candidate) => ({ value: candidate.id, label: candidate.label })),
  ]
  if (selectedEffort !== 'auto' && !effortOptions.some((option) => option.value === selectedEffort)) {
    effortOptions.push({ value: selectedEffort, label: selectedEffort })
  }
  const effortDisabled = disabled || selectedModel === 'auto' || Boolean(modelDefinition && modelDefinition.efforts.length === 0)

  return (
    <Stack gap="sm" aria-label={`${agent} settings`}>
      <Select
        label="Model"
        description="Auto lets Agent Runner choose and sends no model field."
        size="xs"
        data={modelOptions}
        value={selectedModel}
        disabled={disabled}
        allowDeselect={false}
        comboboxProps={{ withinPortal }}
        onChange={(value) => onChange({ model: value || 'auto', effort: 'auto' })}
      />
      <Select
        label="Reasoning effort"
        size="xs"
        description={
          selectedModel === 'auto'
            ? 'Choose a model to configure effort.'
            : modelDefinition && modelDefinition.efforts.length === 0
              ? 'This model does not expose configurable reasoning effort.'
              : 'Max is translated to the backend wire value when required.'
        }
        data={effortOptions}
        value={selectedEffort}
        disabled={effortDisabled}
        allowDeselect={false}
        comboboxProps={{ withinPortal }}
        onChange={(value) => onChange({ model: selectedModel, effort: value || 'auto' })}
      />
    </Stack>
  )
}
