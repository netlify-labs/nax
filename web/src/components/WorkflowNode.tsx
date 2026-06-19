import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Info } from 'lucide-react'
import type { WorkflowGraphNodeData } from '../types'
import { AgentIcon } from './AgentIcon'

function titleCase(value: string): string {
  return value.replace(/(^|-)([a-z])/g, (_match, prefix, char) => `${prefix}${char.toUpperCase()}`)
}

function hasCompletedRun(node: WorkflowGraphNodeData, agent: string): boolean {
  return node.runs.some((run) => (
    String(run.agent || '') === agent &&
    ['complete', 'completed'].includes(String(run.status || '').toLowerCase())
  ))
}

function agentStatusTitle(node: WorkflowGraphNodeData, agent: string, active: boolean, status: string, hasResult: boolean): string {
  const label = titleCase(agent)
  if (hasResult) return `View ${label} result for ${node.title}`
  if (['running', 'submitted', 'waiting', 'retrying', 'queued'].includes(status)) return `${label} is ${status}; view available run details`
  if (status === 'abandoned') return `${label} was abandoned after cancellation; view available run details`
  if (['failed', 'cancelled'].includes(status)) return `${label} ${status}; view available run details`
  return `${active ? 'Disable' : 'Enable'} ${label} for ${node.title}`
}

export const WorkflowNode = memo(function WorkflowNode({ data, selected }: NodeProps) {
  const node = data as WorkflowGraphNodeData
  const selectedAgents = new Set(node.selectedAgents || node.agents)
  const statusClass = node.status ? ` status-${node.status}` : ''
  return (
    <div className={`workflow-node${statusClass}${selected ? ' selected' : ''}`}>
      <Handle className="hidden-handle" type="target" position={Position.Top} />
      <div className="node-header">
        <div>
          <div className="node-kicker-row">
            <span className="node-kicker">Step {node.number}</span>
            {node.promptMarkdown ? (
              <button
                className="node-info-button"
                type="button"
                aria-label={`View ${node.title} prompt`}
                title="View prompt"
                onClick={(event) => {
                  event.stopPropagation()
                  node.onViewPrompt?.(node)
                }}
              >
                <Info size={13} />
              </button>
            ) : null}
          </div>
          <h3>{node.title}</h3>
        </div>
        <span className={`action-badge ${node.submit === 'follow-up' ? 'follow-up' : 'new-run'}`}>
          {node.submitLabel || node.submit || node.action}
        </span>
      </div>
      {node.description ? <p className="node-description">{node.description}</p> : null}
      <div className="agent-row">
        {node.agents.map((agent) => {
          const active = selectedAgents.has(agent)
          const agentStatus = active ? node.agentStatuses?.[agent] || '' : ''
          const hasResult = hasCompletedRun(node, agent)
          const canViewResult = active && (hasResult || Boolean(agentStatus))
          return (
            <button
              className={`agent-chip ${agent}${active ? '' : ' inactive'}${agentStatus ? ` agent-${agentStatus}` : ''}`}
              key={agent}
              type="button"
              aria-pressed={active}
              title={agentStatusTitle(node, agent, active, agentStatus, hasResult)}
              onClick={(event) => {
                event.stopPropagation()
                if (canViewResult) {
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
      <Handle className="hidden-handle" type="source" position={Position.Bottom} />
    </div>
  )
})
