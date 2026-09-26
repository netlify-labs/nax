// Verifies the "Validate your flow" docs list every diagnostic code the flow validator can emit.
// Reads codes straight from the validator and lineup sources so a new code without docs fails here.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const DOCS_PATH = path.join(ROOT, 'site', 'content', 'guides', 'write-custom-workflows.mdx')

/** @param {string} relativePath @param {RegExp} pattern @returns {string[]} */
function codesIn(relativePath, pattern) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
  return [...source.matchAll(pattern)].map((match) => match[1])
}

test('every flow diagnostic code is documented with a fix', () => {
  const codes = new Set([
    ...codesIn('src/workflows/catalog/flows.js', /code: '([a-z_]+)'/g),
    ...codesIn('src/workflows/catalog/flows.js', /\? '([a-z_]+)'\n/g),
    ...codesIn('src/core/agents/instances.js', /(?:instanceError\(|code: )'([a-z_]+)'/g),
    ...codesIn('src/core/agents/configuration.js', /configurationError\(\s*'([a-z_]+)'/g),
    'invalid_agent_configuration',
    'lineup_warning',
    'flow_changed_since_plan',
  ])
  assert.ok(codes.size >= 35, `expected the full code set, found ${codes.size}`)
  const docs = fs.readFileSync(DOCS_PATH, 'utf8')
  const section = docs.slice(docs.indexOf('## Validate your flow'))
  assert.ok(section.startsWith('## Validate your flow'), 'missing "Validate your flow" section')
  const missing = [...codes].filter((code) => !section.includes(`\`${code}\``))
  assert.deepEqual(missing, [])
})
