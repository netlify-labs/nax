const { Command, Option } = require('commander')
const { DEFAULT_MODEL_CSV, DEFAULT_MODELS } = require('../../core/constants')

/**
 * @typedef {import('commander').Command} CommanderCommand
 * @typedef {import('../../types').JsonMap} JsonMap
 */

/**
 * Result shape returned by the `ci` command handler.
 * @typedef {{
 *   skipped?: boolean,
 *   status?: number | null,
 * }} CiCommandResult
 *
 * Synchronous or asynchronous command action result.
 * @typedef {unknown | Promise<unknown>} CommandActionResult
 */

/**
 * Commander repeatable option collector.
 * @typedef {(value: string, previous: string[]) => string[]} CollectOption
 *
 * Normalizes options for a command action callback.
 * @typedef {(options: JsonMap, command: CommanderCommand) => JsonMap} ActionOptions
 *
 * Normalizes local and parent command options for nested command callbacks.
 * @typedef {(command: CommanderCommand, options: JsonMap) => JsonMap} MergeCommandOptions
 */

/**
 * CLI command handler callbacks owned by the executable entrypoint.
 * @typedef {{
 *   clean: (target: string, options: JsonMap) => CommandActionResult,
 *   ci: (commandParts: string[], options: JsonMap) => CiCommandResult,
 *   comment: (prompt: string | undefined, options: JsonMap) => CommandActionResult,
 *   handoff: (runId: string, options: JsonMap) => CommandActionResult,
 *   init: (options: JsonMap) => CommandActionResult,
 *   issue: (prompt: string | undefined, options: JsonMap) => CommandActionResult,
 *   list: (options: JsonMap) => CommandActionResult,
 *   previewBoxes: (flow: string | undefined, options: JsonMap) => CommandActionResult,
 *   previewSpinner: (options: JsonMap) => CommandActionResult,
 *   retry: (runId: string, options: JsonMap) => CommandActionResult,
 *   run: (workflow: string | null | undefined, options: JsonMap) => CommandActionResult,
 *   skills: (subcommand: string, options: JsonMap) => CommandActionResult,
 *   sync: (target: string, options: JsonMap) => CommandActionResult,
 *   dashboard: (flow: string, options: JsonMap) => CommandActionResult,
 * }} NaxCommandHandlers
 */

/**
 * Inputs required to construct the nax Commander program.
 * @typedef {{
 *   actionOptions: ActionOptions,
 *   collectOption: CollectOption,
 *   defaultOrchestrator?: string,
 *   defaultOutputBudgetBytes?: number,
 *   handlers: NaxCommandHandlers,
 *   mergeCommandOptions: MergeCommandOptions,
 * }} BuildNaxProgramInput
 */

/**
 * Hidden command metadata that Commander stores outside its public typings.
 * @typedef {{
 *   _hidden?: boolean,
 *   _outputConfiguration?: {
 *     writeOut?: (value: string) => void,
 *   },
 * }} HiddenCommanderFields
 */

/**
 * Adapts handler payloads to Commander action return semantics.
 * @param {CommandActionResult} result
 * @returns {void | Promise<void>}
 */
function settleAction(result) {
  if (!result || (typeof result !== 'object' && typeof result !== 'function')) return undefined
  const then = /** @type {{ then?: unknown }} */ (result).then
  if (typeof then !== 'function') return undefined
  return Promise.resolve(result).then(() => {})
}

/**
 * Creates a hidden Commander option.
 * @param {string} flags
 * @param {string} description
 * @param {unknown} [defaultValue]
 * @returns {Option}
 */
function hiddenOption(flags, description, defaultValue) {
  const option = new Option(flags, description).hideHelp()
  if (arguments.length >= 3) option.default(defaultValue)
  return option
}

/**
 * Hidden option that keeps legacy cost reporting available without advertising it.
 * @returns {Option}
 */
function hiddenCostOption() {
  return hiddenOption('--cost', 'Include estimated USD cost beside Netlify credit usage')
}

/**
 * Adds a hidden repeatable workflow-directory option.
 * @param {CommanderCommand} command
 * @param {CollectOption} collectOption
 * @returns {CommanderCommand}
 */
function addAdvancedFlowsDirOption(command, collectOption) {
  return command.addOption(hiddenOption('--flows-dir <path>', 'Project workflow directory; repeatable').argParser(collectOption).default([]))
}

/**
 * Adds public workflow-directory option.
 * @param {CommanderCommand} command
 * @param {CollectOption} collectOption
 * @returns {CommanderCommand}
 */
function addFlowsDirOption(command, collectOption) {
  return command.option('--flows-dir <path>', 'Project workflow directory; repeatable', collectOption, [])
}

/**
 * Adds hidden workflow output-budget flags.
 * @param {CommanderCommand} command
 * @param {number} defaultOutputBudgetBytes
 * @returns {CommanderCommand}
 */
function addAdvancedOutputBudgetOptions(command, defaultOutputBudgetBytes) {
  return command
    .addOption(hiddenOption('--output-budget', 'Append optional output size guidance to chained workflow prompts'))
    .addOption(hiddenOption('--no-output-budget', 'Do not append output size guidance to chained workflow prompts'))
    .addOption(hiddenOption(
      '--output-budget-bytes <bytes>',
      `Target response size for chained workflow outputs (default: ${defaultOutputBudgetBytes})`,
      String(defaultOutputBudgetBytes),
    ))
}

/**
 * Adds the compact run flags shared by workflow and single-agent runs.
 * @param {CommanderCommand} command
 * @returns {CommanderCommand}
 */
function addPublicRunOptions(command) {
  return command
    .option('--branch <branch-or-pr>', 'Git branch or PR number to run in Netlify agent runners')
    .option('--context <text>', 'Additional context appended to each prompt')
    .option('--context-file <path>', 'Read additional context from a file')
    .option('--models <list>', 'Comma-separated agent models for workflow steps')
    .option('--step <id>', 'Run only one flow step')
    .option('--from-step <id>', 'Run from a flow step through the end')
    .option('--transport <transport>', 'Where to run: auto, github, netlify-api', 'auto')
    .option('--dry', 'Preview the workflow without creating issues, runner jobs, or .nax artifacts')
    .option('--force', 'Skip confirmation prompts')
}

/**
 * Adds advanced run flags that should stay callable but out of compact help.
 * @param {CommanderCommand} command
 * @param {CollectOption} collectOption
 * @param {number} defaultOutputBudgetBytes
 * @returns {CommanderCommand}
 */
function addAdvancedRunOptions(command, collectOption, defaultOutputBudgetBytes) {
  return addAdvancedOutputBudgetOptions(addAdvancedFlowsDirOption(command
    .addOption(hiddenOption('--project-root <path>', 'Project root for flow execution'))
    .addOption(hiddenOption('--repo <owner/name>', 'GitHub repo; defaults to gh repo view'))
    .addOption(hiddenOption('--site-id <id>', 'Netlify site ID for local Netlify API runs'))
    .addOption(hiddenOption('--filter <app>', 'Netlify CLI monorepo app filter for local Netlify agent runs'))
    .addOption(hiddenOption('--archive', 'Archive completed intermediate Netlify API agent runs'))
    .addOption(hiddenCostOption())
    .addOption(hiddenOption('--sha <rev>', 'Override the pinned git revision injected into the review context'))
    .addOption(hiddenOption('--pr-limit <count>', 'Maximum number of open PRs to include in the merge-state ledger', '10'))
    .addOption(hiddenOption('--label <list>', 'Comma-separated labels to add'))
    .addOption(hiddenOption('--runner <mention>', 'Agent runner mention (default: @netlify)'))
    .addOption(hiddenOption('--date <yyyy-mm-dd>', 'Issue title date prefix; defaults to local date'))
    .addOption(hiddenOption('--issue <list>', 'Recovery: comma-separated issue numbers for comment steps'))
    .addOption(hiddenOption('--from-issues <list>', 'Recovery: comma-separated source issue numbers to embed for comment steps'))
    .addOption(hiddenOption('--timeout-minutes <count>', 'Minutes to wait for each step to complete', '25'))
    .addOption(hiddenOption('--notify', 'Show a desktop notification when the flow finishes'))
    .addOption(hiddenOption('--notify-url <url>', 'POST workflow and step notifications to a webhook URL'))
    .addOption(hiddenOption('--notify-events <list>', 'Comma-separated notification events to send'))
    .addOption(hiddenOption('--no-auto-context', 'Do not inject the automatic review contract, pinned SHA snapshot, or PR ledger'))
    .addOption(hiddenOption('--no-fetch-results', 'Do not fetch round results from prior steps'))
    .addOption(hiddenOption('--step-models <step=models>', 'Agent models for one workflow step; repeatable').argParser(collectOption).default([])), collectOption), defaultOutputBudgetBytes)
}

/**
 * Adds retry-specific flags.
 * @param {CommanderCommand} command
 * @returns {CommanderCommand}
 */
function addRetryOptions(command) {
  return command
    .option('--retry [run-id]', 'Retry one failed Netlify API agent run and continue the workflow')
    .addOption(hiddenOption('--agent <name>', 'Failed agent to retry, e.g. claude'))
}

/**
 * Adds admin skills command flags.
 * @param {CommanderCommand} command
 * @param {CollectOption} collectOption
 * @returns {CommanderCommand}
 */
function addSkillsOptions(command, collectOption) {
  return command
    .option('--project-root <path>', 'Project root for skill installation')
    .option('--provider <name>', 'Provider directory to install into, e.g. .claude or codex; repeatable', collectOption, [])
    .option('--all-providers', 'Install/check every supported provider directory')
    .option('--skill <name>', 'Bundled skill to install/check; repeatable', collectOption, [])
    .option('--all-skills', 'Install/check every bundled skill')
    .option('--dry', 'Preview installs without writing files')
}

/**
 * Computes a rough edit distance for short CLI suggestions.
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function editDistance(left, right) {
  const a = left.toLowerCase()
  const b = right.toLowerCase()
  /** @type {number[][]} */
  const table = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0))
  for (let index = 0; index <= a.length; index += 1) table[index][0] = index
  for (let index = 0; index <= b.length; index += 1) table[0][index] = index
  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1
      table[row][column] = Math.min(
        table[row - 1][column] + 1,
        table[row][column - 1] + 1,
        table[row - 1][column - 1] + cost,
      )
    }
  }
  return table[a.length][b.length]
}

/**
 * Validates one public agent name.
 * @param {string} agent
 * @returns {string}
 */
function validateAgentName(agent) {
  const normalized = String(agent || '').trim().toLowerCase()
  if (DEFAULT_MODELS.includes(normalized)) return normalized
  const suggested = DEFAULT_MODELS
    .map((candidate) => ({ candidate, distance: editDistance(normalized, candidate) }))
    .sort((left, right) => left.distance - right.distance)[0]
  const hint = suggested && suggested.distance <= 2 ? ` Did you mean ${suggested.candidate}?` : ''
  throw new Error(`Unknown agent "${agent}". Expected one of: ${DEFAULT_MODELS.join(', ')}.${hint}`)
}

/**
 * Resolves the value from `--retry [run-id]`.
 * @param {unknown} value
 * @returns {{ requested: boolean, runId: string }}
 */
function resolveRetryValue(value) {
  if (value === undefined) return { requested: false, runId: '' }
  if (value === true) return { requested: true, runId: '' }
  return { requested: true, runId: String(value || '') }
}

/**
 * Makes hidden commands and options temporarily visible while rendering advanced help.
 * @param {CommanderCommand} command
 * @param {() => string} render
 * @returns {string}
 */
function withAdvancedHelp(command, render) {
  /** @type {Array<() => void>} */
  const restore = []
  /**
   * @param {CommanderCommand} current
   * @returns {void}
   */
  function reveal(current) {
    for (const option of current.options) {
      const prior = option.hidden
      option.hidden = false
      restore.push(() => { option.hidden = prior })
    }
    for (const child of current.commands) {
      const hiddenFields = /** @type {HiddenCommanderFields} */ (child)
      const prior = hiddenFields._hidden
      hiddenFields._hidden = false
      restore.push(() => { hiddenFields._hidden = prior })
      reveal(child)
    }
  }
  reveal(command)
  try {
    return render()
  } finally {
    for (const restoreOne of restore.reverse()) restoreOne()
  }
}

/**
 * Finds a command by a path such as ["run", "agent"].
 * @param {CommanderCommand} program
 * @param {string[]} commandPath
 * @returns {CommanderCommand}
 */
function findCommand(program, commandPath) {
  let current = program
  for (const segment of commandPath) {
    const next = current.commands.find((command) => command.name() === segment || command.aliases().includes(segment))
    if (!next) throw new Error(`Unknown help topic "${commandPath.join(' ')}".`)
    current = next
  }
  return current
}

/**
 * Writes generated help through Commander output hooks when available.
 * @param {CommanderCommand} program
 * @param {string} text
 * @returns {void}
 */
function writeHelp(program, text) {
  const outputConfig = /** @type {HiddenCommanderFields} */ (program)._outputConfiguration
  if (typeof outputConfig?.writeOut === 'function') {
    outputConfig.writeOut(text)
    return
  }
  process.stdout.write(text)
}

/**
 * Registers the nax CLI command tree.
 * @param {BuildNaxProgramInput} input
 * @returns {CommanderCommand}
 */
function buildNaxProgram({
  actionOptions,
  collectOption,
  defaultOrchestrator = 'Netlify Agent runner',
  defaultOutputBudgetBytes = 64000,
  handlers,
  mergeCommandOptions,
}) {
  const program = new Command()
  program
    .name('nax')
    .description('Run Netlify agent workflows.')
    .usage('[command]')
    .addHelpCommand(false)
    .showHelpAfterError()
    .action(() => {
      program.outputHelp()
    })

  const helpCommand = program
    .command('help [topic...]', { hidden: true })
    .description('Show help for nax commands')
    .option('--all', 'Show advanced commands and flags')
    .action((topic, options) => {
      const commandPath = Array.isArray(topic) ? topic : []
      const command = commandPath.length > 0 ? findCommand(program, commandPath) : program
      const render = () => command.helpInformation()
      writeHelp(program, options.all ? withAdvancedHelp(command, render) : render())
    })
  helpCommand.allowUnknownOption(false)

  program
    .command('init')
    .description('Set up this repository for Netlify Agent Workflows')
    .option('--project-root <path>', 'Project root to initialize')
    .option('--repo <owner/name>', 'GitHub repo; defaults to gh repo view')
    .option('--site-id <id>', 'Link this directory to an existing Netlify site ID')
    .option('--site-name <name>', 'Link to or create a Netlify project by name')
    .option('--create', 'Create a new Netlify project if this directory is not linked')
    .option('--dry', 'Preview setup without writing files or secrets')
    .option('--force', 'Overwrite an existing non-nax workflow file')
    .option('--github-actions', 'Enable GitHub Actions transport setup')
    .option('--no-github-actions', 'Only set up/link the Netlify site')
    .option('--skip-secrets', 'Create/link project and workflow without setting GitHub secrets')
    .action((options, command) => settleAction(handlers.init(actionOptions(options, command))))

  const runCommand = addRetryOptions(addAdvancedRunOptions(addPublicRunOptions(program
    .command('run [flow]')
    .description('Start a workflow or single-agent run')
    .usage('[workflow]')), collectOption, defaultOutputBudgetBytes))
    .action((flow, options, command) => {
      const resolvedOptions = actionOptions(options, command)
      const retry = resolveRetryValue(resolvedOptions.retry)
      if (retry.requested) {
        if (!retry.runId && !process.stdin.isTTY) {
          throw new Error('nax run --retry requires a run id in non-TTY mode.')
        }
        return settleAction(handlers.retry(retry.runId, { ...resolvedOptions, flow: flow || resolvedOptions.flow || '' }))
      }
      if (resolvedOptions.agent) {
        throw new Error('Use `nax run agent <type> <prompt>` for single-agent runs.')
      }
      return settleAction(handlers.run(flow, resolvedOptions))
    })

  addAdvancedRunOptions(addPublicRunOptions(runCommand
    .command('agent <type> [prompt...]')
    .description('Run one Netlify agent directly')
    .option('--prompt <text>', 'Prompt text for the agent run')), collectOption, defaultOutputBudgetBytes)
    .action((type, promptParts, options, command) => {
      const agent = validateAgentName(type)
      const resolvedOptions = actionOptions(options, command)
      const positionalPrompt = Array.isArray(promptParts) ? promptParts.join(' ').trim() : ''
      const prompt = typeof resolvedOptions.prompt === 'string' && resolvedOptions.prompt.trim()
        ? resolvedOptions.prompt
        : positionalPrompt
      return settleAction(handlers.run(null, {
        ...resolvedOptions,
        agent,
        prompt,
      }))
    })

  addFlowsDirOption(program
    .command('handoff [run-id]')
    .description('Browse, copy, open, or continue from previous agentic workflow')
    .option('--project-root <path>', 'Project root containing .nax workflows and agent artifacts')
    .option('--run-id <id>', 'Workflow run id to hand off')
    .addOption(hiddenOption('--source <id>', 'Artifact source id to hand off'))
    .addOption(hiddenOption('--source-type <kind>', 'Artifact source kind: workflow, agent-runner, or agent-session'))
    .option('--workflow <id>', 'Workflow artifact id to hand off')
    .option('--runner <id>', 'Agent runner id to hand off')
    .option('--session <id>', 'Agent session id to hand off')
    .option('-c, --copy', 'Copy the selected summary to the clipboard and exit')
    .option('--copy-path', 'Copy the selected summary path to the clipboard and exit')
    .option('--open', 'Open the selected summary file')
    .option('--path', 'Print the selected summary path')
    .option('--agent <name>', 'Agent for a fresh handoff run, e.g. codex')
    .option('--flow <id>', 'Workflow id to run with the summary as context')
    .option('--transport <transport>', 'Transport for chained workflows: auto, github-actions, netlify-api, local-machine', 'auto')
    .option('--branch <branch-or-pr>', 'Git branch or PR number to run in Netlify agent runners')
    .option('--filter <app>', 'Netlify CLI monorepo app filter for local Netlify agent runs')
    .option('--context <text>', 'Additional context prepended before the handoff summary')
    .option('--timeout-minutes <count>', 'Minutes to wait for each Netlify API step or fresh handoff run', '25')
    .addOption(hiddenCostOption())
    .option('--force', 'Skip confirmation prompts for chained workflow runs')
    .addOption(hiddenOption('--no-auto-context', 'Do not inject automatic context for chained workflow runs')), collectOption)
    .action((runId, options, command) => {
      const resolvedOptions = actionOptions(options, command)
      if (resolvedOptions.agent) resolvedOptions.agent = validateAgentName(String(resolvedOptions.agent))
      return settleAction(handlers.handoff(runId || '', resolvedOptions))
    })

  program
    .command('list')
    .description('List available workflows')
    .option('--project-root <path>', 'Project root containing project workflows')
    .option('--flows-dir <path>', 'Project workflow directory; repeatable', collectOption, [])
    .option('--json', 'Print available workflows as JSON')
    .option('--verbose', 'Include step count, models, and workflow location')
    .action((options, command) => settleAction(handlers.list(actionOptions(options, command))))

  addAdvancedFlowsDirOption(program
    .command('dashboard [workflow]')
    .description('Open the local workflow dashboard')
    .addOption(hiddenOption('--project-root <path>', 'Project root containing project workflows'))
    .addOption(hiddenOption('--host <host>', 'Host for the local dashboard server', '127.0.0.1'))
    .addOption(hiddenOption('--port <port>', 'Port for the local dashboard server; defaults to an available port'))
    .option('--run <runId>', 'Open a saved workflow run directly in the details view')
    .option('--no-open', 'Print the dashboard URL without opening a browser')
    .option('--tail', 'Stream child workflow stdout/stderr to this terminal while using the dashboard')
    .addOption(hiddenOption('--dev', 'Use development-mode dashboard behavior')), collectOption)
    .action((flow, options, command) => {
      return settleAction(handlers.dashboard(flow || '', actionOptions(options, command)))
    })

  const admin = program
    .command('admin', { hidden: true })
    .description('Advanced maintenance commands')

  admin
    .command('sync [target]')
    .description('Sync local .nax artifacts from remote Netlify Agent Runner or GitHub Actions state')
    .option('--project-root <path>', 'Project root containing .nax artifacts')
    .option('--repo <owner/name>', 'GitHub repo for Actions run IDs; defaults to gh repo view')
    .option('--artifact <name>', 'GitHub Actions artifact name to download when a run has multiple NAX artifacts')
    .action((target, options, command) => {
      handlers.sync(target || 'last', actionOptions(options, command))
    })

  admin
    .command('clean [target]')
    .description('Clean temporary nax resources')
    .option('--project-root <path>', 'Project root containing .nax artifacts')
    .option('--ttl-hours <hours>', 'Age after which pending prompt blob refs are eligible for cleanup', '24')
    .option('--force', 'Actually delete resources; without this, prints a dry-run plan')
    .action((target, options, command) => {
      handlers.clean(target || 'blobs', actionOptions(options, command))
    })

  addSkillsOptions(admin
    .command('skills [subcommand]')
    .description('Install, update, and check project-local agent skills'), collectOption)
    .action((subcommand, options, command) => {
      return settleAction(handlers.skills(subcommand || 'help', actionOptions(options, command)))
    })

  program
    .command('ci <command...>', { hidden: true })
    .description('Run a shell command only inside Netlify Agent Runner environments')
    .option('--quiet', 'Do not print skip/run status')
    .allowUnknownOption(true)
    .action((commandParts, options, command) => {
      const result = handlers.ci(commandParts, actionOptions(options, command))
      if (!result.skipped && result.status !== 0) process.exitCode = result.status || 1
    })

  program
    .command('issue [prompt]', { hidden: true })
    .description('Create issues for a prompt')
    .option('--models <list>', `Comma-separated models (default: ${DEFAULT_MODELS.join(',')})`)
    .option('--repo <owner/name>', 'GitHub repo; defaults to gh repo view')
    .option('--date <yyyy-mm-dd>', 'Issue title date prefix; defaults to local date')
    .option('--title <title>', 'Issue title suffix; defaults to prompt title')
    .option('--context <text>', 'Additional context appended to each issue')
    .option('--context-file <path>', 'Read additional context from a file')
    .option('--from-issues <list>', 'Comma-separated source issue numbers; their latest agent reply is fetched and embedded as collapsible details')
    .option('--from-issue <list>', 'Alias for --from-issues')
    .option('--from-issues-heading <text>', 'Heading used for the embedded round-results section')
    .option('--sha <rev>', 'Override the pinned git revision injected into the review context')
    .option('--repo-root <path>', 'Repository root used to compute the pinned SHA and working tree snapshot')
    .option('--pr-limit <count>', 'Maximum number of open PRs to include in the merge-state ledger', '10')
    .option('--label <list>', 'Comma-separated labels to add')
    .option('--labels <list>', 'Alias for --label')
    .option('--runner <mention>', 'Agent runner mention (default: @netlify)')
    .option('--dry', 'Print issues without creating them')
    .option('--force', 'Skip confirmation')
    .option('--no-auto-context', 'Do not inject the automatic review contract, pinned SHA snapshot, or PR ledger')
    .option('--no-context-prompt', 'Do not ask for free-form context in interactive mode')
    .option('--no-fetch-results', 'Do not fetch round results from --from-issues')
    .option('--skip-round-check', 'Skip the cross-review-completeness check for summarize-consensus')
    .action((prompt, options, command) => {
      return settleAction(handlers.issue(prompt, mergeCommandOptions(command, options)))
    })

  program
    .command('comment [prompt]', { hidden: true })
    .description('Comment on existing issues with a prompt')
    .option('--issue <list>', 'Comma-separated issue numbers')
    .option('--issues <list>', 'Alias for --issue')
    .option('--repo <owner/name>', 'GitHub repo; defaults to gh repo view')
    .option('--context <text>', 'Additional context appended to each comment')
    .option('--context-file <path>', 'Read additional context from a file')
    .option('--from-issues <list>', 'Comma-separated source issue numbers; their latest agent reply is fetched and embedded as collapsible details (defaults to --issues for cross-review)')
    .option('--from-issue <list>', 'Alias for --from-issues')
    .option('--from-issues-heading <text>', 'Heading used for the embedded round-results section')
    .option('--sha <rev>', 'Override the pinned git revision injected into the review context')
    .option('--repo-root <path>', 'Repository root used to compute the pinned SHA and working tree snapshot')
    .option('--pr-limit <count>', 'Maximum number of open PRs to include in the merge-state ledger', '10')
    .option('--runner <mention>', 'Agent runner mention (default: @netlify)')
    .option('--dry', 'Print comments without creating them')
    .option('--force', 'Skip confirmation')
    .option('--no-auto-context', 'Do not inject the automatic review contract, pinned SHA snapshot, or PR ledger')
    .option('--no-context-prompt', 'Do not ask for free-form context in interactive mode')
    .option('--no-fetch-results', 'Do not fetch round results from --from-issues')
    .action((prompt, options, command) => {
      return settleAction(handlers.comment(prompt, mergeCommandOptions(command, options)))
    })

  addFlowsDirOption(program
    .command('preview-boxes [flow]', { hidden: true })
    .description('Preview the flow plan and success boxes without running the workflow')
    .option('--project-root <path>', 'Project root containing project workflows')
    .option('--transport <transport>', 'Transport to render (github|netlify-api|local)', 'github')
    .option('--branch <branch>', 'Branch label to display', 'master')
    .option('--context <context>', 'Additional context indicator', ''), collectOption)
    .action((flow, options, command) => {
      return settleAction(handlers.previewBoxes(flow, actionOptions(options, command)))
    })

  program
    .command('preview-spinner', { hidden: true })
    .description('Preview the wait-for-step progress reporter without running a workflow')
    .option('--count <n>', 'How many agent results to simulate', '3')
    .option('--tick-ms <ms>', 'Delay between simulated completions', '10000')
    .option('--flavor-min-ms <ms>', 'Minimum delay between flavor rotations', '10000')
    .option('--flavor-max-ms <ms>', 'Maximum delay between flavor rotations', '15000')
    .option('--label <label>', 'Step title to display', 'Review')
    .option('--agents <list>', 'Comma-separated agent names', DEFAULT_MODEL_CSV)
    .option('--orchestrator <name>', 'Orchestrator label prefixed to agent', defaultOrchestrator)
    .action((options, command) => settleAction(handlers.previewSpinner(actionOptions(options, command))))

  return program
}

module.exports = {
  buildNaxProgram,
  editDistance,
  validateAgentName,
}
