#!/usr/bin/env node
const { parseArgs } = require('node:util')

const { applyAdd, planAdd } = require('../src/add')
const { PRESETS } = require('../src/presets')
const { install } = require('../src/install')
const { formatStatus, status } = require('../src/status')
const { version } = require('../package.json')

const HELP = `netlify-agent-kit ${version}

Gives agents in Netlify Agent Runners the tools and skills they need.

Commands:
  add [preset]   Configure this repo, once. Then commit package.json.
                   npx netlify-agent-kit add ${Object.keys(PRESETS).join(' | ')}
                   --version <v>, --dir <path>   override what's detected
  install        Install everything (your postinstall runs this). Only acts in
                 Netlify Agent Runners; prints one line and exits anywhere else.
                   --dry-run   show what it would install
                   --force     install here anyway
                   --strict    exit non-zero when a step fails
  status         Show what the last install did. --json for JSON.
`

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      strict: { type: 'boolean' },
      json: { type: 'boolean' },
      version: { type: 'string' },
      dir: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      'show-version': { type: 'boolean', short: 'v' },
    },
  })

  const [command, ...rest] = positionals
  if (values.help || !command) {
    process.stdout.write(HELP)
    return 0
  }
  if (values['show-version']) {
    process.stdout.write(`${version}\n`)
    return 0
  }
  const cwd = process.cwd()

  if (command === 'install') {
    const result = await install({ cwd, force: values.force, dryRun: values['dry-run'], strict: values.strict })
    return result.exitCode
  }

  if (command === 'status') {
    const result = status()
    if (values.json) console.log(JSON.stringify(result, null, 2))
    else console.log(formatStatus(result))
    return 0
  }

  if (command === 'add') {
    /** @type {Record<string, string>} */
    const options = {
      ...(values.version ? { version: values.version } : {}),
      ...(values.dir ? { dir: values.dir } : {}),
    }
    const plan = planAdd({ cwd, preset: rest[0], options })
    for (const note of plan.notes) console.log(`· ${note}`)
    for (const error of plan.errors) console.error(`✗ ${error}`)
    if (plan.errors.length > 0) return 1
    for (const warning of plan.warnings) console.log(`! ${warning}`)
    applyAdd(plan)
    console.log(`${plan.isNewPackage ? 'Created' : 'Updated'} package.json.`)
    console.log('Next: run `npm install`, then commit package.json.')
    return 0
  }

  console.error(`Unknown command "${command}".\n`)
  process.stderr.write(HELP)
  return 2
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`[netlify-agent-kit] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(process.env.npm_lifecycle_event === 'postinstall' ? 0 : 1)
  },
)
