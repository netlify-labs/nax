import { memo, useEffect, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Button, Group, Popover, Stack, Text } from '@mantine/core'
import { Check, ChevronDown, CircleAlert, LoaderCircle, LockKeyhole, RotateCcw, Trash2, UserCheck, X } from 'lucide-react'

import { MAX_STEP_AGENT_INSTANCES, instanceDisplayName } from '../agent-instances'
import { agentLabel, statusLabel } from '../run-format'
import { isActiveStatus, isCancelledStatus, isCompletedStatus, isFailedStatus, statusKey } from '../status-model'
import type { AgentInstanceConfiguration, AgentInstanceDescriptor, WorkflowGraphNodeData } from '../types'
import { useAgentCatalog } from '../agent-catalog-context'
import { AddAgentInstances } from './AddAgentInstances'
import { AgentIcon } from './AgentIcon'
import { AgentProviderSelect } from './AgentProviderSelect'
import { ModelEffortFields, defaultAgentConfig, describeAgentConfig } from './ModelEffortFields'

function hasCompletedRun(node: WorkflowGraphNodeData, instance: AgentInstanceDescriptor): boolean {
  return node.runs.some((run) => {
    const runInstanceId = String(run.instanceId || '')
    const matches = runInstanceId
      ? runInstanceId === instance.id
      : String(run.agent || '') === instance.agent && !instance.model && !instance.effort
    return matches && isCompletedStatus(String(run.status || ''))
  })
}

function instanceStatusTitle(
  node: WorkflowGraphNodeData,
  instance: AgentInstanceDescriptor,
  status: string,
  hasResult: boolean,
): string {
  const label = `${agentLabel(instance.agent)} ${instanceDisplayName(instance)}`
  if (isActiveStatus(status) && node.agentInteraction !== 'view-result') return `${label} is in progress`
  if (isCompletedStatus(status) && node.agentInteraction !== 'view-result') return `${label} completed`
  if (node.agentInteraction !== 'view-result') return `Configure ${label} for ${node.title}`
  if (hasResult) return `View ${label} result for ${node.title}`
  if (isActiveStatus(status)) return `${label} is in progress; view available run details`
  if (status === 'abandoned') return `${label} was abandoned after cancellation; view available run details`
  if (['failed', 'cancelled'].includes(status)) return `${label} ${statusLabel(status).toLowerCase()}; view available run details`
  return `View ${label} details for ${node.title}`
}

function instanceIsDone(node: WorkflowGraphNodeData, instance: AgentInstanceDescriptor): boolean {
  return isCompletedStatus(node.agentStatuses?.[instance.id] || '') || hasCompletedRun(node, instance)
}

function countStateLabel(count: number, state: string, total?: number): string {
  if (state === 'completed' && total !== undefined && count === total) return 'completed'
  return `${count} ${state}`
}

function nodeProgressLabel(node: WorkflowGraphNodeData, instances: AgentInstanceDescriptor[]): string {
  if (node.status === 'booting') return 'Booting up'
  if (instances.length === 0) return ''
  const completedCount = instances.filter((instance) => instanceIsDone(node, instance)).length
  if (isActiveStatus(node.status || '')) {
    const runningCount = instances.length - completedCount
    return [
      completedCount > 0 ? countStateLabel(completedCount, 'completed', instances.length) : '',
      runningCount > 0 ? countStateLabel(runningCount, 'running') : '',
    ].filter(Boolean).join(', ')
  }
  if (isCompletedStatus(node.status || '')) return countStateLabel(completedCount, 'completed', instances.length)
  return ''
}

export const WorkflowNode = memo(function WorkflowNode({ data, selected }: NodeProps) {
  const node = data as WorkflowGraphNodeData
  const catalogContext = useAgentCatalog()
  const [configInstanceId, setConfigInstanceId] = useState<string | null>(null)
  const [draftConfig, setDraftConfig] = useState<AgentInstanceConfiguration>({ agent: '', model: 'auto', effort: 'auto' })
  const [actingInstanceId, setActingInstanceId] = useState<string | null>(null)

  useEffect(() => {
    if (!configInstanceId) return undefined
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (target?.closest('.agent-config-popover') || target?.closest('.agent-chip-caret')) return
      setConfigInstanceId(null)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer, true)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true)
  }, [configInstanceId])

  const selectedInstances = node.selectedAgents || node.instances
  const statusClass = node.status ? ` status-${node.status}` : ''
  const humanReview = node.action === 'human-review' || node.submit === 'human-review'
  const inherited = Boolean(node.inheritedFromStepId)
  const progressLabel = humanReview ? '' : nodeProgressLabel(node, selectedInstances)
  const isDefinition = !node.status || node.status === 'definition'
  const configurable = node.agentInteraction !== 'view-result' && !inherited
  const canAddAgents = configurable && isDefinition
  const githubTransport = catalogContext?.transport === 'github' || catalogContext?.transport === 'github-actions'
  const canConfigure = configurable && Boolean(catalogContext) && Boolean(node.onConfigureAgent)
  const atMaxInstances = selectedInstances.length >= MAX_STEP_AGENT_INSTANCES
  const addAgentControl = canAddAgents && catalogContext ? (
    <AddAgentInstances
      catalog={catalogContext.catalog}
      disabled={atMaxInstances}
      existingInstances={selectedInstances}
      maxInstances={Math.max(0, MAX_STEP_AGENT_INSTANCES - selectedInstances.length)}
      onAdd={(instances) => node.onAddInstances?.(node.stepId, instances)}
    />
  ) : null
  const removeAgentsControl = canAddAgents && selectedInstances.length > 0 && node.onRemoveAllAgents ? (
    <Button
      className="remove-agents-button"
      size="compact-xs"
      variant="subtle"
      color="red"
      leftSection={<Trash2 size={13} />}
      onClick={(event) => {
        event.stopPropagation()
        node.onRemoveAllAgents?.(node.stepId)
      }}
    >
      Remove agents
    </Button>
  ) : null
  const addAgentSlot = addAgentControl || removeAgentsControl ? (
    <div className="add-agent-slot">
      {addAgentControl}
      {removeAgentsControl}
    </div>
  ) : null

  return (
    <div className={`workflow-node${statusClass}${selected ? ' selected' : ''}`}>
      <Handle className="hidden-handle workflow-target-handle" type="target" position={Position.Top} />
      <div className="node-header">
        <div className="node-header-top">
          <div className="node-kicker-row">
            <span className="node-kicker">Step {node.number}</span>
            {progressLabel ? <span className="node-progress-label">- {progressLabel}</span> : null}
            {node.status && node.status !== 'pending' ? (
              <span className={`node-state-badge status-${node.status}`}>{statusLabel(node.status)}</span>
            ) : null}
          </div>
          <span className={`node-status-line ${humanReview ? 'human-review' : node.submit === 'follow-up' ? 'follow-up' : 'new-run'}`}>
            <span className="action-badge">{node.submitLabel || node.submit || node.action}</span>
          </span>
        </div>
        <h3>{node.title}</h3>
      </div>
      {node.description ? <p className="node-description">{node.description}</p> : null}
      <div className="agent-row">
        {humanReview ? (
          <span className={`agent-chip human-review-chip agent-${node.status || 'pending'}`}>
            <UserCheck size={14} />
            <span>{node.status === 'awaiting_review' ? 'Awaiting review' : 'Human review'}</span>
          </span>
        ) : selectedInstances.map((instance) => {
          const agentStatus = node.agentStatuses?.[instance.id] || instance.status || ''
          const normalizedAgentStatus = statusKey(agentStatus)
          const active = Boolean(agentStatus) && isActiveStatus(agentStatus)
          const completed = Boolean(agentStatus) && isCompletedStatus(agentStatus)
          const failed = Boolean(agentStatus) && (isFailedStatus(agentStatus) || isCancelledStatus(agentStatus))
          const canRetry = failed && isActiveStatus(node.status || '') && Boolean(node.onRetryAgentRun)
          const canConfigureInstance = canConfigure && !active && !completed && !failed
          const controlStatusClass = agentStatus ? ` agent-${normalizedAgentStatus}` : ''
          const busy = actingInstanceId === instance.id
          const hasResult = hasCompletedRun(node, instance)
          const canOpenAgentDetails = node.agentInteraction === 'view-result' && Boolean(node.onViewAgentResult)
          const model = instance.model || 'auto'
          const effort = instance.effort || 'auto'
          const config = catalogContext
            ? describeAgentConfig(catalogContext.catalog, instance.agent, model, effort)
            : { modelLabel: instanceDisplayName(instance), effortLabel: instance.effort || '' }
          return (
            <div
              className={`agent-chip-wrap${canOpenAgentDetails || canConfigureInstance || (active && Boolean(node.onCancelAgentRun)) || canRetry ? '' : ' agent-chip-wrap-static'}`}
              key={instance.id}
            >
              <button
                className={`agent-chip ${instance.agent}${agentStatus ? ` agent-${normalizedAgentStatus}` : ''}`}
                type="button"
                title={instanceStatusTitle(node, instance, agentStatus, hasResult)}
                disabled={!canOpenAgentDetails}
                onClick={(event) => {
                  event.stopPropagation()
                  if (canOpenAgentDetails) node.onViewAgentResult?.(node, instance.id)
                }}
              >
                <AgentIcon agent={instance.agent} />
                <span className="agent-chip-label">
                  <span className="agent-chip-name">{agentLabel(instance.agent)}</span>
                  <span className="agent-chip-config">{config.modelLabel || 'Auto'}</span>
                  {config.effortLabel ? <span className="agent-chip-effort">{config.effortLabel}</span> : null}
                </span>
              </button>
              {canConfigureInstance ? (
                <Popover
                  opened={configInstanceId === instance.id}
                  onChange={(opened) => setConfigInstanceId(opened ? instance.id : null)}
                  position="bottom-end"
                  width={320}
                  withArrow
                  shadow="md"
                  trapFocus
                  closeOnClickOutside
                  closeOnEscape
                >
                  <Popover.Target>
                    <button
                      type="button"
                      className={`agent-chip-control agent-chip-caret nodrag nopan${controlStatusClass}`}
                      aria-label={`Configure ${agentLabel(instance.agent)} ${instanceDisplayName(instance)} for ${node.title}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        setDraftConfig({ agent: instance.agent, model, effort })
                        setConfigInstanceId((current) => current === instance.id ? null : instance.id)
                      }}
                    >
                      <ChevronDown size={13} />
                    </button>
                  </Popover.Target>
                  <Popover.Dropdown className="agent-config-popover" onClick={(event) => event.stopPropagation()}>
                    <Button
                      className="agent-config-remove"
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      leftSection={<Trash2 size={12} />}
                      aria-label={`Remove ${agentLabel(instance.agent)} ${instanceDisplayName(instance)} from ${node.title}`}
                      onClick={() => {
                        node.onRemoveAgent?.(node.stepId, instance.id)
                        setConfigInstanceId(null)
                      }}
                    >
                      Remove agent
                    </Button>
                    <Stack gap="sm">
                      <AgentProviderSelect
                        catalog={catalogContext!.catalog}
                        agent={draftConfig.agent || instance.agent}
                        withinPortal={false}
                        onChange={(agent) => {
                          const defaults = githubTransport
                            ? { model: 'auto', effort: 'auto' }
                            : defaultAgentConfig(catalogContext!.catalog, agent)
                          setDraftConfig({ agent, ...defaults })
                        }}
                      />
                      {githubTransport ? (
                        <Text size="xs" c="dimmed">
                          Model and effort require the Netlify API transport.
                        </Text>
                      ) : null}
                      <ModelEffortFields
                        catalog={catalogContext!.catalog}
                        agent={draftConfig.agent || instance.agent}
                        model={configInstanceId === instance.id ? draftConfig.model : model}
                        effort={configInstanceId === instance.id ? draftConfig.effort : effort}
                        disabled={githubTransport}
                        withinPortal={false}
                        onChange={(next) => setDraftConfig((current) => ({ ...current, ...next }))}
                      />
                      <Group justify="flex-end" gap="xs">
                        <Button size="xs" variant="subtle" color="gray" onClick={() => setConfigInstanceId(null)}>Cancel</Button>
                        <Button
                          size="xs"
                          disabled={githubTransport && draftConfig.agent === instance.agent}
                          onClick={() => {
                            node.onConfigureAgent?.(node.stepId, instance.id, draftConfig)
                            setConfigInstanceId(null)
                          }}
                        >
                          Save
                        </Button>
                      </Group>
                    </Stack>
                  </Popover.Dropdown>
                </Popover>
              ) : active && node.onCancelAgentRun ? (
                <button
                  type="button"
                  className={`agent-chip-control agent-chip-action nodrag nopan${controlStatusClass}`}
                  aria-label={`Cancel ${agentLabel(instance.agent)} ${instanceDisplayName(instance)} for ${node.title}`}
                  title={`Cancel this ${agentLabel(instance.agent)} runner`}
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation()
                    setActingInstanceId(instance.id)
                    void Promise.resolve(node.onCancelAgentRun?.(node, instance.id)).finally(() => setActingInstanceId(null))
                  }}
                >
                  <X size={13} />
                </button>
              ) : active ? (
                <span
                  className={`agent-chip-control agent-chip-activity${controlStatusClass}`}
                  title={`${agentLabel(instance.agent)} is in progress`}
                  aria-hidden="true"
                >
                  <LoaderCircle className="spin" size={13} />
                </span>
              ) : completed ? (
                <span
                  className={`agent-chip-control agent-chip-terminal${controlStatusClass}`}
                  title={`${agentLabel(instance.agent)} completed`}
                  aria-hidden="true"
                >
                  <Check size={13} />
                </span>
              ) : failed ? (
                canRetry ? (
                  <button
                    type="button"
                    className={`agent-chip-control agent-chip-action nodrag nopan${controlStatusClass}`}
                    aria-label={`Retry ${agentLabel(instance.agent)} ${instanceDisplayName(instance)} for ${node.title}`}
                    title={`Retry this ${agentLabel(instance.agent)} runner`}
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation()
                      setActingInstanceId(instance.id)
                      void Promise.resolve(node.onRetryAgentRun?.(node, instance.id)).finally(() => setActingInstanceId(null))
                    }}
                  >
                    <RotateCcw size={12} />
                  </button>
                ) : (
                  <span
                    className={`agent-chip-control agent-chip-terminal${controlStatusClass}`}
                    title={`${agentLabel(instance.agent)} ${statusLabel(agentStatus).toLowerCase()}`}
                    aria-hidden="true"
                  >
                    <CircleAlert size={12} />
                  </span>
                )
              ) : null}
            </div>
          )
        })}
      </div>
      {!humanReview ? (
        <div className="node-footer">
          {addAgentSlot}
          {isDefinition && inherited && node.agentInteraction !== 'view-result' ? (
            <Text className="inherited-lineup-note" size="xs" c="dimmed">
              <LockKeyhole size={12} /> Inherits surviving instances from {node.inheritedFromStepId}
            </Text>
          ) : null}
        </div>
      ) : null}
      <Handle className="hidden-handle workflow-source-handle" type="source" position={Position.Bottom} />
    </div>
  )
})
