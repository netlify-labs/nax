import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  AGENT_RUNNER_SDK_HANDLE_VERSION,
  AGENT_RUNNER_SDK_VERSION,
  DEFAULT_USER_AGENT,
} from '../src/index.js'

test('exports the initial handle schema version', () => {
  assert.equal(AGENT_RUNNER_SDK_HANDLE_VERSION, 1)
})

test('request metadata version matches the package release version', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
  assert.equal(AGENT_RUNNER_SDK_VERSION, manifest.version)
  assert.equal(DEFAULT_USER_AGENT, `agent-runner-sdk/${manifest.version}`)
})
