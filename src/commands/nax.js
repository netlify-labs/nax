const { Command, Option } = require('commander')
const { DEFAULT_MODEL_CSV, DEFAULT_MODELS } = require('../constants')

/**
 * @typedef {import('commander').Command} CommanderCommand
 * @typedef {import('../types').JsonMap} JsonMap
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
 *   recent: (options: JsonMap) => CommandActionResult,
 *   retry: (runId: string, options: JsonMap) => CommandActionResult,
 *   run: (workflow: string | null | undefined, options: JsonMap) => CommandActionResult,
 *   skills: (subcommand: string, options: JsonMap) => CommandActionResult,
 *   sync: (target: string, options: JsonMap) => CommandActionResult,
 *   visualize: (flow: string, options: JsonMap) => CommandActionResult,
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
 * Hidden option that keeps legacy cost reporting available without advertising it.
 * @returns {Option}
 */
function hiddenCostOption() {
  return new Option('--cost', 'Include estimated USD cost beside Netlify credit usage').hideHelp()
}

/**
 * Adds shared workflow output-budget flags.
 * @param {CommanderCommand} command
 * @param {number} defaultOutputBudgetBytes
 * @returns {CommanderCommand}
 */
function addOutputBudgetOptions(command, defaultOutputBudgetBytes) {
  return command
    .option('--output-budget', 'Append optional output size guidance to chained workflow prompts')
    .option('--no-output-budget', 'Do not append output size guidance to chained workflow prompts')
    .option(
      '--output-budget-bytes <bytes>',
      `Target response size for chained workflow outputs (default: ${defaultOutputBudgetBytes})`,
    )
}

/**
 * Adds the repeatable workflow-directory option.
 * @param {CommanderCommand} command
 * @param {CollectOption} collectOption
 * @returns {CommanderCommand}
 */
function addFlowsDirOption(command, collectOption) {
  return command.option('--flows-dir <path>', 'Project workflow directory; repeatable', collectOption, [])
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
  const addOutputBudget = (command) => addOutputBudgetOptions(command, defaultOutputBudgetBytes)
  const addFlowsDir = (command) => addFlowsDirOption(command, collectOption)

  addOutputBudget(addFlowsDir(program
    .name('nax')
    .description('Run multi step Netlify agent workflows using the worlds leading AI models')
    .argument('[workflow]', 'Workflow to run, e.g. review')
    .option('--repo <owner/name>', 'GitHub repo; defaults to gh repo view')
    .option('--branch <branch-or-pr>', 'Git branch or PR number to run in Netlify agent runners')
    .option('--agent <name>', 'Agent for a Netlify agent run, e.g. codex')
    .option('--prompt <text>', 'Prompt text for a Netlify agent run')
    .option('--site-id <id>', 'Netlify site ID for local Netlify API runs')
    .option('--filter <app>', 'Netlify CLI monorepo app filter for local Netlify agent runs')
    .option('--transport <transport>', 'Where to run: auto, github, netlify-api', 'auto')
    .addOption(new Option('--where <place>', 'Hidden compatibility alias for --transport').hideHelp())
    .option('--archive', 'Archive completed intermediate Netlify API agent runs')
    .addOption(hiddenCostOption())
    .option('--dry', 'Preview the workflow without creating issues, runner jobs, or .nax artifacts')
    .addOption(new Option('--dry-run', 'Hidden compatibility alias for --dry').hideHelp())
    .option('--force', 'Skip confirmation prompts')
    .addOption(new Option('--yes', 'Hidden compatibility alias for --force').hideHelp())
    .option('--notify', 'Show a desktop notification when the flow finishes')
    .option('--notify-url <url>', 'POST workflow and step notifications to a webhook URL')
    .option('--notify-events <list>', 'Comma-separated notification events to send')
    .action((workflow, options, command) => {
      const resolvedOptions = actionOptions(options, command)
      return settleAction(handlers.run(workflow || null, resolvedOptions))
    })))

  program
    .command('init')
    .description('Set up this repository for Netlify Agent Runner workflows')
    .option('--project-root <path>', 'Project root to initialize')
    .option('--repo <owner/name>', 'GitHub repo; defaults to gh repo view')
    .option('--site-id <id>', 'Link this directory to an existing Netlify site ID')
    .option('--site-name <name>', 'Link to or create a Netlify project by name')
    .option('--create', 'Create a new Netlify project if this directory is not linked')
    .option('--dry', 'Preview setup without writing files or secrets')
    .addOption(new Option('--dry-run', 'Hidden compatibility alias for --dry').hideHelp())
    .option('--force', 'Overwrite an existing non-nax workflow file')
    .addOption(new Option('--yes', 'Hidden compatibility alias for --force').hideHelp())
    .option('--github-actions', 'Enable GitHub Actions transport setup')
    .option('--no-github-actions', 'Only set up/link the Netlify site')
    .option('--skip-secrets', 'Create/link project and workflow without setting GitHub secrets')
    .action((options, command) => settleAction(handlers.init(actionOptions(options, command))))

  addOutputBudget(addFlowsDir(program
    .command('run [flow]')
    .description('Run a Netlify Agent Runner workflow')
    .option('--project-root <path>', 'Project root for flow execution')
    .option('--repo <owner/name>', 'GitHub repo; defaults to gh repo view')
    .option('--branch <branch-or-pr>', 'Git branch or PR number to run in Netlify agent runners')
    .option('--context <text>', 'Additional context appended to each prompt')
    .option('--models <list>', 'Comma-separated agent models for workflow steps')
    .option('--step-models <step=models>', 'Agent models for one workflow step; repeatable', collectOption, [])
    .option('--agent <name>', 'Agent for a Netlify agent run, e.g. codex')
    .option('--prompt <text>', 'Prompt text for a Netlify agent run')
    .option('--site-id <id>', 'Netlify site ID for local Netlify API runs')
    .option('--filter <app>', 'Netlify CLI monorepo app filter for local Netlify agent runs')
    .option('--transport <transport>', 'Where to run: auto, github, netlify-api', 'auto')
    .addOption(new Option('--where <place>', 'Hidden compatibility alias for --transport').hideHelp())
    .option('--archive', 'Archive completed intermediate Netlify API agent runs')
    .addOption(hiddenCostOption())
    .option('--context-file <path>', 'Read additional context from a file')
    .option('--sha <rev>', 'Override the pinned git revision injected into the review context')
    .option('--pr-limit <count>', 'Maximum number of open PRs to include in the merge-state ledger', '10')
    .option('--label <list>', 'Comma-separated labels to add')
    .option('--labels <list>', 'Alias for --label')
    .option('--runner <mention>', 'Agent runner mention (default: @netlify)')
    .option('--date <yyyy-mm-dd>', 'Issue title date prefix; defaults to local date')
    .option('--step <id>', 'Run only one flow step')
    .option('--from-step <id>', 'Run from a flow step through the end')
    .option('--issue <list>', 'Recovery: comma-separated issue numbers for comment steps')
    .option('--issues <list>', 'Alias for --issue')
    .option('--from-issues <list>', 'Recovery: comma-separated source issue numbers to embed for comment steps')
    .option('--from-issue <list>', 'Alias for --from-issues')
    .option('--timeout-minutes <count>', 'Minutes to wait for each step to complete', '25')
    .option('--dry', 'Preview the workflow without creating issues, runner jobs, or .nax artifacts')
    .addOption(new Option('--dry-run', 'Hidden compatibility alias for --dry').hideHelp())
    .option('--force', 'Skip confirmation prompts')
    .addOption(new Option('--yes', 'Hidden compatibility alias for --force').hideHelp())
    .option('--notify', 'Show a desktop notification when the flow finishes')
    .option('--notify-url <url>', 'POST workflow and step notifications to a webhook URL')
    .option('--notify-events <list>', 'Comma-separated notification events to send')
    .option('--no-auto-context', 'Do not inject the automatic review contract, pinned SHA snapshot, or PR ledger')
    .option('--no-fetch-results', 'Do not fetch round results from prior steps')
    .action((flow, options, command) => settleAction(handlers.run(flow, actionOptions(options, command))))))

  program
    .command('recent')
    .description('Pick a recent workflow, agent runner, or agent session artifact')
    .option('--run-id <id>', 'Skip the picker and show a specific artifact id')
    .option('--type <kind>', 'Filter by workflow, agent-runner, agent-session, or all', 'all')
    .option('--limit <n>', 'Maximum artifacts to show in the picker', '25')
    .addOption(hiddenCostOption())
    .action((options, command) => settleAction(handlers.recent(actionOptions(options, command))))

  const addRetryOptions = (command) => command
    .option('--project-root <path>', 'Project root containing .nax workflows and agent artifacts')
    .option('--flows-dir <path>', 'Project workflow directory; repeatable', collectOption, [])
    .option('--flow <id>', 'Flow id filter when run id is omitted')
    .option('--step <id>', 'Failed step id to retry')
    .option('--agent <name>', 'Failed agent to retry, e.g. claude')
    .option('--site-id <id>', 'Netlify site ID for local Netlify API runs')
    .option('--filter <app>', 'Netlify CLI monorepo app filter for local Netlify agent runs')
    .option('--timeout-minutes <count>', 'Minutes to wait for the retried run', '25')
    .addOption(hiddenCostOption())
    .action((runId, options, command) => {
      return settleAction(handlers.retry(runId || '', actionOptions(options, command)))
    })

  addRetryOptions(
    program
      .command('retry [run-id]')
      .description('Retry one failed Netlify API agent run with a compact prompt, then continue the workflow'),
  )

  addFlowsDir(program
    .command('handoff [run-id]')
    .description('Copy or continue from the latest workflow, agent runner, or agent session summary')
    .option('--project-root <path>', 'Project root containing .nax workflows and agent artifacts')
    .option('--run-id <id>', 'Workflow run id to hand off')
    .option('--source <id>', 'Artifact source id to hand off')
    .option('--source-type <kind>', 'Artifact source kind: workflow, agent-runner, or agent-session')
    .option('--workflow <id>', 'Workflow artifact id to hand off')
    .option('--runner <id>', 'Agent runner id to hand off')
    .option('--session <id>', 'Agent session id to hand off')
    .option('-c, --copy', 'Copy the selected summary to the clipboard and exit')
    .option('--agent <name>', 'Agent for a fresh handoff run, e.g. codex')
    .option('--flow <id>', 'Workflow id to run with the summary as context')
    .option('--transport <transport>', 'Transport for chained workflows: auto, github-actions, netlify-api, local-machine', 'auto')
    .addOption(new Option('--where <place>', 'Hidden compatibility alias for --transport').hideHelp())
    .option('--branch <branch-or-pr>', 'Git branch or PR number to run in Netlify agent runners')
    .option('--filter <app>', 'Netlify CLI monorepo app filter for local Netlify agent runs')
    .option('--context <text>', 'Additional context prepended before the handoff summary')
    .option('--timeout-minutes <count>', 'Minutes to wait for each Netlify API step or fresh handoff run', '25')
    .addOption(hiddenCostOption())
    .option('--force', 'Skip confirmation prompts for chained workflow runs')
    .addOption(new Option('--yes', 'Hidden compatibility alias for --force').hideHelp())
    .option('--no-auto-context', 'Do not inject automatic context for chained workflow runs')
    .action((runId, options, command) => {
      return settleAction(handlers.handoff(runId || '', actionOptions(options, command)))
    }))

  program
    .command('skills [subcommand]')
    .description('Install, update, and check project-local agent skills')
    .option('--project-root <path>', 'Project root for skill installation')
    .option('--provider <name>', 'Provider directory to install into, e.g. .claude or codex; repeatable', collectOption, [])
    .option('--all-providers', 'Install/check every supported provider directory')
    .option('--skill <name>', 'Bundled skill to install/check; repeatable', collectOption, [])
    .option('--all-skills', 'Install/check every bundled skill')
    .option('--dry', 'Preview installs without writing files')
    .addOption(new Option('--dry-run', 'Hidden compatibility alias for --dry').hideHelp())
    .action((subcommand, options, command) => {
      return settleAction(handlers.skills(subcommand || 'help', actionOptions(options, command)))
    })

  program
    .command('ci <command...>')
    .description('Run a shell command only inside Netlify Agent Runner environments')
    .option('--quiet', 'Do not print skip/run status')
    .allowUnknownOption(true)
    .action((commandParts, options, command) => {
      const result = handlers.ci(commandParts, actionOptions(options, command))
      if (!result.skipped && result.status !== 0) process.exitCode = result.status || 1
    })

  program
    .command('sync [target]')
    .description('Sync local .nax artifacts from remote Netlify Agent Runner or GitHub Actions state')
    .option('--project-root <path>', 'Project root containing .nax artifacts')
    .option('--repo <owner/name>', 'GitHub repo for Actions run IDs; defaults to gh repo view')
    .option('--artifact <name>', 'GitHub Actions artifact name to download when a run has multiple NAX artifacts')
    .action((target, options, command) => {
      handlers.sync(target || 'last', actionOptions(options, command))
    })

  program
    .command('clean [target]')
    .description('Clean temporary nax resources')
    .option('--project-root <path>', 'Project root containing .nax artifacts')
    .option('--ttl-hours <hours>', 'Age after which pending prompt blob refs are eligible for cleanup', '24')
    .option('--force', 'Actually delete resources; without this, prints a dry-run plan')
    .action((target, options, command) => {
      handlers.clean(target || 'blobs', actionOptions(options, command))
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
    .addOption(new Option('--dry-run', 'Hidden compatibility alias for --dry').hideHelp())
    .option('--force', 'Skip confirmation')
    .addOption(new Option('--yes', 'Hidden compatibility alias for --force').hideHelp())
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
    .addOption(new Option('--dry-run', 'Hidden compatibility alias for --dry').hideHelp())
    .option('--force', 'Skip confirmation')
    .addOption(new Option('--yes', 'Hidden compatibility alias for --force').hideHelp())
    .option('--no-auto-context', 'Do not inject the automatic review contract, pinned SHA snapshot, or PR ledger')
    .option('--no-context-prompt', 'Do not ask for free-form context in interactive mode')
    .option('--no-fetch-results', 'Do not fetch round results from --from-issues')
    .action((prompt, options, command) => {
      return settleAction(handlers.comment(prompt, mergeCommandOptions(command, options)))
    })

  program
    .command('list')
    .alias('ls')
    .description('List available workflows')
    .option('--project-root <path>', 'Project root containing project workflows')
    .option('--flows-dir <path>', 'Project workflow directory; repeatable', collectOption, [])
    .option('--json', 'Print available workflows as JSON')
    .option('--verbose', 'Include step count, models, and workflow location')
    .action((options, command) => settleAction(handlers.list(actionOptions(options, command))))

  addFlowsDir(program
    .command('preview-boxes [flow]', { hidden: true })
    .description('Preview the flow plan and success boxes without running the workflow')
    .option('--project-root <path>', 'Project root containing project workflows')
    .option('--transport <transport>', 'Transport to render (github|netlify-api|local)', 'github')
    .option('--branch <branch>', 'Branch label to display', 'master')
    .option('--context <context>', 'Additional context indicator', '')
    .action((flow, options, command) => {
      return settleAction(handlers.previewBoxes(flow, actionOptions(options, command)))
    }))

  addFlowsDir(program
    .command('visualize [workflow]')
    .description('Open the experimental local workflow visualizer')
    .option('--project-root <path>', 'Project root containing project workflows')
    .option('--host <host>', 'Host for the local visualizer server', '127.0.0.1')
    .option('--port <port>', 'Port for the local visualizer server; defaults to an available port')
    .option('--no-open', 'Print the visualizer URL without opening a browser')
    .option('--tail', 'Stream child workflow stdout/stderr to this terminal while visualizing')
    .option('--dev', 'Use development-mode visualizer behavior')
    .action((flow, options, command) => {
      return settleAction(handlers.visualize(flow || '', actionOptions(options, command)))
    }))

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
}
