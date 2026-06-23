const workflowTable = require('../scripts/markdown-magic/workflow-table')

/**
 * Markdown Magic configuration.
 * @type {{
 *   files: string[],
 *   failOnMissingTransforms: boolean,
 *   transforms: {
 *     WORKFLOW_TABLE: typeof workflowTable,
 *   },
 * }}
 */
module.exports = {
  files: ['workflows/README.md'],
  failOnMissingTransforms: true,
  transforms: {
    WORKFLOW_TABLE: workflowTable,
  },
}
