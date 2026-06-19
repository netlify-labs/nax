import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Info } from 'lucide-react'
import type { WorkflowGraphNodeData } from '../types'

function titleCase(value: string): string {
  return value.replace(/(^|-)([a-z])/g, (_match, prefix, char) => `${prefix}${char.toUpperCase()}`)
}

function AgentIcon({ agent }: { agent: string }) {
  if (agent === 'claude') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="agent-icon">
        <path d="m7.636 15-.35-.266-.196-.434.196-.868.224-1.12.182-.896.168-1.106.098-.364-.014-.028-.07.014-.84 1.148-1.274 1.722-1.008 1.064-.238.098-.42-.21.042-.392.238-.336 1.386-1.778.84-1.106.546-.63-.014-.084h-.028l-3.696 2.408-.658.084-.294-.266.042-.434.14-.14 1.106-.77 2.758-1.54.042-.14-.042-.07h-.14L5.9 8.532 4.332 8.49l-1.358-.056-1.33-.07-.336-.07L1 7.874l.028-.21.28-.182.406.028.882.07 1.33.084.966.056 1.428.154h.224l.028-.098-.07-.056-.056-.056L5.06 6.74l-1.484-.98-.784-.574-.42-.294-.21-.266-.084-.588.378-.42.518.042.126.028.518.406 1.106.854L6.18 6.026l.21.168.098-.056v-.042l-.098-.154-.784-1.428-.84-1.456-.378-.602-.098-.364a1.5 1.5 0 0 1-.056-.42l.434-.588L4.906 1l.588.084.238.21.364.826.574 1.302.91 1.764.266.532.14.476.056.154h.098v-.084l.07-1.008.14-1.218.14-1.568.042-.448.224-.532.434-.28.336.154.28.406-.042.252L9.61 3.1l-.336 1.694-.21 1.148h.126l.14-.154.574-.756.966-1.204.42-.476.504-.532.322-.252h.602l.434.658-.196.686-.616.784-.518.658-.742.994-.448.798.042.056h.098l1.666-.364.91-.154 1.064-.182.49.224.056.224-.196.476-1.148.28-1.344.266-2.002.476-.028.014.028.042.896.084.392.028h.952l1.764.126.462.308.266.364-.042.294-.714.35-.952-.224-2.24-.532-.756-.182h-.112v.056l.644.63 1.162 1.05 1.47 1.358.07.336-.182.28-.196-.028-1.288-.98-.504-.434-1.12-.938h-.07v.098l.252.378 1.372 2.058.07.63-.098.196-.364.126-.378-.07-.812-1.12-.826-1.274-.672-1.134-.07.056-.406 4.228-.182.21z" />
      </svg>
    )
  }
  if (agent === 'gemini') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="agent-icon">
        <path d="M15.5 8.015A7.99 7.99 0 0 0 8.015 15.5h-.03A7.99 7.99 0 0 0 .5 8.015v-.03A7.99 7.99 0 0 0 7.985.5h.03A7.99 7.99 0 0 0 15.5 7.985z" />
      </svg>
    )
  }
  if (agent === 'codex') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="agent-icon">
        <path d="M13.825 8A5.824 5.824 0 1 0 2.177 8a5.824 5.824 0 0 0 11.648 0m-2.876 1.254.119.012a.588.588 0 0 1 0 1.152l-.12.012h-2.21a.588.588 0 0 1 0-1.176zm-5.023.891a.588.588 0 0 1-1.01-.605zM7.03 7.698a.59.59 0 0 1 0 .604l-1.105 1.843-.505-.303-.504-.302L5.84 8l-.923-1.54.504-.302.505-.303zM5.12 5.653a.59.59 0 0 1 .807.202l-1.01.605a.59.59 0 0 1 .203-.807M15 8a7 7 0 1 1-14 0 7 7 0 0 1 14 0" />
      </svg>
    )
  }
  return null
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
          return (
            <button
              className={`agent-chip ${agent}${active ? '' : ' inactive'}`}
              key={agent}
              type="button"
              aria-pressed={active}
              title={`${active ? 'Disable' : 'Enable'} ${titleCase(agent)} for ${node.title}`}
              onClick={(event) => {
                event.stopPropagation()
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
