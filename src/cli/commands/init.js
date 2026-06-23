const path = require('path')
const {
  enableGitHubActionsSetup,
  findExistingAgentRunnerWorkflow,
  initSite,
} = require('../../integrations/netlify/init')

/**
 * Netlify init result rendered by the CLI.
 * @typedef {{
 *   projectRoot: string,
 *   repo?: string,
 *   netlify: import('../../integrations/netlify/init').NetlifyProjectInfo,
 *   githubActions?: boolean,
 *   workflow?: {
 *     path: string,
 *     status: string,
 *   } | null,
 *   secrets: Array<{
 *     name: string,
 *     status: string,
 *     reason?: string,
 *   }>,
 * }} InitCliResult
 *
 * Context for deciding whether GitHub Actions setup should be enabled.
 * @typedef {{
 *   projectRoot?: string,
 * }} GithubActionsSetupPromptContext
 *
 * Clack confirm dependency subset used by interactive init prompts.
 * @typedef {{
 *   confirm: (input: {
 *     message: string,
 *     initialValue?: boolean,
 *   }) => Promise<boolean | symbol>,
 *   isCancel: (value: boolean | symbol) => boolean,
 * }} ClackConfirmApi
 *
 * Dependencies injected into init command handlers.
 * @typedef {{
 *   loadClack?: () => Promise<ClackConfirmApi>,
 * }} InitCliDependencies
 */

let clackModulePromise

/**
 * Lazily loads Clack for interactive init prompts.
 * @returns {Promise<ClackConfirmApi>}
 */
async function defaultLoadClack() {
  clackModulePromise = clackModulePromise || import('@clack/prompts')
  return clackModulePromise
}

/**
 * Prints the init result.
 * @param {InitCliResult} result
 * @param {{ dryRun?: boolean }} [options]
 * @returns {void}
 */
function printInitResult(result, { dryRun = false } = {}) {
  const prefix = dryRun ? 'Would initialize' : 'Initialized'
  console.log(`${prefix}: ${result.projectRoot}`)
  if (result.repo) console.log(`GitHub repo: ${result.repo}`)
  if (result.netlify.siteId) console.log(`Netlify site ID: ${result.netlify.siteId}`)
  if (result.netlify.siteName) console.log(`Netlify project: ${result.netlify.siteName}`)
  if (result.netlify.siteUrl) console.log(`Netlify URL: ${result.netlify.siteUrl}`)
  if (result.netlify.adminUrl) console.log(`Netlify admin: ${result.netlify.adminUrl}`)
  if (result.netlify.accountName || result.netlify.accountEmail) {
    const account = [result.netlify.accountName, result.netlify.accountEmail && `<${result.netlify.accountEmail}>`].filter(Boolean).join(' ')
    console.log(`Netlify account: ${account}`)
  }
  console.log(`Netlify link: ${result.netlify.status}`)
  console.log(`GitHub Actions: ${result.githubActions ? 'enabled' : 'skipped'}`)
  if (result.workflow) {
    console.log(`Workflow: ${path.relative(result.projectRoot, result.workflow.path)} (${result.workflow.status})`)
  }
  for (const secret of result.secrets) {
    const reason = secret.reason ? `: ${secret.reason}` : ''
    console.log(`Secret: ${secret.name} (${secret.status}${reason})`)
  }
}

/**
 * Decides whether `nax init` should enable GitHub Actions setup.
 * @param {import('./options').CliOptions} options
 * @param {GithubActionsSetupPromptContext} [context]
 * @param {InitCliDependencies} [dependencies]
 * @returns {Promise<boolean>}
 */
async function shouldEnableGithubActions(options, { projectRoot } = {}, { loadClack = defaultLoadClack } = {}) {
  if (options.githubActions === true) return true
  if (options.githubActions === false) return false
  const root = projectRoot || options.projectRoot || process.cwd()
  const detected = findExistingAgentRunnerWorkflow(root)
  if (detected) {
    const relative = path.relative(root, detected.path) || detected.path
    console.log(`Detected existing Netlify Agent Runner workflow: ${relative}`)
    return true
  }
  if (!process.stdin.isTTY || options.yes) return true
  const clack = await loadClack()
  const selected = await clack.confirm({
    message: 'Install the Netlify Agent Runner GitHub Actions workflow for this repo?',
    initialValue: true,
  })
  if (clack.isCancel(selected)) process.exit(0)
  return selected === true
}

/**
 * Handles the `nax init` command.
 * @param {import('./options').CliOptions} options
 * @param {InitCliDependencies} [dependencies]
 * @returns {Promise<void>}
 */
async function handleInit(options, dependencies = {}) {
  const site = initSite({
    projectRoot: options.projectRoot || process.cwd(),
    repo: options.repo,
    siteId: options.siteId,
    siteName: options.siteName,
    create: options.create === true,
    dryRun: options.dryRun === true,
  })
  const githubActions = await shouldEnableGithubActions(options, { projectRoot: site.projectRoot }, dependencies)
  if (!githubActions) {
    printInitResult(site, { dryRun: options.dryRun })
    return
  }

  const result = enableGitHubActionsSetup({
    projectRoot: site.projectRoot,
    repo: options.repo,
    netlify: site.netlify,
    siteId: options.siteId,
    force: options.force === true || options.yes === true,
    dryRun: options.dryRun === true,
    skipSecrets: options.skipSecrets === true,
  })
  printInitResult(result, { dryRun: options.dryRun })
}

module.exports = {
  handleInit,
  printInitResult,
  shouldEnableGithubActions,
}
