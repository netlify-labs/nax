const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const projectRoot = path.resolve(__dirname, '../..')
const inventoryPath = path.join(
  projectRoot,
  'tests/fixtures/model-effort-provider-model-inventory.json',
)

/**
 * @typedef {{
 *   purpose: string,
 *   entries: Array<{ path: string, markers: string[] }>,
 * }} TerminologyInventory
 */

/** @type {TerminologyInventory} */
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'))

test('provider-as-model terminology inventory covers every required surface', () => {
  const paths = new Set(inventory.entries.map((entry) => entry.path))
  const requiredKinds = [
    'src/core/constants.js',
    'src/core/agents/selection.js',
    'src/workflows/followups/plan.js',
    'src/workflows/engine/runner.js',
    'src/cli/commands/nax.js',
    'src/cli/commands/issue.js',
    'src/cli/main.js',
    'src/contracts/dashboard.ts',
    'src/dashboard/api/serializers.js',
    'src/dashboard/services/mutations.js',
    'src/dashboard/server.js',
    'src/dashboard/web/src/App.tsx',
    'src/dashboard/web/src/components/RunFollowupModal.tsx',
    'tests/unit/agent-selection.test.js',
    'tests/unit/followup-plan.test.js',
    'tests/unit/workflow-runner.test.js',
    'README.md',
    'site/content/guides/run-workflows.mdx',
    'src/templates/skills/nax-workflows/SKILL.md',
  ]
  assert.deepEqual([...paths].sort(), requiredKinds.sort())
})

test('provider-as-model inventory remains executable until the hard rename', () => {
  const missing = []
  for (const entry of inventory.entries) {
    const source = fs.readFileSync(path.join(projectRoot, entry.path), 'utf8')
    for (const marker of entry.markers) {
      if (!source.includes(marker)) {
        missing.push(`${entry.path}: ${marker}`)
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `Update the provider/model terminology inventory for these changed surfaces:\n${missing.join('\n')}`,
  )
})

test('pinned GitHub Action has no true model or effort channel', () => {
  const workflow = fs.readFileSync(
    path.join(projectRoot, 'src/templates/netlify-agents.yml'),
    'utf8',
  )
  assert.match(
    workflow,
    /netlify-labs\/agent-runner-action@4e06b4897d1d69c619af6a25e00ee65e8cb9c91f/,
  )
  assert.match(workflow, /default-agent/)
  assert.doesNotMatch(workflow, /^\s+(?:default-)?model:/m)
  assert.doesNotMatch(workflow, /^\s+effort:/m)
})
