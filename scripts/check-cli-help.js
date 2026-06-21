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
      'Usage: nax [options] [command] [workflow]',
      'Run multi step Netlify agent workflows',
    ],
  },
  {
    args: ['run', '--help'],
    mustContain: ['Usage: nax run [options] [flow]'],
  },
  {
    args: ['issue', '--help'],
    mustContain: ['Usage: nax issue [options] [prompt]'],
  },
  {
    args: ['comment', '--help'],
    mustContain: ['Usage: nax comment [options] [prompt]'],
  },
  {
    args: ['preview-boxes', '--help'],
    mustContain: ['Usage: nax preview-boxes [options] [flow]'],
  },
  {
    args: ['preview-spinner', '--help'],
    mustContain: ['Usage: nax preview-spinner [options]'],
  },
]

for (const target of targets) {
  const result = spawnSync(process.execPath, ['bin/nax.js', ...target.args], {
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
