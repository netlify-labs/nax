const { setBlob, deleteBlob } = require('../../integrations/netlify/blobs')
const { addRunBlobRef, cleanupRunBlobRefs } = require('../../storage/local/blob-ref-registry')
const { writeLocalBlobDebugPayload } = require('../../storage/local/blob-debug-cache')
const {
  blobRefForStep,
  buildBlobPayload,
  buildFetchInstruction,
  buildInlineEssentials,
  classifyContextFetch,
  compactTextByBytes,
  safePromptBytes,
} = require('../prompts/offload')
const { extractStructuredSection, formatRoundResults } = require('../round-results')
const { resolveNetlifyProjectTarget } = require('../../integrations/netlify/local-runner')
const { githubResultsToSourceRuns } = require('../../integrations/github/issue-plan')
const { titleCase } = require('../catalog/prompts')
const {
  githubSafePromptBytes: githubSafePromptBytesWithLocalBudget,
  utf8ByteLength,
} = require('../../core/prompts/budget')

const COMPACT_LOCAL_RESULT_CHAR_LIMIT = 6000
const COMPACT_LOCAL_RESULTS_TOTAL_LIMIT = 36000
const COMPACT_LOCAL_CONTEXT_CHAR_LIMIT = 12000
const DEFAULT_LOCAL_SAFE_PROMPT_BYTES = 16384

/**
 * Prompt sizing and Netlify targeting options used by prompt delivery.
 * @typedef {import('../../types').JsonMap & {
 *   safePromptBytes?: number | string,
 *   promptSafeBytes?: number | string,
 *   promptBlobDisable?: boolean,
 *   netlifySiteId?: string,
 *   filter?: string,
 *   netlifyConfig?: string,
 *   contextFetchPolicy?: string,
 * }} PromptDeliveryOptions
 *
 * Netlify site context used for prompt blob operations.
 * @typedef {{
 *   siteId?: string,
 *   env?: NodeJS.ProcessEnv,
 *   configDir?: string,
 * }} PromptNetlifyContext
 *
 * Workflow step shape needed by prompt delivery.
 * @typedef {import('../../types').WorkflowStep & {
 *   contextFetchPolicy?: string,
 * }} PromptWorkflowStep
 *
 * Agent run shape rendered into local prompt context.
 * @typedef {import('../prompts/offload').PromptOffloadRun & {
 *   transcript?: string,
 *   commandTranscript?: string,
 *   commandOutput?: string,
 *   fetchExitCode?: number | null,
 *   fetchError?: string,
 * }} PromptSourceRun
 */

/**
 * Prompt loaded from a workflow prompt file.
 * @typedef {{
 *   name?: string,
 *   title?: string,
 *   instruction?: string,
 *   body?: string,
 * }} PromptDefinition
 *
 * GitHub issue descriptor whose body may be offloaded.
 * @typedef {import('../../types').JsonMap & {
 *   model?: string,
 *   promptName?: string,
 *   targetKind?: string,
 *   targetNumber?: string | number,
 *   issueNumber?: string | number,
 *   title?: string,
 *   issueTitle?: string,
 *   body?: string,
 *   promptDelivery?: import('../../types').JsonMap,
 * }} GithubPromptIssue
 *
 * Retry notice emitted while writing prompt blobs.
 * @typedef {{
 *   nextAttempt: number,
 *   attempts: number,
 *   delayMs: number,
 *   error: Error,
 *   store?: string,
 *   key?: string,
 * }} BlobRetryEvent
 *
 * Callback notified before retrying one prompt blob write.
 * @typedef {(event: BlobRetryEvent) => void} BlobRetryHandler
 */

/**
 * Options for resolving Netlify context used by blob offload.
 * @typedef {{
 *   projectRoot?: string,
 *   options?: PromptDeliveryOptions,
 * }} OptionalNetlifyForBlobOffloadInput
 *
 * Options for offloading a full GitHub prompt body.
 * @typedef {{
 *   issue?: GithubPromptIssue,
 *   promptBody?: string,
 *   runState?: import('../../types').WorkflowRunState,
 *   stepState?: PromptWorkflowStep,
 *   step?: PromptWorkflowStep,
 *   projectRoot?: string,
 *   netlify?: PromptNetlifyContext,
 *   options?: PromptDeliveryOptions,
 *   dryRun?: boolean,
 * }} GithubIssueFullPromptBlobOffloadInput
 *
 * Options for offloading GitHub prior-round results.
 * @typedef {{
 *   results?: import('../../types').GitHubIssue[],
 *   fullRoundResults?: string,
 *   runState?: import('../../types').WorkflowRunState,
 *   stepState?: PromptWorkflowStep,
 *   step?: PromptWorkflowStep,
 *   projectRoot?: string,
 *   netlify?: PromptNetlifyContext,
 *   options?: PromptDeliveryOptions,
 *   dryRun?: boolean,
 * }} GithubPlanBlobOffloadInput
 */

/**
 * Options for writing one local workflow prompt blob.
 * @typedef {{
 *   sourceRuns?: PromptSourceRun[],
 *   roundResults?: string,
 *   payloadText?: string,
 *   refKind?: string,
 *   refStepId?: string,
 *   runState?: import('../../types').WorkflowRunState,
 *   stepState?: PromptWorkflowStep,
 *   step?: PromptWorkflowStep,
 *   projectRoot?: string,
 *   netlify?: PromptNetlifyContext,
 *   options?: PromptDeliveryOptions,
 *   dryRun?: boolean,
 *   onRetry?: BlobRetryHandler,
 * }} StepBlobOffloadInput
 *
 * Options for building a compact local prompt.
 * @typedef {{
 *   agent?: string,
 *   prompt: PromptDefinition,
 *   stepContext?: string,
 *   sourceRuns?: PromptSourceRun[],
 *   safeBytes: number,
 * }} SafeCompactLocalPromptInput
 *
 * Options for rendering offloaded prior-round context.
 * @typedef {{
 *   sourceRuns?: PromptSourceRun[],
 *   blobRef?: import('../../types').BlobRef,
 *   safeBytes: number,
 * }} OffloadedRoundResultsInput
 */

/**
 * Options for offloading a complete local agent prompt.
 * @typedef {{
 *   agent?: string,
 *   promptText?: string,
 *   runState?: import('../../types').WorkflowRunState,
 *   stepState?: PromptWorkflowStep,
 *   step?: PromptWorkflowStep,
 *   projectRoot?: string,
 *   netlify?: PromptNetlifyContext,
 *   options?: PromptDeliveryOptions,
 *   dryRun?: boolean,
 *   onRetry?: BlobRetryHandler,
 * }} FullPromptBlobOffloadInput
 *
 * Options for preparing local prompt delivery.
 * @typedef {{
 *   agent?: string,
 *   prompt?: PromptDefinition,
 *   step?: PromptWorkflowStep,
 *   sourceRuns?: PromptSourceRun[],
 *   roundResults?: string,
 *   stepContext?: string,
 *   runState?: import('../../types').WorkflowRunState,
 *   stepState?: PromptWorkflowStep,
 *   projectRoot?: string,
 *   netlify?: PromptNetlifyContext,
 *   options?: PromptDeliveryOptions,
 *   dryRun?: boolean,
 * }} PrepareLocalPromptDeliveryInput
 *
 * Options for cleaning prompt blobs after a workflow run.
 * @typedef {{
 *   runState?: import('../../types').WorkflowRunState,
 *   projectRoot?: string,
 *   netlify?: PromptNetlifyContext,
 *   options?: PromptDeliveryOptions,
 *   reason?: string,
 * }} CleanupWorkflowBlobsInput
 */

/** @param {PromptDeliveryOptions} [options] */
function githubSafePromptBytes(options = {}) {
  return githubSafePromptBytesWithLocalBudget(options, { localSafePromptBytes })
}

/** @param {GithubPromptIssue} [issue] */
function githubIssueDeliveryKey(issue = {}) {
  return [
    issue.model || '',
    issue.promptName || '',
    issue.targetKind || '',
    issue.targetNumber || issue.issueNumber || '',
    issue.title || issue.issueTitle || '',
  ].join(':')
}

/**
 * @param {{
 *   runner?: string,
 *   model?: string,
 *   blobRef?: import('../../types').BlobRef,
 * }} param0
 */
function buildGithubFullPromptWrapper({ runner = '@netlify', model, blobRef }) {
  return [
    `${runner} ${model || 'agent'} fetch and follow the complete offloaded prompt before doing any other work.`,
    '',
    buildFullPromptWrapper({ blobRef }),
  ].join('\n')
}

/** @param {OptionalNetlifyForBlobOffloadInput} [input] */
function optionalNetlifyForBlobOffload({ projectRoot, options = {} } = {}) {
  try {
    return resolveNetlifyProjectTarget({
      projectRoot,
      siteId: options.netlifySiteId,
      filter: options.filter,
      netlifyConfig: options.netlifyConfig,
    })
  } catch {
    return null
  }
}

/** @param {PromptNetlifyContext | null | undefined} netlify */
function blobOffloadContextError(netlify) {
  if (!netlify?.siteId) return 'Netlify site context is required for prompt blob offload. Run nax init or set NETLIFY_SITE_ID.'
  if (!netlify?.env?.NETLIFY_AUTH_TOKEN) return 'NETLIFY_AUTH_TOKEN is required for prompt blob offload. Run netlify login or set NETLIFY_AUTH_TOKEN.'
  return ''
}

/** @param {GithubIssueFullPromptBlobOffloadInput} [input] */
function ensureGithubIssueFullPromptBlobOffload({
  issue,
  promptBody,
  runState,
  stepState,
  step,
  projectRoot,
  netlify,
  options = {},
  dryRun = false,
} = {}) {
  if (!netlify?.siteId) throw new Error('Netlify site context is required for GitHub full-prompt blob offload.')
  const effectiveRunState = runState || { runId: `github-${Date.now()}`, blobRefs: [] }
  const effectiveStepState = stepState || { id: step?.id || issue?.promptName || 'github' }
  return ensureStepBlobOffload({
    sourceRuns: [],
    roundResults: '',
    payloadText: promptBody,
    refKind: 'full-prompt',
    refStepId: [step?.id || issue?.promptName || 'github', issue?.model || 'agent'].join('-'),
    runState: effectiveRunState,
    stepState: effectiveStepState,
    step: step || { id: issue?.promptName || 'github' },
    projectRoot,
    netlify,
    options,
    dryRun,
    onRetry: ({ nextAttempt, attempts, delayMs, error, store, key }) => {
      const delaySeconds = Math.round(delayMs / 1000)
      console.log(`  Blob ${store}/${key}: retrying upload ${nextAttempt}/${attempts} in ${delaySeconds}s - ${error.message}`)
    },
  })
}

/**
 * @param {GithubPlanBlobOffloadInput} [input]
 * @returns {import('../../types').BlobRef & {
 *   sourceRuns: PromptSourceRun[],
 *   offloadedRoundResults: string,
 * }}
 */
function ensureGithubPlanBlobOffload({
  results,
  fullRoundResults,
  runState,
  stepState,
  step,
  projectRoot,
  netlify,
  options = {},
  dryRun = false,
} = {}) {
  if (!netlify?.siteId) throw new Error('Netlify site context is required for GitHub prompt blob offload.')
  const sourceRuns = githubResultsToSourceRuns(results)
  const seed = fullRoundResults || formatRoundResults({ heading: 'Prior Round Outputs', results })
  if (stepState?.promptBlobRef) {
    const safeBytes = githubSafePromptBytes(options)
    return {
      ...stepState.promptBlobRef,
      sourceRuns,
      offloadedRoundResults: buildOffloadedRoundResults({
        sourceRuns,
        blobRef: stepState.promptBlobRef,
        safeBytes,
      }),
    }
  }
  const ref = blobRefForStep({
    runId: runState?.runId || `github-${Date.now()}`,
    stepId: step?.id || 'github',
    payloadSeed: seed,
  })
  const blobPayload = buildBlobPayload({ fullResults: seed, sentinel: ref.sentinel })
  const localDebug = dryRun || !runState || !stepState
    ? {}
    : writeLocalBlobDebugPayload({
      runState,
      stepState,
      ref: { ...ref, kind: 'prior-results' },
      payload: blobPayload,
      kind: 'prior-results',
      projectRoot,
    })
  const refInput = {
    runId: runState?.runId || '',
    stepId: stepState?.id || step?.id || '',
    store: ref.store,
    key: ref.key,
    marker: ref.marker,
    sentinel: ref.sentinel,
    kind: 'prior-results',
    ...localDebug,
    status: 'active',
  }
  const entry = dryRun || !runState || !stepState
    ? {
        id: `${refInput.runId || ''}:${refInput.store}:${refInput.key}`,
        ...refInput,
        createdAt: new Date().toISOString(),
        cleanupAttempts: 0,
        lastCleanupError: '',
      }
    : addRunBlobRef(runState, stepState, refInput)
  if (dryRun && runState && stepState) {
    runState.blobRefs = [...(Array.isArray(runState.blobRefs) ? runState.blobRefs : []), entry]
    stepState.blobRefs = [...(Array.isArray(stepState.blobRefs) ? stepState.blobRefs : []), entry]
  }
  if (stepState) stepState.promptBlobRef = entry
  if (!dryRun) {
    setBlob({
      store: ref.store,
      key: ref.key,
      value: blobPayload,
      siteId: netlify.siteId,
      token: netlify.env?.NETLIFY_AUTH_TOKEN,
      cwd: netlify.configDir || projectRoot,
      env: netlify.env,
      onRetry: ({ nextAttempt, attempts, delayMs, error, store, key }) => {
        const delaySeconds = Math.round(delayMs / 1000)
        console.log(`  Blob ${store}/${key}: retrying upload ${nextAttempt}/${attempts} in ${delaySeconds}s - ${error.message}`)
      },
    })
  }
  const safeBytes = githubSafePromptBytes(options)
  return {
    ...entry,
    sourceRuns,
    offloadedRoundResults: buildOffloadedRoundResults({ sourceRuns, blobRef: entry, safeBytes }),
  }
}

/** @param {PromptSourceRun[]} runs */
function formatLocalRunResults(runs) {
  const completed = runs.filter((run) => run.resultText && run.resultText.trim())
  if (completed.length === 0) return ''

  const parts = ['## Prior Agent Results']
  for (const run of completed) {
    const source = run.sourceStep ? ` from ${run.sourceStep}` : ''
    const title = `${titleCase(run.agent || 'agent')}${source}`
    parts.push(
      '',
      `<details>`,
      `<summary>${title}</summary>`,
      '',
      run.resultText.trim(),
      '',
      `</details>`,
    )
  }
  return parts.join('\n')
}

/** @param {unknown} text @param {number} limit @param {string} [label] */
function compactTextForRetry(text, limit, label = 'content') {
  const value = String(text || '').trim()
  if (!value || value.length <= limit) return value
  if (limit < 200) return value.slice(0, limit).trim()

  const note = `\n\n[${label} compacted from ${value.length} chars for retry after Netlify runner argument limit. Middle omitted.]\n\n`
  const available = Math.max(0, limit - note.length)
  const headLength = Math.ceil(available * 0.65)
  const tailLength = Math.max(0, available - headLength)
  return `${value.slice(0, headLength).trimEnd()}${note}${value.slice(value.length - tailLength).trimStart()}`
}

/** @param {PromptDeliveryOptions} [options] */
function localSafePromptBytes(options = {}) {
  return safePromptBytes({
    safePromptBytes: Number(
      options.safePromptBytes || options.safePromptBytes === 0
        ? options.safePromptBytes
        : options.promptSafeBytes || process.env.NAX_SAFE_PROMPT_BYTES || DEFAULT_LOCAL_SAFE_PROMPT_BYTES,
    ),
  })
}

/** @param {unknown} text @param {number} limit @param {string} [label] */
function compactLocalTextByBytes(text, limit, label = 'content') {
  return compactTextByBytes(text, Math.max(0, Number(limit) || 0), label)
}

/**
 * @param {PromptSourceRun[]} runs
 * @param {{
 *   perRunLimit?: number,
 *   totalLimit?: number,
 * }} [options]
 */
function formatCompactLocalRunResults(runs, {
  perRunLimit = COMPACT_LOCAL_RESULT_CHAR_LIMIT,
  totalLimit = COMPACT_LOCAL_RESULTS_TOTAL_LIMIT,
} = {}) {
  const completed = runs.filter((run) => run.resultText && run.resultText.trim())
  if (completed.length === 0) return ''

  const parts = ['## Prior Agent Results']
  let used = utf8ByteLength(parts[0])
  for (let index = 0; index < completed.length; index += 1) {
    const run = completed[index]
    const source = run.sourceStep ? ` from ${run.sourceStep}` : ''
    const title = `${titleCase(run.agent || 'agent')}${source}`
    const blockPrefix = ['', `<details>`, `<summary>${title}</summary>`, ''].join('\n')
    const blockSuffix = ['', `</details>`].join('\n')
    const remaining = totalLimit - used
    const contentLimit = Math.min(perRunLimit, remaining - utf8ByteLength(blockPrefix) - utf8ByteLength(blockSuffix))
    if (contentLimit < 200) {
      parts.push('', `[${completed.length - index} prior results omitted to fit retry prompt size.]`)
      break
    }
    const content = compactLocalTextByBytes(run.resultText, contentLimit, `${title} result`)
    const block = [
      '',
      `<details>`,
      `<summary>${title}</summary>`,
      '',
      content,
      '',
      `</details>`,
    ].join('\n')
    parts.push(block)
    used += utf8ByteLength(block)
  }
  return compactLocalTextByBytes(parts.join('\n'), totalLimit, 'Prior Agent Results')
}

/**
 * @param {{
 *   model?: string,
 *   prompt: PromptDefinition,
 *   context?: string,
 *   roundResults?: string,
 * }} param0
 */
function buildLocalAgentPrompt({ model, prompt, context, roundResults }) {
  const summaryLabel = `${titleCase(prompt.name)} instructions`
  const parts = [
    `${titleCase(model)}: ${prompt.instruction}`.trim(),
    '',
    '<details>',
    `<summary>${summaryLabel}</summary>`,
    '',
    prompt.body,
    '',
    '</details>',
  ]

  if (roundResults && roundResults.trim()) {
    parts.push('', '---', '', roundResults.trim())
  }

  if (context && context.trim()) {
    parts.push('', '---', '', '## Additional Context', '', context.trim())
  }

  return parts.join('\n')
}

/** @param {string} resultText */
function renderStructuredForLocalEssentials(resultText) {
  const section = extractStructuredSection(resultText)
  if (!section) return ''
  return [
    section.heading,
    '',
    '```json',
    section.json,
    '```',
  ].join('\n')
}

/** @param {PromptDeliveryOptions} [options] */
function blobOffloadDisabled(options = {}) {
  return options.promptBlobDisable === true || process.env.NAX_PROMPT_BLOB_DISABLE === '1' || /^true$/i.test(process.env.NAX_PROMPT_BLOB_DISABLE || '')
}

/** @param {string} promptText @param {string} compactPromptText @param {number} safeBytes */
function localPromptByteMetrics(promptText, compactPromptText, safeBytes) {
  return {
    promptBytes: utf8ByteLength(promptText),
    compactPromptBytes: utf8ByteLength(compactPromptText),
    safePromptBytes: safeBytes,
  }
}

/** @param {StepBlobOffloadInput} input */
function ensureStepBlobOffload({
  sourceRuns,
  roundResults,
  payloadText,
  refKind = 'prior-results',
  refStepId,
  runState,
  stepState,
  step,
  projectRoot,
  netlify,
  options = {},
  dryRun = false,
  onRetry = () => {},
} = {}) {
  if (!dryRun) {
    const contextError = blobOffloadContextError(netlify)
    if (contextError) throw new Error(contextError)
  }
  const seed = payloadText || roundResults || formatLocalRunResults(sourceRuns)
  const ref = blobRefForStep({
    runId: runState.runId,
    stepId: refStepId || step.id,
    payloadSeed: seed,
    kind: refKind,
  })
  if (stepState.promptBlobRef?.store === ref.store && stepState.promptBlobRef?.key === ref.key) return stepState.promptBlobRef
  const blobPayload = buildBlobPayload({ fullResults: seed, sentinel: ref.sentinel })
  const localDebug = dryRun
    ? {}
    : writeLocalBlobDebugPayload({
      runState,
      stepState,
      ref: { ...ref, kind: refKind },
      payload: blobPayload,
      kind: refKind,
      projectRoot,
    })
  const refInput = {
    ...ref,
    kind: refKind,
    ...localDebug,
    status: dryRun ? 'dry-run' : 'active',
  }
  const entry = dryRun
    ? {
      id: `${runState.runId || ''}:${ref.store}:${ref.key}`,
      runId: runState.runId || '',
      stepId: stepState.id || '',
      ...refInput,
      createdAt: new Date().toISOString(),
      cleanupAttempts: 0,
      lastCleanupError: '',
    }
    : addRunBlobRef(runState, stepState, refInput)
  if (dryRun) {
    runState.blobRefs = [...(Array.isArray(runState.blobRefs) ? runState.blobRefs : []), entry]
    stepState.blobRefs = [...(Array.isArray(stepState.blobRefs) ? stepState.blobRefs : []), entry]
  }
  stepState.promptBlobRef = entry
  if (!dryRun) {
    setBlob({
      store: ref.store,
      key: ref.key,
      value: blobPayload,
      siteId: netlify.siteId,
      token: netlify.env?.NETLIFY_AUTH_TOKEN,
      cwd: netlify.configDir || projectRoot,
      env: netlify.env,
      onRetry,
    })
  }
  return entry
}

/** @param {SafeCompactLocalPromptInput} param0 */
function buildSafeCompactLocalPrompt({ agent, prompt, stepContext, sourceRuns = [], safeBytes }) {
  const basePrompt = buildLocalAgentPrompt({ model: agent, prompt, context: '', roundResults: '' })
  const remaining = Math.max(800, safeBytes - utf8ByteLength(basePrompt) - 400)
  const resultBudget = Math.floor(remaining * 0.7)
  const contextBudget = Math.max(0, remaining - resultBudget)
  const compactRoundResults = formatCompactLocalRunResults(sourceRuns, {
    totalLimit: resultBudget,
    perRunLimit: Math.max(500, Math.floor(resultBudget / Math.max(1, sourceRuns.length))),
  })
  const compactContext = compactLocalTextByBytes(stepContext, contextBudget, 'Additional Context')
  return buildLocalAgentPrompt({
    model: agent,
    prompt,
    context: compactContext,
    roundResults: compactRoundResults,
  })
}

/** @param {OffloadedRoundResultsInput} param0 */
function buildOffloadedRoundResults({ sourceRuns = [], blobRef, safeBytes }) {
  const essentialsBytes = Math.max(1200, Math.floor(safeBytes * 0.55))
  const inlineEssentials = buildInlineEssentials(sourceRuns, {
    renderStructured: renderStructuredForLocalEssentials,
    totalBytes: essentialsBytes,
  })
  const instruction = buildFetchInstruction(blobRef)
  return [inlineEssentials, instruction].filter(Boolean).join('\n\n')
}

/** @param {{ blobRef?: import('../../types').BlobRef }} param0 */
function buildFullPromptWrapper({ blobRef }) {
  return buildFetchInstruction({
    ...blobRef,
    kind: 'full-prompt',
  })
}

/** @param {FullPromptBlobOffloadInput} input */
function ensureFullPromptBlobOffload({
  agent,
  promptText,
  runState,
  stepState,
  step,
  projectRoot,
  netlify,
  options = {},
  dryRun = false,
  onRetry = () => {},
} = {}) {
  return ensureStepBlobOffload({
    sourceRuns: [],
    roundResults: '',
    payloadText: promptText,
    refKind: 'full-prompt',
    refStepId: [step?.id || 'step', agent || 'agent'].join('-'),
    runState,
    stepState,
    step,
    projectRoot,
    netlify,
    options,
    dryRun,
    onRetry,
  })
}

/** @param {PrepareLocalPromptDeliveryInput} input */
function prepareLocalPromptDelivery({
  agent,
  prompt,
  step,
  sourceRuns,
  roundResults,
  stepContext,
  runState,
  stepState,
  projectRoot,
  netlify,
  options = {},
  dryRun = false,
} = {}) {
  const safeBytes = localSafePromptBytes(options)
  const promptText = buildLocalAgentPrompt({
    model: agent,
    prompt,
    context: stepContext,
    roundResults,
  })
  const compactPromptText = buildSafeCompactLocalPrompt({
    agent,
    prompt,
    stepContext,
    sourceRuns,
    safeBytes,
  })
  const metrics = localPromptByteMetrics(promptText, compactPromptText, safeBytes)
  if (metrics.promptBytes <= safeBytes) {
    return {
      promptText,
      compactPromptText: metrics.compactPromptBytes < metrics.promptBytes ? compactPromptText : '',
      promptDelivery: { mode: 'inline', ...metrics },
    }
  }
  if (blobOffloadDisabled(options)) {
    if (metrics.compactPromptBytes <= safeBytes) {
      return {
        promptText: compactPromptText,
        compactPromptText,
        promptDelivery: {
          mode: 'compact',
          fallbackReason: 'blob-offload-disabled',
          ...metrics,
        },
      }
    }
    throw new Error([
      `Prompt for ${agent} ${step.id} is too large for Netlify runner argv and cannot be offloaded.`,
      `Full prompt: ${metrics.promptBytes.toLocaleString()} bytes.`,
      `Compact prompt: ${metrics.compactPromptBytes.toLocaleString()} bytes.`,
      `Safe budget: ${safeBytes.toLocaleString()} bytes.`,
      'Blob offload is disabled by NAX_PROMPT_BLOB_DISABLE.',
    ].join(' '))
  }
  const contextError = dryRun ? '' : blobOffloadContextError(netlify)
  if (contextError) {
    if (metrics.compactPromptBytes <= safeBytes) {
      return {
        promptText: compactPromptText,
        compactPromptText,
        promptDelivery: {
          mode: 'compact',
          fallbackReason: 'blob-context-missing',
          fallbackError: contextError,
          ...metrics,
        },
      }
    }
    throw new Error([
      `Prompt for ${agent} ${step.id} is too large for Netlify runner argv and cannot be offloaded.`,
      `Full prompt: ${metrics.promptBytes.toLocaleString()} bytes.`,
      `Compact prompt: ${metrics.compactPromptBytes.toLocaleString()} bytes.`,
      `Safe budget: ${safeBytes.toLocaleString()} bytes.`,
      contextError,
    ].join(' '))
  }
  let blobRef
  if (sourceRuns.length > 0) {
    try {
      blobRef = ensureStepBlobOffload({
        sourceRuns,
        roundResults,
        runState,
        stepState,
        step,
        projectRoot,
        netlify,
        options,
        dryRun,
        onRetry: ({ nextAttempt, attempts, delayMs, error, store, key }) => {
          const delaySeconds = Math.round(delayMs / 1000)
          console.log(`  Blob ${store}/${key}: retrying upload ${nextAttempt}/${attempts} in ${delaySeconds}s — ${error.message}`)
        },
      })
      const offloadedRoundResults = buildOffloadedRoundResults({ sourceRuns, blobRef, safeBytes })
      const offloadedContext = compactLocalTextByBytes(stepContext, Math.max(0, Math.floor(safeBytes * 0.2)), 'Additional Context')
      const offloadedPromptText = buildLocalAgentPrompt({
        model: agent,
        prompt,
        context: offloadedContext,
        roundResults: offloadedRoundResults,
      })
      const offloadedBytes = utf8ByteLength(offloadedPromptText)
      if (offloadedBytes <= safeBytes) {
        return {
          promptText: offloadedPromptText,
          compactPromptText: compactPromptText && metrics.compactPromptBytes <= safeBytes ? compactPromptText : '',
          promptDelivery: {
            mode: 'blob',
            kind: 'prior-results',
            ...metrics,
            offloadedPromptBytes: offloadedBytes,
            blobRef,
            contextFetchPolicy: options.contextFetchPolicy || step.contextFetchPolicy || 'optional',
          },
          blobRef,
        }
      }
    } catch (error) {
      if (metrics.compactPromptBytes <= safeBytes) {
        return {
          promptText: compactPromptText,
          compactPromptText,
          promptDelivery: {
            mode: 'compact',
            fallbackReason: 'blob-set-failed',
            fallbackError: error?.message || String(error),
            ...metrics,
          },
        }
      }
      throw new Error([
        `Prompt for ${agent} ${step.id} is too large and blob offload failed.`,
        `Full prompt: ${metrics.promptBytes.toLocaleString()} bytes.`,
        `Compact prompt: ${metrics.compactPromptBytes.toLocaleString()} bytes.`,
        `Safe budget: ${safeBytes.toLocaleString()} bytes.`,
        `Blob: ${stepState.promptBlobRef?.store || 'unknown'}/${stepState.promptBlobRef?.key || 'unknown'}.`,
        `Error: ${error?.message || String(error)}`,
      ].join(' '))
    }
  }

  try {
    blobRef = ensureFullPromptBlobOffload({
      agent,
      promptText,
      runState,
      stepState,
      step,
      projectRoot,
      netlify,
      options,
      dryRun,
      onRetry: ({ nextAttempt, attempts, delayMs, error, store, key }) => {
        const delaySeconds = Math.round(delayMs / 1000)
        console.log(`  Blob ${store}/${key}: retrying upload ${nextAttempt}/${attempts} in ${delaySeconds}s — ${error.message}`)
      },
    })
  } catch (error) {
    if (metrics.compactPromptBytes <= safeBytes) {
      return {
        promptText: compactPromptText,
        compactPromptText,
        promptDelivery: {
          mode: 'compact',
          fallbackReason: 'blob-set-failed',
          fallbackError: error?.message || String(error),
          ...metrics,
        },
      }
    }
    throw new Error([
      `Prompt for ${agent} ${step.id} is too large and full-prompt blob offload failed.`,
      `Full prompt: ${metrics.promptBytes.toLocaleString()} bytes.`,
      `Compact prompt: ${metrics.compactPromptBytes.toLocaleString()} bytes.`,
      `Safe budget: ${safeBytes.toLocaleString()} bytes.`,
      `Error: ${error?.message || String(error)}`,
    ].join(' '))
  }
  const offloadedPromptText = buildFullPromptWrapper({ blobRef })
  const offloadedBytes = utf8ByteLength(offloadedPromptText)
  if (offloadedBytes > safeBytes) {
    throw new Error([
      `Full-prompt wrapper for ${agent} ${step.id} still exceeds the safe Netlify runner budget.`,
      `Wrapper prompt: ${offloadedBytes.toLocaleString()} bytes.`,
      `Safe budget: ${safeBytes.toLocaleString()} bytes.`,
      `Blob: ${blobRef.store}/${blobRef.key}.`,
    ].join(' '))
  }
  return {
    promptText: offloadedPromptText,
    compactPromptText: compactPromptText && metrics.compactPromptBytes <= safeBytes ? compactPromptText : '',
    promptDelivery: {
      mode: 'blob',
      kind: 'full-prompt',
      ...metrics,
      offloadedPromptBytes: offloadedBytes,
      blobRef,
      contextFetchPolicy: options.contextFetchPolicy || step.contextFetchPolicy || 'optional',
    },
    blobRef,
  }
}

/** @param {PromptSourceRun} run */
function applyContextFetchClassification(run) {
  const ref = run.promptDelivery?.blobRef || run.blobRef
  if (!ref || !String(run.resultText || '').trim()) return run
  const classified = classifyContextFetch({
    reply: run.resultText,
    transcript: String(run.transcript || run.commandTranscript || run.rawResult?.transcript || run.raw?.transcript || ''),
    commandOutput: String(run.commandOutput || run.rawResult?.commandOutput || run.raw?.commandOutput || ''),
    fetchExitCode: Number(run.fetchExitCode ?? run.rawResult?.fetchExitCode ?? run.raw?.fetchExitCode ?? 0) || null,
    fetchError: String(run.fetchError || run.rawResult?.fetchError || run.raw?.fetchError || ''),
    marker: ref.marker,
    sentinel: ref.sentinel,
  })
  return {
    ...run,
    contextFetchStatus: classified.status,
    contextFetchSignals: classified.signals,
    contextFetchConfirmed: classified.confirmed,
    promptDelivery: {
      ...(run.promptDelivery || {}),
      contextFetchStatus: classified.status,
      contextFetchSignals: classified.signals,
      contextFetchConfirmed: classified.confirmed,
    },
  }
}

/** @param {import('../../types').WorkflowRunState} [runState] @param {import('../../types').BlobRef} [ref] */
function blobRefHasCompletedGithubConsumer(runState = {}, ref = {}) {
  if (runState.transport !== 'github') return true
  const refId = ref.id || `${ref.runId || ''}:${ref.store || ''}:${ref.key || ''}`
  let foundConsumer = false
  for (const step of runState.steps || []) {
    for (const run of step.runs || []) {
      const runRef = run.blobRef || run.promptDelivery?.blobRef
      const runRefId = runRef?.id || `${runRef?.runId || ''}:${runRef?.store || ''}:${runRef?.key || ''}`
      if (runRefId !== refId) continue
      foundConsumer = true
      if (run.contextFetchConfirmed === true || run.promptDelivery?.contextFetchConfirmed === true) return true
      if (['completed', 'failed', 'timeout', 'dry-run'].includes(String(run.status || ''))) return true
    }
  }
  return !foundConsumer
}

/** @param {CleanupWorkflowBlobsInput} [input] */
function cleanupLocalWorkflowBlobs({ runState, projectRoot, netlify, reason = 'flow-terminal' } = {}) {
  if (!Array.isArray(runState?.blobRefs) || runState.blobRefs.length === 0) return []
  const deferredRefs = runState.transport === 'github'
    ? runState.blobRefs.filter((ref) => !blobRefHasCompletedGithubConsumer(runState, ref))
    : []
  const cleanupState = deferredRefs.length > 0
    ? {
        ...runState,
        blobRefs: runState.blobRefs.filter((ref) => blobRefHasCompletedGithubConsumer(runState, ref)),
      }
    : runState
  const results = cleanupRunBlobRefs({
    runState: cleanupState,
    projectRoot,
    siteId: netlify?.siteId,
    token: netlify?.env?.NETLIFY_AUTH_TOKEN,
    env: netlify?.env,
    cwd: netlify?.configDir || projectRoot,
    deleteBlob,
    log: (message) => console.warn(message),
  })
  const failed = results.filter((result) => !result.ok)
  if (failed.length > 0) {
    runState.blobCleanupWarning = `${failed.length} prompt blob cleanup ${failed.length === 1 ? 'operation' : 'operations'} pending after ${reason}. Run "nax clean blobs --force" later.`
  }
  if (deferredRefs.length > 0) {
    runState.blobRefs = [...(cleanupState.blobRefs || []), ...deferredRefs]
    runState.blobCleanupWarning = `${deferredRefs.length} GitHub prompt blob ${deferredRefs.length === 1 ? 'ref was' : 'refs were'} left for TTL cleanup because consumer completion/fetch confirmation was not proven.`
  }
  return results
}

/** @param {CleanupWorkflowBlobsInput} [input] */
function cleanupWorkflowBlobsForRun({ runState, projectRoot, options = {}, reason = 'flow-terminal' } = {}) {
  if (!Array.isArray(runState?.blobRefs) || runState.blobRefs.length === 0) return []
  const netlify = resolveNetlifyProjectTarget({
    projectRoot,
    siteId: options.netlifySiteId,
    filter: options.filter,
    netlifyConfig: options.netlifyConfig,
  })
  return cleanupLocalWorkflowBlobs({ runState, projectRoot, netlify, reason })
}

module.exports = {
  githubIssueDeliveryKey,
  buildGithubFullPromptWrapper,
  optionalNetlifyForBlobOffload,
  blobOffloadContextError,
  ensureGithubIssueFullPromptBlobOffload,
  ensureGithubPlanBlobOffload,
  formatLocalRunResults,
  compactTextForRetry,
  localSafePromptBytes,
  compactLocalTextByBytes,
  formatCompactLocalRunResults,
  buildLocalAgentPrompt,
  renderStructuredForLocalEssentials,
  blobOffloadDisabled,
  localPromptByteMetrics,
  ensureStepBlobOffload,
  buildSafeCompactLocalPrompt,
  buildOffloadedRoundResults,
  buildFullPromptWrapper,
  ensureFullPromptBlobOffload,
  prepareLocalPromptDelivery,
  applyContextFetchClassification,
  blobRefHasCompletedGithubConsumer,
  cleanupLocalWorkflowBlobs,
  cleanupWorkflowBlobsForRun,
}
