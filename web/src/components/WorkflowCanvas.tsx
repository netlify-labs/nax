import { useEffect, useMemo } from 'react'
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
}

function FlowBody({ graph, loading, onSelectNode }: Props) {
  const { fitView } = useReactFlow()
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
    window.requestAnimationFrame(() => {
      fitView({ padding: 0.08, duration: 180 })
    })
  }, [fitView, graph])

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
      fitView
      fitViewOptions={{ padding: 0.08 }}
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
            : node.data.agents,
          onToggleAgent: props.onToggleStepAgent,
        },
      })),
    }
  }, [props.graph, props.onToggleStepAgent, props.stepModels])

  return (
    <Box component="section" className="canvas-shell" aria-label="Workflow graph">
      <FlowBody {...props} graph={nodesGraph} />
    </Box>
  )
}
