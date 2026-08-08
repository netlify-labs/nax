import { Box, Group, Select, Text } from '@mantine/core'
import { Check } from 'lucide-react'

import { AgentIcon } from './AgentIcon'
import type { AgentCatalog } from './ModelEffortFields'

type Props = {
  catalog: AgentCatalog
  agent: string
  disabled?: boolean
  withinPortal?: boolean
  onChange: (agent: string) => void
}

export function AgentProviderSelect({ catalog, agent, disabled, withinPortal = true, onChange }: Props) {
  return (
    <Select
      label="Provider"
      size="xs"
      data={catalog.providers.map((candidate) => ({ value: candidate.id, label: candidate.label }))}
      value={agent}
      disabled={disabled}
      leftSection={agent ? (
        <Box className="agent-provider-select-logo">
          <AgentIcon agent={agent} />
        </Box>
      ) : null}
      leftSectionWidth={36}
      allowDeselect={false}
      comboboxProps={{ withinPortal }}
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
        if (value) onChange(value)
      }}
    />
  )
}
