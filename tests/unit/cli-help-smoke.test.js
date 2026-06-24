const test = require('node:test')
const assert = require('node:assert/strict')

const { buildProgram } = require('../../src/cli/nax')

/**
 * Commander command with enough surface for help smoke checks.
 * @typedef {import('commander').Command} CommanderCommand
 *
 * Command name and help text matcher used by smoke coverage.
 * @typedef {[string, RegExp]} HelpExpectation
 */

/**
 * Finds a registered command by name.
 * @param {CommanderCommand} program
 * @param {string} name
 * @returns {CommanderCommand}
 */
function commandByName(program, name) {
  const command = program.commands.find((item) => item.name() === name)
  assert.ok(command, `expected command ${name} to be registered`)
  return command
}

test('nax command help smoke covers public and hidden commands', () => {
  const program = buildProgram()
  const rootHelp = program.helpInformation()

  assert.match(rootHelp, /Usage: nax \[command\]/)
  assert.match(rootHelp, /Run Netlify agent workflows/)
  assert.match(rootHelp, /run \[options\] \[flow\]/)
  assert.match(rootHelp, /dashboard \[options\] \[workflow\]/)
  assert.match(rootHelp, /handoff \[options\] \[run-id\]/)
  assert.match(rootHelp, /list \[options\]/)
  assert.match(rootHelp, /init \[options\]/)
  assert.doesNotMatch(rootHelp, /recent/)
  assert.doesNotMatch(rootHelp, /retry \[options\]/)
  assert.doesNotMatch(rootHelp, /sync \[options\]/)
  assert.doesNotMatch(rootHelp, /clean \[options\]/)
  assert.doesNotMatch(rootHelp, /skills \[options\]/)
  assert.doesNotMatch(rootHelp, /ci \[options\]/)
  assert.doesNotMatch(rootHelp, /--agent/)
  assert.doesNotMatch(rootHelp, /--prompt/)
  assert.doesNotMatch(rootHelp, /visualize/i)

  /** @type {HelpExpectation[]} */
  const expectedCommands = [
    ['run', /Start a workflow or single-agent run/],
    ['issue', /Create issues for a prompt/],
    ['comment', /Comment on existing issues with a prompt/],
    ['preview-boxes', /Preview the flow plan/],
    ['preview-spinner', /Preview the wait-for-step progress reporter/],
  ]

  for (const [name, matcher] of expectedCommands) {
    const command = commandByName(program, name)
    const help = command.helpInformation()
    assert.match(help, new RegExp(`Usage: nax ${name}`))
    assert.match(help, matcher)
  }
})
