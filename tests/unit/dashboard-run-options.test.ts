import assert from 'node:assert/strict'
import { test } from 'node:test'

import { withCurrentBranchDefault } from '../../src/dashboard/web/src/run-options'
import type { DryRunOptions } from '../../src/dashboard/web/src/types'

function options(branch: string): DryRunOptions {
  return {
    branch,
    transport: 'netlify-api',
    agents: [],
    stepAgents: {},
    context: '',
    step: '',
    fromStep: '',
  }
}

test('withCurrentBranchDefault adopts the checked-out branch when no branch is selected', () => {
  assert.equal(withCurrentBranchDefault(options(''), 'feature/dashboard').branch, 'feature/dashboard')
})

test('withCurrentBranchDefault preserves an explicit branch selection', () => {
  const selected = options('release/2.x')
  assert.strictEqual(withCurrentBranchDefault(selected, 'feature/dashboard'), selected)
})
