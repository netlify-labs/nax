const crypto = require('crypto')

const DEFAULT_SAFE_PROMPT_BYTES = 16384
const MIN_ESSENTIAL_EXCERPT_BYTES = 240
const RUNNER_NETLIFY_CLI_PATH = '/opt/buildhome/node-deps/node_modules/.bin/netlify'

/**
 * Agent run data rendered into offloaded prompt/context snippets.
 * @typedef {import('../../types').AgentRun & {
 *   sourceStep?: string,
 * }} PromptOffloadRun
 */

/** @param {unknown} value */
function utf8ByteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8')
}

/** @param {string} name @param {number} fallback */
function envInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** @param {{ safePromptBytes?: number }} [options] */
function safePromptBytes(options = {}) {
  return Math.max(1024, Number(options.safePromptBytes || envInt('NAX_SAFE_PROMPT_BYTES', DEFAULT_SAFE_PROMPT_BYTES)))
}

/** @param {unknown} value @param {number} [length] */
function stableDigest(value, length = 12) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length)
}

/** @param {unknown[]} parts @param {string} prefix @param {number} [length] */
function stableToken(parts, prefix, length = 12) {
  return `${prefix}-${stableDigest(parts.filter(Boolean).join(':'), length)}`
}

/** @param {unknown} value @param {number} maxBytes */
function sliceUtf8(value, maxBytes) {
  const text = String(value || '')
  if (utf8ByteLength(text) <= maxBytes) return text
  let out = ''
  let bytes = 0
  for (const char of text) {
    const next = utf8ByteLength(char)
    if (bytes + next > maxBytes) break
    out += char
    bytes += next
  }
  return out
}

/** @param {unknown} text @param {number} maxBytes @param {string} [label] */
function compactTextByBytes(text, maxBytes, label = 'content') {
  const value = String(text || '').trim()
  if (!value || utf8ByteLength(value) <= maxBytes) return value
  if (maxBytes < MIN_ESSENTIAL_EXCERPT_BYTES) return sliceUtf8(value, maxBytes).trim()
  const note = `\n\n[${label} compacted from ${utf8ByteLength(value).toLocaleString()} bytes. Middle omitted.]\n\n`
  const noteBytes = utf8ByteLength(note)
  const available = Math.max(0, maxBytes - noteBytes)
  const headBytes = Math.ceil(available * 0.65)
  const tailBytes = Math.max(0, available - headBytes)
  const head = sliceUtf8(value, headBytes).trimEnd()
  const tailSource = [...value].reverse().join('')
  const tail = [...sliceUtf8(tailSource, tailBytes)].reverse().join('').trimStart()
  return `${head}${note}${tail}`.trim()
}

/** @param {unknown} rendered */
function realStructuredSection(rendered) {
  const text = String(rendered || '').trim()
  if (!text) return ''
  if (/structured findings block not found/i.test(text)) return ''
  return text
}

/** @param {PromptOffloadRun} [run] */
function runTitle(run = {}) {
  const source = run.sourceStep ? ` from ${run.sourceStep}` : ''
  const agent = String(run.agent || 'agent')
  return `${agent.charAt(0).toUpperCase()}${agent.slice(1)}${source}`
}

/**
 * Bounded essential result rendering options.
 * @typedef {{
 *   renderStructured?: (text: string) => string,
 *   perRunBytes?: number,
 * }} BuildBoundedEssentialOptions
 */

/** @param {PromptOffloadRun} run @param {BuildBoundedEssentialOptions} [options] */
function buildBoundedEssential(run, {
  renderStructured,
  perRunBytes = 1800,
} = {}) {
  const title = runTitle(run)
  const resultText = String(run.resultText || '').trim()
  const structured = renderStructured ? realStructuredSection(renderStructured(resultText)) : ''
  const header = [
    `Agent: ${run.agent || 'agent'}`,
    run.sourceStep ? `Source step: ${run.sourceStep}` : '',
    run.runnerId ? `Runner: ${run.runnerId}` : '',
    run.sessionId ? `Session: ${run.sessionId}` : '',
    `Full result bytes: ${utf8ByteLength(resultText).toLocaleString()}`,
  ].filter(Boolean).join('\n')
  const bodyBudget = Math.max(MIN_ESSENTIAL_EXCERPT_BYTES, perRunBytes - utf8ByteLength(header) - 160)
  const body = structured
    ? compactTextByBytes(structured, bodyBudget, `${title} structured result`)
    : [
      '_Structured findings block not found; bounded excerpt follows. Full report is in the offloaded blob._',
      '',
      compactTextByBytes(resultText, bodyBudget, `${title} result`),
    ].join('\n').trim()
  return [
    '<details>',
    `<summary>${title}</summary>`,
    '',
    header,
    '',
    body || '_No inline excerpt fit; full report is in the offloaded blob._',
    '',
    '</details>',
  ].join('\n')
}

/**
 * Inline essentials rendering options.
 * @typedef {{
 *   renderStructured?: (text: string) => string,
 *   totalBytes?: number,
 *   perRunBytes?: number,
 * }} BuildInlineEssentialsOptions
 */

/** @param {PromptOffloadRun[]} runs @param {BuildInlineEssentialsOptions} [options] */
function buildInlineEssentials(runs, {
  renderStructured,
  totalBytes = 9000,
  perRunBytes,
} = {}) {
  const completed = (runs || []).filter((run) => String(run.resultText || '').trim())
  if (completed.length === 0) return ''
  const heading = '## Prior Agent Results (bounded essentials)'
  const budgetPerRun = perRunBytes || Math.max(600, Math.floor((totalBytes - utf8ByteLength(heading)) / completed.length))
  const parts = [heading, '', '> Full prior result prose was offloaded because the prompt would exceed the safe Netlify runner argv budget.', '']
  let used = utf8ByteLength(parts.join('\n'))
  for (let index = 0; index < completed.length; index += 1) {
    const remainingRuns = completed.length - index
    const remainingBudget = Math.max(300, totalBytes - used)
    const itemBudget = Math.max(300, Math.min(budgetPerRun, Math.floor(remainingBudget / remainingRuns)))
    const block = buildBoundedEssential(completed[index], { renderStructured, perRunBytes: itemBudget })
    parts.push(block, '')
    used = utf8ByteLength(parts.join('\n'))
    if (used > totalBytes) break
  }
  return compactTextByBytes(parts.join('\n').trim(), totalBytes, 'Bounded prior results')
}

/** @param {{ cliPath?: string, fallbackToPath?: boolean }} [options] */
function runnerNetlifyCliCommand({ cliPath = RUNNER_NETLIFY_CLI_PATH, fallbackToPath = false } = {}) {
  const normalized = String(cliPath || '').trim() || RUNNER_NETLIFY_CLI_PATH
  if (!fallbackToPath || normalized === 'netlify') return normalized
  return `$(if [ -x "${normalized}" ]; then printf %s "${normalized}"; else printf %s netlify; fi)`
}

/**
 * Runner-local Netlify CLI command options.
 * @typedef {{
 *   cliPath?: string,
 *   fallbackToPath?: boolean,
 * }} RunnerNetlifyCliCommandOptions
 *
 * Fetch-instruction build options.
 * @typedef {{
 *   store?: string,
 *   key?: string,
 *   marker?: string,
 *   kind?: string,
 *   runner?: RunnerNetlifyCliCommandOptions,
 *   fetchCommand?: string,
 * }} BuildFetchInstructionInput
 */

/** @param {BuildFetchInstructionInput} param0 */
function buildFetchInstruction({ store, key, marker, kind = 'prior-results', runner = {}, fetchCommand = '' }) {
  const fullPrompt = kind === 'full-prompt'
  const command = fetchCommand || runnerNetlifyCliCommand(runner)
  return [
    fullPrompt ? '## Full prompt (offloaded)' : '## Prior round context (full detail)',
    '',
    fullPrompt
      ? 'Before you do anything else, fetch the full prompt for this run:'
      : 'Before you do anything else, fetch the full prior-round results for this run:',
    '',
    `    NETLIFY_SITE_ID="\${NETLIFY_SITE_ID:-$SITE_ID}" ${command} blobs:get ${store} ${key}`,
    '',
    fullPrompt
      ? 'Read the returned Markdown as your complete prompt, follow it exactly, then echo the context marker and the NAX-BLOB-SENTINEL line from the top of the blob so nax can verify the prompt was loaded:'
      : 'Read the returned Markdown, then echo the context marker and the NAX-BLOB-SENTINEL line from the top of the blob so nax can verify the context was loaded:',
    '',
    `    NAX-CONTEXT-LOADED ${marker}`,
    '    NAX-BLOB-SENTINEL <the exact sentinel value from the blob>',
    '',
    fullPrompt
      ? 'The blob has the complete prompt. Do not proceed from this short wrapper alone.'
      : 'The inline essentials above are bounded; the blob has the complete prose.',
  ].join('\n')
}

/** @param {{ fullResults?: string, sentinel?: string }} param0 */
function buildBlobPayload({ fullResults, sentinel }) {
  return [
    `NAX-BLOB-SENTINEL ${sentinel}`,
    '',
    fullResults || '',
  ].join('\n').trim()
}

/** @param {{ runId?: string, stepId?: string, payloadSeed?: string, kind?: string }} param0 */
function blobRefForStep({ runId, stepId, payloadSeed = '', kind = 'prior-results' }) {
  const store = `nax-${runId}`
  const key = `${stepId}-${kind === 'full-prompt' ? 'full-prompt' : 'prior-results'}`
  const marker = stableToken([runId, stepId], 'ctx')
  const sentinel = stableToken([runId, stepId, kind, payloadSeed], 'blob')
  return { store, key, marker, sentinel }
}

/**
 * Context-fetch classifier input.
 * @typedef {{
 *   reply?: string,
 *   transcript?: string,
 *   commandOutput?: string,
 *   fetchExitCode?: number | null,
 *   fetchError?: string,
 *   marker?: string,
 *   sentinel?: string,
 *   inlineOnlyNeedles?: string[],
 * }} ClassifyContextFetchInput
 */

/** @param {ClassifyContextFetchInput} [options] */
function classifyContextFetch({
  reply,
  transcript,
  commandOutput,
  fetchExitCode = null,
  fetchError = '',
  marker,
  sentinel,
  inlineOnlyNeedles = [],
} = {}) {
  const text = String(reply || '')
  const proofText = [transcript, commandOutput].map((value) => String(value || '')).filter(Boolean).join('\n')
  const signals = []
  const markerNeedle = marker ? `NAX-CONTEXT-LOADED ${marker}` : ''
  const sentinelNeedle = sentinel ? `NAX-BLOB-SENTINEL ${sentinel}` : ''
  if (markerNeedle && (proofText.includes(markerNeedle) || text.includes(markerNeedle))) signals.push('marker')
  if (sentinelNeedle && (proofText.includes(sentinelNeedle) || text.includes(sentinelNeedle))) signals.push('sentinel')
  if (signals.length > 0) {
    return { status: 'confirmed', confirmed: true, signals }
  }
  const hasStructuredFetchFailure = fetchExitCode !== null && fetchExitCode !== undefined && Number(fetchExitCode) !== 0
  const commandFailureText = String(fetchError || commandOutput || transcript || '')
  if (hasStructuredFetchFailure || /(?:blobs:get|blob).*(?:failed|error|forbidden|unauthori[sz]ed|not found)|permission denied/i.test(commandFailureText)) {
    return { status: 'failed', confirmed: false, signals: ['fetch-error'] }
  }
  if (inlineOnlyNeedles.some((needle) => needle && text.includes(needle))) {
    return { status: 'probable', confirmed: true, signals: ['blob-only-detail'] }
  }
  if (/not enough context|missing context|no prior results|cannot access|unable to fetch|need the full/i.test(text) || utf8ByteLength(text.trim()) < 1200) {
    return { status: 'suspect', confirmed: false, signals: ['context-starved'] }
  }
  return { status: 'probable', confirmed: true, signals: ['substantive-output'] }
}

module.exports = {
  DEFAULT_SAFE_PROMPT_BYTES,
  RUNNER_NETLIFY_CLI_PATH,
  blobRefForStep,
  buildBlobPayload,
  buildBoundedEssential,
  buildFetchInstruction,
  buildInlineEssentials,
  runnerNetlifyCliCommand,
  classifyContextFetch,
  compactTextByBytes,
  safePromptBytes,
  stableDigest,
  stableToken,
  utf8ByteLength,
}
