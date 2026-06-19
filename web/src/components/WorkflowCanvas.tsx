import { useEffect, useMemo, useRef } from 'react'
import { Box, Text } from '@mantine/core'
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { WorkflowGraph, WorkflowGraphNodeData } from '../types'
import { WorkflowNode } from './WorkflowNode'

const nodeTypes = {
  workflowStep: WorkflowNode,
}

type Props = {
  graph: WorkflowGraph | null
  loading: boolean
  stepModels: Record<string, string[]>
  onToggleStepAgent: (stepId: string, agent: string, allAgents: string[]) => void
  onSelectNode: (node: WorkflowGraphNodeData | null) => void
  onViewPrompt: (node: WorkflowGraphNodeData) => void
}

type FlowBodyProps = Props & {
  fitViewKey: string
}

function FlowBody({ graph, loading, onSelectNode, fitViewKey }: FlowBodyProps) {
  const { fitView } = useReactFlow()
  const lastFitViewKey = useRef('')
  const nodes = useMemo(() => (graph?.nodes || []) as Node[], [graph])
  const edges = useMemo(() => (graph?.edges || []).map(({ label: _label, ...edge }) => ({
    ...edge,
    animated: true,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: 'var(--workflow-edge-color)',
    },
  })) as Edge[], [graph])

  useEffect(() => {
    if (!graph) return
    if (lastFitViewKey.current === fitViewKey) return
    lastFitViewKey.current = fitViewKey
    window.requestAnimationFrame(() => {
      fitView({ padding: 0.08, duration: 180 })
    })
  }, [fitView, fitViewKey, graph])

  const handleNodeClick: NodeMouseHandler = (_event, node) => {
    onSelectNode(node.data as WorkflowGraphNodeData)
  }

  if (loading && !graph) {
    return <Text className="canvas-empty" size="sm" c="dimmed">Loading graph</Text>
  }

  if (!graph) {
    return <Text className="canvas-empty" size="sm" c="dimmed">No workflow</Text>
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      onNodeClick={handleNodeClick}
      onPaneClick={() => onSelectNode(null)}
      defaultEdgeOptions={{
        type: 'smoothstep',
        animated: true,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: 'var(--workflow-edge-color)',
        },
      }}
    >
      <Background color="#d6dde6" gap={18} />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}

export function WorkflowCanvas(props: Props) {
  const fitViewKey = useMemo(() => {
    if (!props.graph) return ''
    const nodeKey = props.graph.nodes
      .map((node) => `${node.id}:${node.position.x},${node.position.y}`)
      .join('|')
    const edgeKey = props.graph.edges
      .map((edge) => `${edge.id}:${edge.source}->${edge.target}`)
      .join('|')
    return `${props.graph.metadata.flowId}:${nodeKey}:${edgeKey}`
  }, [props.graph])

  const nodesGraph = useMemo(() => {
    if (!props.graph) return null
    return {
      ...props.graph,
      nodes: props.graph.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          selectedAgents: Object.prototype.hasOwnProperty.call(props.stepModels, node.data.stepId)
            ? props.stepModels[node.data.stepId]
            : node.data.selectedAgents || node.data.agents,
          onToggleAgent: props.onToggleStepAgent,
          onViewPrompt: props.onViewPrompt,
        },
      })),
    }
  }, [props.graph, props.onToggleStepAgent, props.onViewPrompt, props.stepModels])

  return (
    <Box component="section" className="canvas-shell" aria-label="Workflow graph">
      <FlowBody {...props} graph={nodesGraph} fitViewKey={fitViewKey} />
    </Box>
  )
}
