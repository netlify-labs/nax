import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { UserCheck } from 'lucide-react'
import { statusLabel } from '../run-format'
import { isActiveStatus, isCompletedStatus } from '../status-model'
import type { WorkflowGraphNodeData } from '../types'
import { AgentIcon } from './AgentIcon'

function titleCase(value: string): string {
  return value.replace(/(^|-)([a-z])/g, (_match, prefix, char) => `${prefix}${char.toUpperCase()}`)
}

function hasCompletedRun(node: WorkflowGraphNodeData, agent: string): boolean {
  return node.runs.some((run) => (
    String(run.agent || '') === agent && isCompletedStatus(String(run.status || ''))
  ))
}

function agentStatusTitle(node: WorkflowGraphNodeData, agent: string, active: boolean, status: string, hasResult: boolean): string {
  const label = titleCase(agent)
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
  const selectedAgents = new Set(node.selectedAgents || node.agents)
  const statusClass = node.status ? ` status-${node.status}` : ''
  const humanReview = node.action === 'human-review' || node.submit === 'human-review'
  const progressLabel = humanReview ? '' : nodeProgressLabel(node, selectedAgents)
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
        ) : node.agents.map((agent) => {
          const active = selectedAgents.has(agent)
          const agentStatus = active ? node.agentStatuses?.[agent] || '' : ''
          const hasResult = hasCompletedRun(node, agent)
          return (
            <button
              className={`agent-chip ${agent}${active ? '' : ' inactive'}${agentStatus ? ` agent-${agentStatus}` : ''}`}
              key={agent}
              type="button"
              aria-pressed={active}
              title={agentStatusTitle(node, agent, active, agentStatus, hasResult)}
              onClick={(event) => {
                event.stopPropagation()
                if (node.agentInteraction === 'view-result' && node.onViewAgentResult) {
                  node.onViewAgentResult?.(node, agent)
                  return
                }
                node.onToggleAgent?.(node.stepId, agent, node.agents)
              }}
            >
              <AgentIcon agent={agent} />
              <span>{titleCase(agent)}</span>
            </button>
          )
        })}
      </div>
      <Handle className="hidden-handle workflow-source-handle" type="source" position={Position.Bottom} />
    </div>
  )
})
