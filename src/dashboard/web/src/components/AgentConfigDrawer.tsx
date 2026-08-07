import { Alert, Button, Drawer, Group, Stack, Tabs, Text } from '@mantine/core'
import { useEffect, useState } from 'react'

import { agentLabel } from '../run-format'
import { AgentIcon } from './AgentIcon'
import { ModelEffortFields, type AgentCatalog } from './ModelEffortFields'

type Catalog = AgentCatalog

type AgentConfigDrawerProps = {
  opened: boolean
  onClose: () => void
  agents: string[]
  catalog: Catalog
  models: Record<string, string>
  efforts: Record<string, string>
  transport: string
  title?: string
  onChange: (configuration: {
    models: Record<string, string>
    efforts: Record<string, string>
  }) => void
}

export function AgentConfigDrawer({
  opened,
  onClose,
  agents,
  catalog,
  models,
  efforts,
  transport,
  title = 'Agent configuration',
  onChange,
}: AgentConfigDrawerProps) {
  const [activeAgent, setActiveAgent] = useState(agents[0] || '')
  const [draftModels, setDraftModels] = useState(models)
  const [draftEfforts, setDraftEfforts] = useState(efforts)

  useEffect(() => {
    if (!opened) return
    setDraftModels(models)
    setDraftEfforts(efforts)
    setActiveAgent((current) => agents.includes(current) ? current : agents[0] || '')
  }, [agents, efforts, models, opened])

  const githubUnsupported = transport === 'github' || transport === 'github-actions'
  const hasPinnedConfiguration = Object.values(draftModels).some((value) => value && value !== 'auto') ||
    Object.values(draftEfforts).some((value) => value && value !== 'auto')

  const save = () => {
    onChange({ models: draftModels, efforts: draftEfforts })
    onClose()
  }

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="md"
      title={title}
      aria-label={title}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Choose the model and reasoning effort each agent runs with. Auto omits both settings.
        </Text>
        {githubUnsupported ? (
          <Alert color="yellow" title="Netlify API required">
            Provider-specific model and effort settings require the Netlify API transport.
            GitHub Actions currently supports provider selection only.
          </Alert>
        ) : null}
        {transport === 'auto' && hasPinnedConfiguration ? (
          <Alert color="blue" title="Netlify API selected">
            Auto transport resolves to the Netlify API whenever a model or effort is pinned.
          </Alert>
        ) : null}
        {agents.length === 0 ? (
          <Alert color="gray">Select at least one agent provider before configuring it.</Alert>
        ) : (
          <Tabs value={activeAgent} onChange={(value) => setActiveAgent(value || agents[0] || '')}>
            <Tabs.List aria-label="Agent providers">
              {agents.map((agent) => (
                <Tabs.Tab key={agent} value={agent} leftSection={<AgentIcon agent={agent} />}>
                  {agentLabel(agent)}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            {agents.map((agent) => (
              <Tabs.Panel key={agent} value={agent} pt="md">
                <ModelEffortFields
                  catalog={catalog}
                  agent={agent}
                  model={draftModels[agent] || 'auto'}
                  effort={draftEfforts[agent] || 'auto'}
                  disabled={githubUnsupported}
                  onChange={({ model, effort }) => {
                    setDraftModels((current) => ({ ...current, [agent]: model }))
                    setDraftEfforts((current) => ({ ...current, [agent]: effort }))
                  }}
                />
              </Tabs.Panel>
            ))}
          </Tabs>
        )}
        <Group justify="flex-end">
          <Button variant="subtle" color="gray" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={githubUnsupported || agents.length === 0}>Save</Button>
        </Group>
      </Stack>
    </Drawer>
  )
}
