const path = require('path')
const {
  enableGitHubActionsSetup,
  findExistingAgentRunnerWorkflow,
  initSite,
} = require('../../integrations/netlify/init')
const { installSkills } = require('../../integrations/skills')

const INIT_SKILL_PROVIDER_CHOICES = [
  { value: '.codex', label: 'Codex' },
  { value: '.claude', label: 'Claude' },
  { value: '.cursor', label: 'Cursor' },
  { value: '.gemini', label: 'Gemini' },
]

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
 *   multiselect?: (input: {
 *     message: string,
 *     options: Array<{ value: string, label: string }>,
 *     required?: boolean,
 *   }) => Promise<string[] | symbol>,
 *   select?: (input: {
 *     message: string,
 *     options: Array<{ value: string, label: string }>,
 *   }) => Promise<string | symbol>,
 *   isCancel: (value: unknown) => boolean,
 * }} ClackConfirmApi
 *
 * Dependencies injected into init command handlers.
 * @typedef {{
 *   loadClack?: () => Promise<ClackConfirmApi>,
 *   installSkills?: typeof import('../../integrations/skills').installSkills,
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
 * Prints skills installed from init.
 * @param {ReturnType<typeof installSkills>} results
 * @returns {void}
 */
function printInitSkillResults(results) {
  for (const result of results) {
    const relative = path.join(result.provider, 'skills', result.skill)
    console.log(`Skill: ${relative} (${result.status})`)
  }
}

/**
 * Prompts for optional bundled skill installation after repository setup.
 * @param {string} projectRoot
 * @param {import('./options').CliOptions} options
 * @param {InitCliDependencies} [dependencies]
 * @returns {Promise<void>}
 */
async function maybeInstallInitSkills(projectRoot, options, {
  loadClack = defaultLoadClack,
  installSkills: install = installSkills,
} = {}) {
  if (!process.stdin.isTTY || options.dryRun === true) return
  const clack = await loadClack()
  let selected
  if (typeof clack.multiselect === 'function') {
    selected = await clack.multiselect({
      message: 'Install nax workflow skills for local agents?',
      options: INIT_SKILL_PROVIDER_CHOICES,
      required: false,
    })
  } else if (typeof clack.select === 'function') {
    selected = await clack.select({
      message: 'Install nax workflow skills for local agents?',
      options: [
        ...INIT_SKILL_PROVIDER_CHOICES,
        { value: 'skip', label: 'Skip' },
      ],
    })
  } else {
    return
  }
  if (clack.isCancel(selected)) process.exit(0)
  const providers = Array.isArray(selected)
    ? selected.filter((provider) => typeof provider === 'string')
    : (typeof selected === 'string' && selected !== 'skip' ? [selected] : [])
  if (providers.length === 0) return
  printInitSkillResults(install({
    projectRoot,
    providers,
    skill: 'nax-workflows',
    dryRun: false,
  }))
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
    await maybeInstallInitSkills(site.projectRoot, options, dependencies)
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
  await maybeInstallInitSkills(result.projectRoot, options, dependencies)
}

module.exports = {
  handleInit,
  maybeInstallInitSkills,
  printInitResult,
  shouldEnableGithubActions,
}
