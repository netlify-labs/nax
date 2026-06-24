#!/usr/bin/env node

const { spawnSync } = require('child_process')

/**
 * CLI help command smoke target.
 * @typedef {{
 *   args: string[],
 *   mustContain: string[],
 * }} HelpTarget
 */

/** @type {HelpTarget[]} */
const targets = [
  {
    args: ['--help'],
    mustContain: [
      'Usage: nax [command]',
      'Run Netlify agent workflows',
    ],
  },
  {
    args: ['run', '--help'],
    mustContain: ['Usage: nax run [workflow]'],
  },
  {
    args: ['run', 'agent', '--help'],
    mustContain: ['Usage: nax run agent [options] <type> [prompt...]'],
  },
  {
    args: ['dashboard', '--help'],
    mustContain: ['Usage: nax dashboard [options] [workflow]'],
  },
  {
    args: ['handoff', '--help'],
    mustContain: ['Usage: nax handoff [options] [run-id]'],
  },
]

for (const target of targets) {
  const result = spawnSync(process.execPath, ['src/cli/nax.js', ...target.args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    console.error(`help smoke failed for: nax ${target.args.join(' ')}`)
    console.error(result.stderr || result.stdout)
    process.exit(result.status || 1)
  }
  for (const expected of target.mustContain) {
    if (!result.stdout.includes(expected)) {
      console.error(`help smoke missing "${expected}" for: nax ${target.args.join(' ')}`)
      process.exit(1)
    }
  }
}

console.log(`checked ${targets.length} help targets`)
