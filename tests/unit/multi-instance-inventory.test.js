// Guard/tripwire test for the Arena provider→instance re-key (bead nax-2rx6.1.3).
// Asserts the known provider-keyed anchors still exist and the Phase 0 goldens are coherent,
// so an incomplete re-key or a fixture drift surfaces loudly. See
// docs/plans/multi-instance-provider-keyed-inventory.md.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('multi-instance execution anchors stay instance-aware', () => {
  // follow-up planning retains instance identity
  assert.match(read('src/workflows/engine/local-executor.js'), /sourceRunInstanceId\(sourceRun\) === instance\.id/)
  // step status derives partial success across instances
  assert.match(read('src/workflows/engine/local-executor.js'), /function localStepStatus/)
  assert.match(read('src/workflows/engine/local-executor.js'), /waitForLocalRunSubset/)
  // each scheduler worker holds its slot through result readiness
  assert.match(read('src/workflows/engine/local-executor.js'), /mapInWaves[\s\S]+waitForLocalRunSubset/)
  // wait-for-results flows print the submitted run box before polling, not only at the end
  assert.match(read('src/workflows/engine/local-executor.js'), /formatSubmittedLocalRunBoxes\(\{ runs: \[submitted\][\s\S]+waitForLocalRunSubset/)
  // transport currently derived from materialized config
  assert.match(read('src/cli/main.js'), /materializedAgentConfigurations/)
  // multi-input source collector preserves the source step
  assert.match(read('src/workflows/engine/execution-context.js'), /function sourceRunsForStep/)
})

test('multi-instance fixtures + goldens are coherent', () => {
  const dir = path.join(ROOT, 'tests/fixtures/multi-instance')
  const goldens = JSON.parse(read('tests/fixtures/multi-instance/goldens.json'))
  assert.ok(Array.isArray(goldens.cases) && goldens.cases.length >= 6)
  const ids = new Set()
  for (const c of goldens.cases) {
    // every referenced fixture exists
    assert.ok(fs.existsSync(path.join(dir, c.fixture)), `missing fixture ${c.fixture}`)
    if (c.error) {
      assert.ok(c.error.code, `error case ${c.fixture} needs a code`)
      continue
    }
    assert.ok(Array.isArray(c.instances) && c.instances.length >= 1, c.fixture)
    // instance ids are unique within a case and follow agent:model:effort
    const seen = new Set()
    for (const inst of c.instances) {
      assert.match(inst.id, /^[a-z-]+:[^:]+:[a-z]+$/, `bad id ${inst.id}`)
      assert.equal(seen.has(inst.id), false, `dup id ${inst.id} in ${c.fixture}`)
      seen.add(inst.id)
      // id encodes auto for omitted dims
      const expectedModel = inst.model === null ? 'auto' : inst.model
      const expectedEffort = inst.effort === null ? 'auto' : inst.effort
      assert.equal(inst.id, `${inst.agent}:${expectedModel}:${expectedEffort}`, inst.id)
      ids.add(inst.id)
    }
  }
  // the four use cases are represented
  assert.ok(ids.has('claude:claude-opus-5:auto'), 'bake-off present')
  assert.ok(ids.has('claude:claude-opus-5:low'), 'sweep present')
  assert.ok(ids.has('claude:auto:auto'), 'flagship council (bare=Auto) present')
  assert.ok(ids.has('gemini:gemini-3.1-pro-preview:auto'), 'latest→default present')
})
