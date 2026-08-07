import { Alert, Button, Group, Modal, Select, Stack, Text, Textarea } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { Bot, Settings2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { AgentRunRequest, DashboardCapabilities } from '../types'
import { agentLabel } from '../run-format'
import { AgentConfigDrawer } from './AgentConfigDrawer'
import { AgentIcon } from './AgentIcon'

type Catalog = DashboardCapabilities['agentConfiguration']['catalog']

type AgentRunModalProps = {
  opened: boolean
  onClose: () => void
  catalog: Catalog
  branch: string
  transport: string
  loading: boolean
  error: string
  onSubmit: (request: AgentRunRequest) => void
}

export function AgentRunModal({
  opened,
  onClose,
  catalog,
  branch,
  transport,
  loading,
  error,
  onSubmit,
}: AgentRunModalProps) {
  const providers = useMemo(() => catalog.providers.map((provider) => provider.id), [catalog])
  const [agent, setAgent] = useState(providers[0] || 'codex')
  const [prompt, setPrompt] = useState('')
  const [models, setModels] = useState<Record<string, string>>({})
  const [efforts, setEfforts] = useState<Record<string, string>>({})
  const [configOpened, { open: openConfig, close: closeConfig }] = useDisclosure(false)
  const unsupportedTransport = transport === 'github' || transport === 'github-actions'

  useEffect(() => {
    if (!opened) return
    setAgent((current) => providers.includes(current) ? current : providers[0] || 'codex')
  }, [opened, providers])

  const close = () => {
    if (loading) return
    onClose()
  }
  const submit = () => {
    if (!prompt.trim() || unsupportedTransport) return
    onSubmit({
      prompt: prompt.trim(),
      agent,
      models,
      efforts,
      branch,
      transport,
    })
  }

  return (
    <>
      <Modal
        opened={opened}
        onClose={close}
        title="Run one agent"
        size="lg"
        centered
        closeOnClickOutside={!loading}
        closeOnEscape={!loading}
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Start a standalone Netlify Agent Runner without choosing a workflow.
          </Text>
          {unsupportedTransport ? (
            <Alert color="yellow" title="Netlify API required">
              Standalone agent runs require the Netlify API transport. GitHub Actions supports workflow provider selection only.
            </Alert>
          ) : null}
          {error ? <Alert color="red">{error}</Alert> : null}
          <Select
            label="Agent provider"
            data={catalog.providers.map((provider) => ({
              value: provider.id,
              label: provider.label,
            }))}
            value={agent}
            allowDeselect={false}
            leftSection={<AgentIcon agent={agent} />}
            onChange={(value) => setAgent(value || providers[0] || 'codex')}
          />
          <Textarea
            label="Instructions"
            description="Describe the task for this standalone agent run."
            placeholder="Audit the services directory for security issues."
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            autosize
            minRows={8}
            maxRows={16}
            required
          />
          <Group justify="space-between">
            <Button
              variant="light"
              color="gray"
              leftSection={<Settings2 size={16} />}
              onClick={openConfig}
              disabled={unsupportedTransport}
            >
              Configure {agentLabel(agent)}
            </Button>
            <Group gap="xs">
              <Button variant="subtle" color="gray" onClick={close} disabled={loading}>Cancel</Button>
              <Button
                color="violet"
                leftSection={<Bot size={16} />}
                onClick={submit}
                loading={loading}
                disabled={!prompt.trim() || unsupportedTransport}
              >
                Run agent
              </Button>
            </Group>
          </Group>
          <Text size="xs" c="dimmed">
            This creates remote work and can spend Netlify agent credits.
          </Text>
        </Stack>
      </Modal>
      <AgentConfigDrawer
        opened={configOpened}
        onClose={closeConfig}
        agents={[agent]}
        catalog={catalog}
        models={models}
        efforts={efforts}
        transport={transport}
        title={`${agentLabel(agent)} configuration`}
        onChange={(configuration) => {
          setModels(configuration.models)
          setEfforts(configuration.efforts)
        }}
      />
    </>
  )
}
