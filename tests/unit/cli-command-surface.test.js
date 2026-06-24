const test = require('node:test')
const assert = require('node:assert/strict')

const { buildNaxProgram, validateAgentName } = require('../../src/cli/commands/nax')
const {
  actionOptions,
  collectOption,
  mergeCommandOptions,
} = require('../../src/cli/commands/options')

/**
 * Recorded parser action.
 * @typedef {{
 *   name: string,
 *   args: unknown[],
 * }} RecordedCall
 */

/**
 * Builds an isolated parser with stubbed handlers.
 * @returns {{
 *   calls: RecordedCall[],
 *   output: () => string,
 *   program: import('commander').Command,
 * }}
 */
function makeProgram() {
  /** @type {RecordedCall[]} */
  const calls = []
  let stdout = ''
  let stderr = ''
  const record = (name, ...args) => {
    calls.push({ name, args })
  }
  const program = buildNaxProgram({
    actionOptions,
    collectOption,
    handlers: {
      clean: (target, options) => record('clean', target, options),
      ci: (commandParts, options) => {
        record('ci', commandParts, options)
        return { skipped: true, status: 0 }
      },
      comment: (prompt, options) => record('comment', prompt, options),
      handoff: (runId, options) => record('handoff', runId, options),
      init: (options) => record('init', options),
      issue: (prompt, options) => record('issue', prompt, options),
      list: (options) => record('list', options),
      previewBoxes: (flow, options) => record('previewBoxes', flow, options),
      previewSpinner: (options) => record('previewSpinner', options),
      retry: (runId, options) => record('retry', runId, options),
      run: (workflow, options) => record('run', workflow, options),
      skills: (subcommand, options) => record('skills', subcommand, options),
      sync: (target, options) => record('sync', target, options),
      dashboard: (flow, options) => record('dashboard', flow, options),
    },
    mergeCommandOptions,
  })
  program.exitOverride()
  program.configureOutput({
    writeOut: (value) => {
      stdout += value
    },
    writeErr: (value) => {
      stderr += value
    },
  })
  return {
    calls,
    output: () => `${stdout}${stderr}`,
    program,
  }
}

/**
 * Parses one nax invocation.
 * @param {import('commander').Command} program
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function parse(program, args) {
  await program.parseAsync(['node', 'nax', ...args])
}

test('bare nax prints compact root help without execution flags', async () => {
  const { calls, output, program } = makeProgram()

  await parse(program, [])

  assert.deepEqual(calls, [])
  assert.match(output(), /Usage: nax \[command\]/)
  assert.match(output(), /run \[options\] \[flow\]/)
  assert.match(output(), /dashboard \[options\] \[workflow\]/)
  assert.doesNotMatch(output(), /--agent/)
  assert.doesNotMatch(output(), /recent/)
  assert.doesNotMatch(output(), /admin/)
  assert.doesNotMatch(output(), /ci \[options\]/)
})

test('advanced help reveals hidden admin and engineering commands', async () => {
  const { output, program } = makeProgram()

  await parse(program, ['help', '--all'])

  assert.match(output(), /admin\s+Advanced maintenance commands/)
  assert.match(output(), /ci \[options\] <command\.\.\.>/)
  assert.match(output(), /issue \[options\] \[prompt\]/)
})

test('nax run routes workflow execution and retry execution', async () => {
  const { calls, program } = makeProgram()

  await parse(program, ['run', 'review', '--branch', '#123', '--force'])
  await parse(program, ['run', '--retry', 'run-1'])
  await parse(program, ['run', 'review', '--retry', 'run-2', '--step', 'audit'])

  assert.equal(calls[0].name, 'run')
  assert.equal(calls[0].args[0], 'review')
  assert.equal(/** @type {{ branch?: string, force?: boolean }} */ (calls[0].args[1]).branch, '#123')
  assert.equal(/** @type {{ branch?: string, force?: boolean }} */ (calls[0].args[1]).force, true)
  assert.deepEqual(calls.slice(1).map((call) => [call.name, call.args[0], /** @type {{ flow?: string }} */ (call.args[1]).flow]), [
    ['retry', 'run-1', ''],
    ['retry', 'run-2', 'review'],
  ])
})

test('nax run agent routes positional and flagged prompts', async () => {
  const { calls, program } = makeProgram()

  await parse(program, ['run', 'agent', 'codex', 'Review', 'this', '--dry'])
  await parse(program, ['run', 'agent', 'claude', '--prompt', 'Check this', '--transport', 'netlify-api'])

  assert.equal(calls[0].name, 'run')
  assert.equal(calls[0].args[0], null)
  assert.deepEqual({
    agent: /** @type {{ agent?: string, prompt?: string, dry?: boolean }} */ (calls[0].args[1]).agent,
    prompt: /** @type {{ agent?: string, prompt?: string, dry?: boolean }} */ (calls[0].args[1]).prompt,
    dry: /** @type {{ agent?: string, prompt?: string, dry?: boolean }} */ (calls[0].args[1]).dry,
  }, { agent: 'codex', prompt: 'Review this', dry: true })
  assert.deepEqual({
    agent: /** @type {{ agent?: string, prompt?: string, transport?: string }} */ (calls[1].args[1]).agent,
    prompt: /** @type {{ agent?: string, prompt?: string, transport?: string }} */ (calls[1].args[1]).prompt,
    transport: /** @type {{ agent?: string, prompt?: string, transport?: string }} */ (calls[1].args[1]).transport,
  }, { agent: 'claude', prompt: 'Check this', transport: 'netlify-api' })
})

test('agent names are restricted to supported Netlify agents', () => {
  assert.equal(validateAgentName('Codex'), 'codex')
  assert.throws(() => validateAgentName('cdx'), /Did you mean codex/)
  assert.throws(() => validateAgentName('gpt-9'), /Expected one of: claude, gemini, codex/)
})

test('handoff, admin, and hidden ci route to their handlers', async () => {
  const { calls, program } = makeProgram()

  await parse(program, ['handoff', 'run-1', '--path'])
  await parse(program, ['handoff', '--agent', 'gemini', '--workflow', 'run-2'])
  await parse(program, ['admin', 'sync', 'last'])
  await parse(program, ['admin', 'clean', 'blobs', '--force'])
  await parse(program, ['admin', 'skills', 'check', '--provider', 'codex'])
  await parse(program, ['ci', '--quiet', 'npm', 'test'])

  assert.deepEqual(calls.map((call) => call.name), ['handoff', 'handoff', 'sync', 'clean', 'skills', 'ci'])
  assert.equal(calls[0].args[0], 'run-1')
  assert.equal(/** @type {{ path?: boolean }} */ (calls[0].args[1]).path, true)
  assert.equal(/** @type {{ agent?: string, workflow?: string }} */ (calls[1].args[1]).agent, 'gemini')
  assert.deepEqual(calls[2].args, ['last', {}])
  assert.equal(/** @type {{ force?: boolean }} */ (calls[3].args[1]).force, true)
  assert.equal(calls[4].args[0], 'check')
  assert.deepEqual(calls[5].args[0], ['npm', 'test'])
})

test('removed root invocations are rejected', async () => {
  for (const args of [
    ['review'],
    ['--agent', 'codex', '--prompt', 'Check this'],
    ['run', '--agent', 'codex'],
    ['recent'],
    ['retry', 'run-1'],
    ['sync', 'last'],
    ['clean', 'blobs'],
    ['skills', 'check'],
  ]) {
    const { program } = makeProgram()
    await assert.rejects(parse(program, args))
  }
})
