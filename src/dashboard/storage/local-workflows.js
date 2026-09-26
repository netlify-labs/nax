const { listFlowCatalog, loadFlow } = require('../../workflows/catalog/flows')
const { flowToGraph } = require('../shared/graph')
const { publicFlow } = require('../api/serializers')

/**
 * @typedef {{
 *   projectRoot: string,
 *   flowsDir?: string,
 *   flowsDirs?: string[],
 * }} LocalWorkflowStoreOptions
 */

/** @param {LocalWorkflowStoreOptions} options */
function createLocalWorkflowStore(options) {
  const flowOptions = {
    projectRoot: options.projectRoot,
    flowsDir: options.flowsDir,
    flowsDirs: options.flowsDirs,
  }

  return {
    async listWorkflows() {
      const { flows, invalid } = await listFlowCatalog(flowOptions)
      return {
        count: flows.length,
        items: flows.map(publicFlow),
        invalid,
      }
    },
    async getWorkflow(id) {
      let flow
      try {
        flow = await loadFlow(id, flowOptions)
      } catch (_err) {
        return null
      }
      return publicFlow(flow)
    },
    async getWorkflowGraph(id) {
      let flow
      try {
        flow = await loadFlow(id, flowOptions)
      } catch (_err) {
        return null
      }
      return {
        workflow: publicFlow(flow),
        graph: flowToGraph({ flow }),
      }
    },
    async loadWorkflow(id) {
      return loadFlow(id, flowOptions)
    },
  }
}

module.exports = {
  createLocalWorkflowStore,
}
