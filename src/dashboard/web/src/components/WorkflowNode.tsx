// Workflow step card: renders provider chips, ghost chips for undeclared providers, and per-step model/effort config.
// Each active chip exposes a caret popover to pin a model and reasoning effort for that step.
import { memo, useEffect, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Popover, Text } from '@mantine/core'
import { ChevronDown, UserCheck } from 'lucide-react'
import { agentLabel, statusLabel } from '../run-format'
import { isActiveStatus, isCompletedStatus } from '../status-model'
import type { WorkflowGraphNodeData } from '../types'
import { useAgentCatalog } from '../agent-catalog-context'
import { AgentIcon } from './AgentIcon'
import { ModelEffortFields, describeAgentConfig } from './ModelEffortFields'

function hasCompletedRun(node: WorkflowGraphNodeData, agent: string): boolean {
  return node.runs.some((run) => (
    String(run.agent || '') === agent && isCompletedStatus(String(run.status || ''))
  ))
}

function agentStatusTitle(node: WorkflowGraphNodeData, agent: string, active: boolean, status: string, hasResult: boolean): string {
  const label = agentLabel(agent)
  if (node.agentInteraction !== 'view-result') return `${active ? 'Disable' : 'Enable'} ${label} for ${node.title}`
  if (hasResult) return `View ${label} result for ${node.title}`
  if (isActiveStatus(status)) return `${label} is in progress; view available run details`
  if (status === 'abandoned') return `${label} was abandoned after cancellation; view available run details`
  if (['failed', 'cancelled'].includes(status)) return `${label} ${statusLabel(status).toLowerCase()}; view available run details`
  return `View ${label} details for ${node.title}`
}

function agentIsDone(node: WorkflowGraphNodeData, agent: string): boolean {
  return isCompletedStatus(node.agentStatuses?.[agent] || '') || hasCompletedRun(node, agent)
}

function countStateLabel(count: number, state: string, total?: number): string {
  if (state === 'completed' && total !== undefined && count === total) return 'completed'
  return `${count} ${state}`
}

function nodeProgressLabel(node: WorkflowGraphNodeData, selectedAgents: Set<string>): string {
  if (node.status === 'booting') return 'Booting up'
  const activeAgents = node.agents.filter((agent) => selectedAgents.has(agent))
  if (activeAgents.length === 0) return ''
  const completedCount = activeAgents.filter((agent) => agentIsDone(node, agent)).length
  if (isActiveStatus(node.status || '')) {
    const runningCount = activeAgents.length - completedCount
    return [
      completedCount > 0 ? countStateLabel(completedCount, 'completed', activeAgents.length) : '',
      runningCount > 0 ? countStateLabel(runningCount, 'running') : '',
    ].filter(Boolean).join(', ')
  }
  if (isCompletedStatus(node.status || '')) return countStateLabel(completedCount, 'completed', activeAgents.length)
  return ''
}

export const WorkflowNode = memo(function WorkflowNode({ data, selected }: NodeProps) {
  const node = data as WorkflowGraphNodeData
  const catalogContext = useAgentCatalog()
  const [configAgent, setConfigAgent] = useState<string | null>(null)

  // React Flow stops propagation on pane pointer events, which defeats Mantine's outside-click
  // close. A capture-phase listener fires first, so clicking anywhere but the popover closes it.
  useEffect(() => {
    if (!configAgent) return undefined
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (target?.closest('.agent-config-popover') || target?.closest('.agent-chip-caret')) return
      setConfigAgent(null)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer, true)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true)
  }, [configAgent])
  const selectedAgents = new Set(node.selectedAgents || node.agents)
  const statusClass = node.status ? ` status-${node.status}` : ''
  const humanReview = node.action === 'human-review' || node.submit === 'human-review'
  const progressLabel = humanReview ? '' : nodeProgressLabel(node, selectedAgents)

  const configurable = node.agentInteraction !== 'view-result'
  const declaredAgents = node.agents
  const extraProviders = configurable
    ? (catalogContext?.supportedProviders || []).filter((provider) => !declaredAgents.includes(provider))
    : []
  const renderOrder = [...declaredAgents, ...extraProviders]
  const githubTransport = catalogContext?.transport === 'github' || catalogContext?.transport === 'github-actions'
  const canConfigure = configurable && Boolean(catalogContext) && Boolean(node.onConfigureAgent)

  return (
    <div className={`workflow-node${statusClass}${selected ? ' selected' : ''}`}>
      <Handle className="hidden-handle workflow-target-handle" type="target" position={Position.Top} />
      <div className="node-header">
        <div className="node-header-top">
          <div className="node-kicker-row">
            <span className="node-kicker">Step {node.number}</span>
            {progressLabel ? <span className="node-progress-label">- {progressLabel}</span> : null}
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
        ) : renderOrder.map((agent) => {
          const active = selectedAgents.has(agent)
          const isExtra = !declaredAgents.includes(agent)
          const isGhost = isExtra && !active
          const agentStatus = active ? node.agentStatuses?.[agent] || '' : ''
          const hasResult = hasCompletedRun(node, agent)
          const model = node.models?.[agent] || 'auto'
          const effort = node.efforts?.[agent] || 'auto'
          const config = catalogContext ? describeAgentConfig(catalogContext.catalog, agent, model, effort) : { modelLabel: '', effortLabel: '' }
          const showCaret = canConfigure && active
          return (
            <div className="agent-chip-wrap" key={agent}>
              <button
                className={`agent-chip ${agent}${active ? '' : ' inactive'}${isGhost ? ' ghost' : ''}${agentStatus ? ` agent-${agentStatus}` : ''}`}
                type="button"
                aria-pressed={active}
                title={isGhost ? `Add ${agentLabel(agent)} to ${node.title}` : agentStatusTitle(node, agent, active, agentStatus, hasResult)}
                onClick={(event) => {
                  event.stopPropagation()
                  if (node.agentInteraction === 'view-result' && node.onViewAgentResult) {
                    node.onViewAgentResult?.(node, agent)
                    return
                  }
                  node.onToggleAgent?.(node.stepId, agent, renderOrder, declaredAgents)
                }}
              >
                <AgentIcon agent={agent} />
                <span className="agent-chip-label">
                  <span className="agent-chip-name">{agentLabel(agent)}</span>
                  {config.modelLabel ? (
                    <span className="agent-chip-config">{config.modelLabel}</span>
                  ) : null}
                  {config.effortLabel ? (
                    <span className="agent-chip-effort">{config.effortLabel}</span>
                  ) : null}
                </span>
              </button>
              {showCaret ? (
                <Popover
                  opened={configAgent === agent}
                  onChange={(opened) => setConfigAgent(opened ? agent : null)}
                  position="bottom-end"
                  width={260}
                  withArrow
                  shadow="md"
                  trapFocus
                  closeOnClickOutside
                  closeOnEscape
                >
                  <Popover.Target>
                    <button
                      type="button"
                      className="agent-chip-caret"
                      aria-label={`Configure ${agentLabel(agent)} for ${node.title}`}
                      title={`Configure ${agentLabel(agent)} model and effort`}
                      onClick={(event) => {
                        event.stopPropagation()
                        setConfigAgent((current) => (current === agent ? null : agent))
                      }}
                    >
                      <ChevronDown size={13} />
                    </button>
                  </Popover.Target>
                  <Popover.Dropdown className="agent-config-popover" onClick={(event) => event.stopPropagation()}>
                    {githubTransport ? (
                      <Text size="xs" c="dimmed">
                        Model and effort require the Netlify API transport. GitHub Actions supports provider selection only.
                      </Text>
                    ) : null}
                    <ModelEffortFields
                      catalog={catalogContext!.catalog}
                      agent={agent}
                      model={model}
                      effort={effort}
                      disabled={githubTransport}
                      withinPortal={false}
                      onChange={({ model: nextModel, effort: nextEffort }) => {
                        node.onConfigureAgent?.(node.stepId, agent, { model: nextModel, effort: nextEffort })
                      }}
                    />
                  </Popover.Dropdown>
                </Popover>
              ) : null}
            </div>
          )
        })}
      </div>
      <Handle className="hidden-handle workflow-source-handle" type="source" position={Position.Bottom} />
    </div>
  )
})
