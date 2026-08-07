// Agent-instance resolution for the Arena program (nax-2rx6). Turns a workflow/CLI/dashboard
// lineup (string-or-object entries with fan-out) into a unique, validated list of resolved
// {agent, model, effort} instances via the two-pass intent -> transport -> resolve pipeline.
const {
  AUTO_CONFIGURATION_VALUE,
  SUPPORTED_AGENT_PROVIDERS,
  catalogModel,
  getBestModelForProvider,
  normalizeAgentProvider,
  validateAgentConfig,
} = require('./configuration')

const LATEST_ALIASES = new Set(['latest', 'default'])
const EFFORT_RANK = { low: 1, medium: 2, high: 3, max: 4 }

/**
 * @typedef {'claude'|'gemini'|'codex'|'opencode'} AgentProvider
 * @typedef {'latest'|'default'|'open'|'pinned'} InstanceProvenance
 * @typedef {{
 *   agent: AgentProvider,
 *   model?: string,
 *   effort?: string,
 *   id: string,
 *   label?: string,
 *   resolvedFrom: InstanceProvenance,
 *   wireEffort?: string,
 * }} AgentInstance
 * @typedef {{ code: string, message: string }} ResolveWarning
 * @typedef {{
 *   instances: AgentInstance[],
 *   transport: string,
 *   forcedNetlifyApi: boolean,
 *   warnings: ResolveWarning[],
 * }} ResolvedLineup
 */

/** Structured error for lineup resolution. @param {string} code @param {string} message */
function instanceError(code, message) {
  return Object.assign(new Error(message), { code })
}

/**
 * Stable, tuple-derived, label-independent instance id.
 * @param {string} agent @param {string|undefined} model @param {string|undefined} effort
 * @returns {string}
 */
function agentInstanceId(agent, model, effort) {
  return `${agent}:${model || AUTO_CONFIGURATION_VALUE}:${effort || AUTO_CONFIGURATION_VALUE}`
}

/** @param {unknown} value @returns {string|undefined} */
function cleaned(value) {
  const text = String(value == null ? '' : value).trim()
  if (!text || text.toLowerCase() === AUTO_CONFIGURATION_VALUE) return undefined
  return text
}

/**
 * Expand one lineup entry (string or object, possibly with models/efforts lists) into the
 * cartesian set of intent descriptors (transport-independent).
 * @param {string|Record<string, unknown>} entry
 * @returns {Array<{ agent: string, model?: string, effort?: string, label?: string }>}
 */
function expandEntry(entry) {
  if (typeof entry === 'string') {
    const agent = normalizeAgentProvider(entry)
    if (!agent) throw instanceError('unsupported_agent', `Unsupported agent provider "${entry}".`)
    return [{ agent }]
  }
  if (!entry || typeof entry !== 'object') {
    throw instanceError('invalid_lineup_entry', `Lineup entry must be a provider string or object; got ${JSON.stringify(entry)}.`)
  }
  const agent = normalizeAgentProvider(String(entry.agent || ''))
  if (!agent) throw instanceError('unsupported_agent', `Unsupported agent provider "${entry.agent}".`)
  const models = Array.isArray(entry.models)
    ? entry.models.map((m) => String(m))
    : (entry.model !== undefined ? [String(entry.model)] : [undefined])
  const efforts = Array.isArray(entry.efforts)
    ? entry.efforts.map((e) => String(e))
    : (entry.effort !== undefined ? [String(entry.effort)] : [undefined])
  const label = entry.label !== undefined ? String(entry.label) : undefined
  /** @type {Array<{ agent: string, model?: string, effort?: string, label?: string }>} */
  const out = []
  for (const model of models) {
    for (const effort of efforts) {
      out.push({ agent, model, effort, ...(label !== undefined ? { label } : {}) })
    }
  }
  return out
}

/** Is a model value a pinned intent (concrete id or latest alias)? */
function isPinnedModel(model) {
  const m = cleaned(model)
  return Boolean(m) // both concrete and `latest` are pinned intent; only Auto/undefined is open
}

/**
 * Clamp an effort to the nearest supported effort for a known model (round up on ties).
 * @returns {{ effort?: string, warning?: ResolveWarning }}
 */
function clampEffortForModel(agent, model, effort) {
  const wanted = cleaned(effort)
  if (!wanted) return { effort: undefined }
  const known = catalogModel(model)
  if (!known || known.provider.id !== agent) return { effort: wanted } // unknown model → validate/pass-through
  const supported = known.model.efforts
  if (supported.length === 0) {
    return {
      effort: undefined,
      warning: { code: 'effort_unavailable', message: `Model "${model}" exposes no reasoning effort; using Auto.` },
    }
  }
  if (supported.some((e) => e.id === wanted)) return { effort: wanted }
  const wantRank = EFFORT_RANK[wanted]
  if (wantRank == null) return { effort: wanted } // unknown effort token → let validation decide
  const ranked = supported
    .map((e) => ({ id: e.id, rank: EFFORT_RANK[e.id] ?? Infinity }))
    .sort((a, b) => a.rank - b.rank)
  const up = ranked.find((e) => e.rank >= wantRank) || ranked[ranked.length - 1]
  return {
    effort: up.id,
    warning: { code: 'effort_clamped', message: `Effort "${wanted}" is unsupported by "${model}"; clamped to "${up.id}".` },
  }
}

/**
 * Resolve a lineup into unique, validated agent instances (two-pass: intent -> transport -> resolve).
 *
 * @param {Array<string|Record<string, unknown>>} lineup
 * @param {{
 *   requestedTransport?: string,
 *   models?: Record<string, string>,
 *   efforts?: Record<string, string>,
 * }} [options]
 * @returns {ResolvedLineup}
 */
function resolveLineup(lineup, { requestedTransport = 'auto', models = {}, efforts = {} } = {}) {
  if (!Array.isArray(lineup)) throw instanceError('invalid_lineup', 'Lineup must be an array of entries.')

  // ---- Pass 1: normalize intent (transport-independent) ----
  const entries = lineup.map((entry) => expandEntry(entry))
  const flat = entries.flat()

  // Legacy bridge: provider-keyed models/efforts maps apply to OPEN (bare) instances,
  // single-per-provider. A provider used more than once makes the map ambiguous.
  const mapProviders = new Set([...Object.keys(models || {}), ...Object.keys(efforts || {})])
  if (mapProviders.size) {
    const counts = {}
    for (const it of flat) counts[it.agent] = (counts[it.agent] || 0) + 1
    for (const agent of mapProviders) {
      if ((counts[agent] || 0) > 1) {
        throw instanceError('ambiguous_provider_map', `Provider "${agent}" appears more than once in this step; its models/efforts map entry is ambiguous. Put the model/effort inline on each object entry instead.`)
      }
    }
    for (const it of flat) {
      if (!cleaned(it.model) && models && models[it.agent] != null) it.model = String(models[it.agent])
      if (!cleaned(it.effort) && efforts && efforts[it.agent] != null) it.effort = String(efforts[it.agent])
    }
  }

  const providerCounts = {}
  let anyPinnedIntent = false
  for (const it of flat) {
    providerCounts[it.agent] = (providerCounts[it.agent] || 0) + 1
    if (isPinnedModel(it.model) || cleaned(it.effort)) anyPinnedIntent = true
  }
  const multiPerProvider = Object.values(providerCounts).some((n) => n > 1)

  // ---- Pass 2: choose transport from intent ----
  const forcedNetlifyApi = anyPinnedIntent || multiPerProvider
  const isGithub = requestedTransport === 'github' || requestedTransport === 'github-actions'
  if (isGithub && forcedNetlifyApi) {
    throw instanceError(
      'github_transport_unsupported',
      'The GitHub Action transport supports provider selection only. Pinned model/effort or multiple instances per provider require the Netlify API transport (GitHub support arrives once the Action is updated).',
    )
  }
  const transport = forcedNetlifyApi ? 'netlify-api' : requestedTransport

  // ---- Pass 3: resolve each instance (transport-aware for open) ----
  /** @type {AgentInstance[]} */
  const instances = []
  /** @type {ResolveWarning[]} */
  const warnings = []
  const seen = new Map()

  for (const entryInstances of entries) {
    const localIds = new Set()
    for (const intent of entryInstances) {
      const { agent } = intent
      const rawModel = cleaned(intent.model)
      /** @type {InstanceProvenance} */
      let resolvedFrom
      /** @type {string|undefined} */
      let model
      if (!rawModel) {
        // OPEN: Auto on the wire regardless of transport (this is what removes the circularity).
        model = undefined
        resolvedFrom = 'open'
      } else if (LATEST_ALIASES.has(rawModel.toLowerCase())) {
        const best = getBestModelForProvider(agent)
        model = best === AUTO_CONFIGURATION_VALUE ? undefined : best
        resolvedFrom = rawModel.toLowerCase() === 'default' ? 'default' : 'latest'
      } else {
        model = rawModel
        resolvedFrom = 'pinned'
      }

      // Effort: clamp to nearest supported for a known model; Auto when open/none.
      let effort
      if (model) {
        const clamped = clampEffortForModel(agent, model, intent.effort)
        effort = clamped.effort
        if (clamped.warning) warnings.push(clamped.warning)
      } else {
        effort = undefined // open model cannot pin effort
      }

      // Validate + derive wire effort (max -> xhigh) via the shared validator.
      const validated = validateAgentConfig({ agent, model, effort })
      for (const w of validated.warnings || []) warnings.push({ code: 'catalog_passthrough', message: w })
      const wireEffort = validated.effort

      const id = agentInstanceId(agent, model, effort)
      if (localIds.has(id)) continue // silent dedupe within one fan-out entry (e.g. clamp collapse)
      localIds.add(id)
      if (seen.has(id)) {
        throw instanceError('duplicate_instance', `Duplicate agent instance "${id}" in the same step. Vary the model/effort; identical repeats are not supported (see issue #45).`)
      }
      /** @type {AgentInstance} */
      const instance = {
        agent: /** @type {AgentProvider} */ (agent),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        id,
        resolvedFrom,
        ...(intent.label !== undefined ? { label: intent.label } : {}),
        ...(wireEffort && wireEffort !== effort ? { wireEffort } : {}),
      }
      seen.set(id, instance)
      instances.push(instance)
    }
  }

  return { instances, transport, forcedNetlifyApi, warnings }
}

module.exports = {
  agentInstanceId,
  expandEntry,
  clampEffortForModel,
  resolveLineup,
}
