const path = require('path')

const {
  listLinkedNetlifySites,
  listNetlifyFilterCandidates,
  resolveNetlifyProjectTarget,
} = require('./local-runner')
const { chooseNetlifyFilterOption } = require('./project-selection')
const { checkNetlifyAccess } = require('./preflight')
const { readTargetPreference } = require('./target-preference')

/**
 * @typedef {{
 *   siteId: string,
 *   name: string,
 *   adminUrl: string,
 *   source: string,
 *   configSource: string,
 *   filter: string,
 *   accessible: boolean,
 *   accessCode: string,
 * }} DashboardLinkedSite
 *
 * @typedef {{
 *   siteId: string,
 *   name: string,
 *   adminUrl: string,
 *   source: string,
 *   configSource: string,
 *   filter: string,
 *   reason: string,
 *   accessible: boolean,
 *   accessCode: string,
 * }} DashboardNetlifyTarget
 *
 * @typedef {{
 *   account: { email: string } | null,
 *   linkedSites: DashboardLinkedSite[],
 *   target: DashboardNetlifyTarget | null,
 *   targetError: string,
 *   targetAccess: import('./preflight').NetlifyAccessVerdict | null,
 * }} DashboardNetlifyContext
 */

/** @param {string} name */
function agentRunsAdminUrl(name) {
  return name ? `https://app.netlify.com/projects/${encodeURIComponent(name)}/agent-runs` : ''
}

/**
 * @param {import('./local-runner').NetlifyTargetCandidate[]} candidates
 * @param {{ siteId?: string, siteSource?: string, configSource?: string, filter?: string }} target
 */
function automaticTargetReason(candidates, target) {
  const candidate = candidates.find((item) =>
    (target.siteId && item.siteId === target.siteId) ||
    (target.configSource && item.source === target.configSource) ||
    (target.filter && item.filter === target.filter))
  if (target.siteSource === 'env') return 'Selected from NETLIFY_SITE_ID.'
  if (target.siteSource === 'option') return 'Selected from the explicit dashboard site option.'
  if (candidate && candidates.length === 1) {
    return `Auto-selected ${candidate.source} because it is the only detected Netlify project.`
  }
  const filteredCandidates = candidates.filter((item) => item.filter)
  if (candidate?.filter && filteredCandidates.length === 1) {
    return `Auto-selected ${candidate.source} because it is the only detected config with a monorepo filter (--filter ${candidate.filter}).`
  }
  if (target.siteSource) return `Selected from ${target.siteSource}.`
  return 'Resolved from the repository Netlify configuration.'
}

/**
 * Resolves the same non-interactive Netlify target used by dashboard-launched
 * workflows, then enriches every local site link with its Netlify API name.
 *
 * @param {{
 *   projectRoot?: string,
 *   invocationDir?: string,
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 *   chooseTarget?: typeof chooseNetlifyFilterOption,
 *   resolveTarget?: typeof resolveNetlifyProjectTarget,
 *   checkAccess?: typeof checkNetlifyAccess,
 * }} [options]
 * @returns {Promise<DashboardNetlifyContext>}
 */
async function resolveDashboardNetlifyContext({
  projectRoot = process.cwd(),
  invocationDir = process.cwd(),
  env = process.env,
  timeoutMs = 3000,
  chooseTarget = chooseNetlifyFilterOption,
  resolveTarget = resolveNetlifyProjectTarget,
  checkAccess = checkNetlifyAccess,
} = {}) {
  const root = path.resolve(projectRoot)
  const links = listLinkedNetlifySites(root)
  const candidates = listNetlifyFilterCandidates(root)
  let resolvedTarget = null
  let targetError = ''
  let preferredSelected = false

  // A target chosen in the dashboard wins over auto-resolution and sidesteps
  // the multiple-config ambiguity. Only honor it while its link still exists.
  const preferred = readTargetPreference(root)
  const preferredLink = preferred ? links.find((link) => link.siteId === preferred.siteId) : null

  if (preferredLink) {
    const candidate = candidates.find((item) => item.stateSource === preferredLink.source)
    preferredSelected = true
    resolvedTarget = {
      siteId: preferredLink.siteId,
      filter: preferred?.filter || candidate?.filter || '',
      siteSource: preferredLink.source,
      configSource: preferred?.source || candidate?.source || '',
    }
  } else {
    try {
      const selected = await chooseTarget({
        projectRoot: root,
        invocationDir,
        options: { yes: true },
      })
      const target = resolveTarget({
        projectRoot: root,
        siteId: selected.netlifySiteId,
        filter: selected.filter,
        netlifyConfig: selected.netlifyConfig,
        env,
      })
      resolvedTarget = {
        ...target,
        siteSource: selected.netlifySiteSource || target.siteSource,
        configSource: selected.netlifyConfig || target.configSource,
      }
    } catch (error) {
      if (error?.code === 'multiple_netlify_configs') {
        const count = error.candidates?.length || candidates.length
        targetError = `Found ${count} Netlify apps in this repo, so no single Agent Runner target was auto-selected. Choose one from the linked sites below, or start nax with --filter <app>.`
      } else {
        targetError = error?.message || String(error || 'Could not resolve the Agent Runner site.')
      }
    }
  }

  const siteIds = [...new Set([
    ...links.map((link) => link.siteId),
    ...(resolvedTarget?.siteId ? [resolvedTarget.siteId] : []),
  ])]
  const verdictEntries = await Promise.all(siteIds.map(async (siteId) => {
    const verdict = await checkAccess({
      projectRoot: root,
      siteId,
      env,
      timeoutMs,
    })
    return /** @type {const} */ ([siteId, verdict])
  }))
  const verdicts = new Map(verdictEntries)
  const account = verdictEntries.find(([, verdict]) => verdict.account)?.[1].account || null

  const linkedSites = links.map((link) => {
    const verdict = verdicts.get(link.siteId)
    const candidate = candidates.find((item) => item.stateSource === link.source)
    const name = verdict?.site?.name || link.siteId
    return {
      siteId: link.siteId,
      name,
      adminUrl: agentRunsAdminUrl(verdict?.site?.name || ''),
      source: link.source,
      configSource: candidate?.source || '',
      filter: candidate?.filter || '',
      accessible: verdict?.ok === true,
      accessCode: verdict?.code || 'network_error',
    }
  }).sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source))

  let target = null
  let targetAccess = null
  if (resolvedTarget?.siteId) {
    targetAccess = verdicts.get(resolvedTarget.siteId) || null
    const name = targetAccess?.site?.name || resolvedTarget.siteId
    target = {
      siteId: resolvedTarget.siteId,
      name,
      adminUrl: agentRunsAdminUrl(targetAccess?.site?.name || ''),
      source: resolvedTarget.siteSource || '',
      configSource: resolvedTarget.configSource || '',
      filter: resolvedTarget.filter || '',
      reason: preferredSelected ? 'selected in dashboard' : automaticTargetReason(candidates, resolvedTarget),
      accessible: targetAccess?.ok === true,
      accessCode: targetAccess?.code || 'network_error',
    }
  } else if (!targetError) {
    targetError = 'No linked Netlify site could be resolved for Agent Runner execution.'
  }

  return {
    account,
    linkedSites,
    target,
    targetError,
    targetAccess,
  }
}

/** @param {DashboardNetlifyContext} context */
function formatDashboardNetlifyContext(context) {
  const lines = []
  lines.push(`Netlify account: ${context.account?.email || 'not verified'}`)
  if (context.target) {
    lines.push(`Agent Runner site: ${context.target.name} (${context.target.source || 'resolved configuration'})`)
    lines.push(`Selection reason:  ${context.target.reason}`)
  } else {
    lines.push(`Agent Runner site: ⚠️  ${context.targetError || 'not resolved'}`)
  }
  lines.push(`Linked sites:      ${context.linkedSites.length}`)
  for (const site of context.linkedSites) {
    const target = context.target?.siteId === site.siteId ? ' ← Agent Runner target' : ''
    const access = site.accessible ? '' : ` [${site.accessCode}]`
    lines.push(`  ${site.name} — ${site.source}${target}${access}`)
  }
  return lines
}

module.exports = {
  agentRunsAdminUrl,
  automaticTargetReason,
  formatDashboardNetlifyContext,
  resolveDashboardNetlifyContext,
}
