import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from '@mantine/core'
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { activeOrCompletedStatuses, completedStatuses } from '../run-projection'
import type { WorkflowGraph, WorkflowGraphNodeData } from '../types'
import { WorkflowNode } from './WorkflowNode'

const nodeTypes = {
  workflowStep: WorkflowNode,
}

const WORKFLOW_NODE_MIN_GAP = 44

type Props = {
  graph: WorkflowGraph | null
  loading: boolean
  mode: 'configure' | 'inspect'
  selectedNode: WorkflowGraphNodeData | null
  onToggleStepAgent: (stepId: string, agent: string, allAgents: string[]) => void
  onSelectNode: (node: WorkflowGraphNodeData | null) => void
  onViewNodeDetails: (node: WorkflowGraphNodeData) => void
  onViewAgentResult: (node: WorkflowGraphNodeData, agent: string) => void
}

type FlowBodyProps = Props & {
  fitViewKey: string
}

function graphIndexForNode(node: Node): number {
  const workflowNode = node.data as WorkflowGraphNodeData
  return Number.isFinite(workflowNode.graphIndex) ? workflowNode.graphIndex : 0
}

function measuredHeightForNode(node: Node): number {
  return node.measured?.height || node.height || 0
}

function layoutMeasuredNodes(nodes: Node[], measuredNodesById: Map<string, Node>): Node[] {
  const orderedNodes = [...nodes].sort((a, b) => graphIndexForNode(a) - graphIndexForNode(b))
  const yByNodeId = new Map<string, number>()
  let nextY = 0

  for (const node of orderedNodes) {
    const measuredNode = measuredNodesById.get(node.id) || node
    yByNodeId.set(node.id, nextY)
    nextY += measuredHeightForNode(measuredNode) + WORKFLOW_NODE_MIN_GAP
  }

  let changed = false
  const nextNodes = nodes.map((node) => {
    const y = yByNodeId.get(node.id) ?? node.position.y
    if (Math.abs(y - node.position.y) < 0.5) return node
    changed = true
    return {
      ...node,
      position: {
        ...node.position,
        y,
      },
    }
  })

  return changed ? nextNodes : nodes
}

function FlowBody({ graph, loading, mode, onSelectNode, onViewNodeDetails, fitViewKey }: FlowBodyProps) {
  const { fitView, getNodes } = useReactFlow()
  const nodesInitialized = useNodesInitialized()
  const lastFitViewKey = useRef('')
  const graphNodes = useMemo(() => (graph?.nodes || []) as Node[], [graph])
  const [nodes, setNodes] = useState<Node[]>(graphNodes)
  const layoutFitViewKey = useMemo(() => {
    const nodeKey = nodes
      .map((node) => `${node.id}:${node.position.x},${node.position.y}`)
      .join('|')
    return `${fitViewKey}:${nodeKey}`
  }, [fitViewKey, nodes])
  const edges = useMemo(() => {
    const nodeStatuses = new Map(
      nodes.map((node) => [node.id, (node.data as WorkflowGraphNodeData).status || '']),
    )
    return (graph?.edges || []).map(({ label: _label, ...edge }) => {
      const sourceStatus = nodeStatuses.get(edge.source) || ''
      const targetStatus = nodeStatuses.get(edge.target) || ''
      const doneEdge = completedStatuses.has(sourceStatus) && activeOrCompletedStatuses.has(targetStatus)
      const edgeColor = doneEdge ? 'var(--workflow-edge-done-color)' : 'var(--workflow-edge-color)'
      return {
        ...edge,
        animated: true,
        className: doneEdge ? 'workflow-edge-done' : undefined,
        style: {
          stroke: edgeColor,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: edgeColor,
        },
      }
    }) as Edge[]
  }, [graph, nodes])

  useEffect(() => {
    setNodes((currentNodes) => {
      const currentNodesById = new Map(currentNodes.map((node) => [node.id, node]))
      return graphNodes.map((node) => {
        const currentNode = currentNodesById.get(node.id)
        if (!currentNode) return node
        return {
          ...node,
          position: currentNode.position,
        }
      })
    })
  }, [graphNodes])

  useEffect(() => {
    if (!nodesInitialized || nodes.length === 0) return
    const measuredNodesById = new Map(getNodes().map((node) => [node.id, node]))
    setNodes((currentNodes) => {
      return layoutMeasuredNodes(currentNodes, measuredNodesById)
    })
  }, [getNodes, nodes, nodesInitialized])

  useEffect(() => {
    if (!graph) return
    if (lastFitViewKey.current === layoutFitViewKey) return
    lastFitViewKey.current = layoutFitViewKey
    window.requestAnimationFrame(() => {
      fitView({ padding: 0.08, duration: 180 })
    })
  }, [fitView, graph, layoutFitViewKey])

  const handleNodeClick: NodeMouseHandler = (_event, node) => {
    const workflowNode = node.data as WorkflowGraphNodeData
    onSelectNode(workflowNode)
    if (mode === 'inspect') onViewNodeDetails(workflowNode)
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
      nodes: props.graph.nodes.map((node) => {
        return {
          ...node,
          selected: props.selectedNode ? props.selectedNode.stepId === node.data.stepId : false,
          data: {
            ...node.data,
            agentInteraction: props.mode === 'inspect' ? 'view-result' : 'toggle',
            onToggleAgent: props.onToggleStepAgent,
            onViewAgentResult: props.mode === 'inspect' ? props.onViewAgentResult : undefined,
          },
        }
      }),
    }
  }, [props.graph, props.mode, props.selectedNode, props.onToggleStepAgent, props.onViewAgentResult])

  return (
    <Box component="section" className="canvas-shell" aria-label="Workflow graph">
      <FlowBody {...props} graph={nodesGraph} fitViewKey={fitViewKey} />
    </Box>
  )
}
