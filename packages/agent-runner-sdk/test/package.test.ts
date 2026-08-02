import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_RUNNER_SDK_HANDLE_VERSION } from '../src/index.js'

test('exports the initial handle schema version', () => {
  assert.equal(AGENT_RUNNER_SDK_HANDLE_VERSION, 1)
})
