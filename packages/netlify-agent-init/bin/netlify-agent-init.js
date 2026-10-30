#!/usr/bin/env node
const readline = require('node:readline')
const { parseArgs } = require('node:util')

const { loadConfig } = require('../src/config')
const { detect } = require('../src/detect')
const { applyInit, planInit } = require('../src/init')
const { run } = require('../src/run')
const { setup } = require('../src/setup')
const { formatStatus, status } = require('../src/status')
const { version } = require('../package.json')

const HELP = `netlify-agent-init ${version}

Sets up tools, agent skills and repositories inside Netlify Agent Runners.
Does nothing in deploys, CI or local installs.

Usage:
  netlify-agent-init                  Run setup (from postinstall)
  netlify-agent-init run -- <cmd>     Run a command, agent runners only
  netlify-agent-init status [--json]  Show the environment and the last setup
  netlify-agent-init init [--preset <name>] [--version <v>] [--dir <path>] [--yes]
                                      Add setup to this repo
  netlify-agent-init doctor           Validate config and show what setup would do

Options:
  --local      Run as if inside an agent runner (also NETLIFY_AGENT_INIT=1)
  --dry-run    Show what would happen without changing anything
  --strict     Exit non-zero when a step fails
  --json       JSON output (status)
  -h, --help   Show this help
  -v           Print the package version
`

/** @param {string} question */
function confirm(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close()
      resolve(/^y(es)?$/i.test(answer.trim()))
    })
  })
}

async function main() {
  const argv = process.argv.slice(2)
  const dashDash = argv.indexOf('--')
  const ownArgs = dashDash === -1 ? argv : argv.slice(0, dashDash)
  const passthrough = dashDash === -1 ? [] : argv.slice(dashDash + 1)

  const { values, positionals } = parseArgs({
    args: ownArgs,
    allowPositionals: true,
    options: {
      local: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      strict: { type: 'boolean' },
      json: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      preset: { type: 'string', multiple: true },
      version: { type: 'string' },
      dir: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      'show-version': { type: 'boolean', short: 'v' },
    },
  })

  if (values.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (values['show-version']) {
    process.stdout.write(`${version}\n`)
    return 0
  }

  const [command = 'setup', ...rest] = positionals
  const cwd = process.cwd()

  if (command === 'setup') {
    const result = await setup({ cwd, local: values.local, dryRun: values['dry-run'], strict: values.strict })
    return result.exitCode
  }

  if (command === 'run') {
    const commandText = [...rest, ...passthrough].join(' ').trim()
    if (!commandText) {
      console.error('Usage: netlify-agent-init run -- <command>')
      return 2
    }
    const result = run(commandText, { cwd, local: values.local })
    if (result.skipped) console.log(`[netlify-agent-init] run skipped (${result.detect.label}: ${result.detect.reason})`)
    return result.exitCode
  }

  if (command === 'status') {
    const result = status()
    if (values.json) console.log(JSON.stringify(result, null, 2))
    else console.log(formatStatus(result))
    return 0
  }

  if (command === 'doctor') {
    const loaded = loadConfig(cwd)
    console.log(`config: ${loaded.source || 'none found'}`)
    for (const error of loaded.errors) console.log(`  ✗ ${error}`)
    for (const warning of loaded.warnings) console.log(`  ! ${warning}`)
    const detection = detect()
    console.log(`environment: ${detection.label} (${detection.reason})`)
    if (loaded.config) {
      console.log('in an agent runner, setup would:')
      await setup({ cwd, local: true, dryRun: true, config: loaded.config, log: (message) => console.log(`  ${message}`) })
    }
    return loaded.errors.length > 0 ? 1 : 0
  }

  if (command === 'init') {
    /** @type {Record<string, Record<string, string>>} */
    const presets = {}
    for (const name of values.preset || []) {
      presets[name] = {
        ...(values.version ? { version: values.version } : {}),
        ...(values.dir ? { dir: values.dir } : {}),
      }
    }
    const plan = planInit({ cwd, presets })
    for (const error of plan.errors) console.error(`✗ ${error}`)
    if (plan.errors.length > 0) return 1
    for (const warning of plan.warnings) console.log(`! ${warning}`)
    console.log(`${plan.isNewPackage ? 'Create' : 'Update'} ${plan.packageJsonPath}:`)
    console.log(JSON.stringify({
      scripts: { postinstall: plan.packageJson.scripts && /** @type {Record<string, string>} */ (plan.packageJson.scripts).postinstall },
      devDependencies: { 'netlify-agent-init': /** @type {Record<string, string>} */ (plan.packageJson.devDependencies)['netlify-agent-init'] },
      netlifyAgent: plan.packageJson.netlifyAgent,
    }, null, 2))
    console.log(`Update ${plan.agentsPath} (managed "Agent runner setup" section).`)
    const ok = values.yes || await confirm('Write these changes?')
    if (!ok) {
      console.log('Nothing written. Re-run with --yes to apply.')
      return values.yes ? 0 : 1
    }
    applyInit(plan)
    console.log('Done. Run `npm install` to add netlify-agent-init, then commit package.json and AGENTS.md.')
    return 0
  }

  console.error(`Unknown command "${command}".\n`)
  process.stderr.write(HELP)
  return 2
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`[netlify-agent-init] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(process.env.npm_lifecycle_event === 'postinstall' ? 0 : 1)
  },
)
