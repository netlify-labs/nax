// Provides the agent configuration catalog, transport, and supported provider list to canvas nodes.
// Keeps the bulky catalog out of per-node graph data and the WorkflowGraphNodeData contract.
import { createContext, useContext, type ReactNode } from 'react'

import type { AgentCatalog } from './components/ModelEffortFields'

export type AgentCatalogContextValue = {
  catalog: AgentCatalog
  transport: string
  supportedProviders: string[]
}

const AgentCatalogContext = createContext<AgentCatalogContextValue | null>(null)

export function AgentCatalogProvider({
  value,
  children,
}: {
  value: AgentCatalogContextValue
  children: ReactNode
}) {
  return <AgentCatalogContext.Provider value={value}>{children}</AgentCatalogContext.Provider>
}

export function useAgentCatalog(): AgentCatalogContextValue | null {
  return useContext(AgentCatalogContext)
}
