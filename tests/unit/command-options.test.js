const test = require('node:test')
const assert = require('node:assert/strict')
const { Command } = require('commander')

const {
  actionOptions,
  collectOption,
  mergeCommandOptions,
  normalizeOptionAliases,
} = require('../../src/commands/options')

/**
 * Captured command action inputs.
 * @typedef {{
 *   options: import('../../src/commands/options').CliOptions,
 *   command: import('commander').Command,
 * }} CapturedAction
 */

test('collectOption appends repeatable option values', () => {
  assert.deepEqual(collectOption('one'), ['one'])
  assert.deepEqual(collectOption('two', ['one']), ['one', 'two'])
})

test('normalizeOptionAliases maps durable CLI aliases', () => {
  const originalCost = process.env.NAX_INCLUDE_COST
  delete process.env.NAX_INCLUDE_COST
  const resolved = normalizeOptionAliases({
    dry: true,
    siteId: 'site-1',
    force: true,
    where: 'netlify-api',
    transport: 'auto',
    cost: true,
  })

  assert.equal(resolved.dryRun, true)
  assert.equal(resolved.netlifySiteId, 'site-1')
  assert.equal(resolved.yes, true)
  assert.equal(resolved.transport, 'netlify-api')
  assert.equal(process.env.NAX_INCLUDE_COST, '1')

  if (originalCost === undefined) {
    delete process.env.NAX_INCLUDE_COST
  } else {
    process.env.NAX_INCLUDE_COST = originalCost
  }
})

test('normalizeOptionAliases preserves explicit transport over hidden where alias', () => {
  const resolved = normalizeOptionAliases({
    where: 'netlify-api',
    transport: 'github',
  })

  assert.equal(resolved.transport, 'github')
})

test('actionOptions inherits explicitly provided parent options', () => {
  /** @type {CapturedAction | null} */
  let captured = null
  const program = new Command()
  program
    .exitOverride()
    .option('--repo <repo>')
    .option('--transport <transport>', '', 'auto')
  program
    .command('issue')
    .option('--repo <repo>')
    .option('--where <transport>')
    .option('--dry')
    .action((options, command) => {
      captured = { options: actionOptions(options, command), command }
    })

  program.parse(['node', 'nax', '--repo', 'netlify/site', 'issue', '--where', 'netlify-api', '--dry'])

  assert.ok(captured)
  assert.equal(captured.options.repo, 'netlify/site')
  assert.equal(captured.options.transport, 'netlify-api')
  assert.equal(captured.options.dryRun, true)
})

test('mergeCommandOptions does not inherit default parent options over local options', () => {
  const parent = new Command()
  parent.option('--transport <transport>', '', 'auto')
  const command = parent.command('run')
  command.option('--transport <transport>')
  parent.parse(['node', 'nax', 'run', '--transport', 'github'])

  const resolved = mergeCommandOptions(command, command.opts())

  assert.equal(resolved.transport, 'github')
})
