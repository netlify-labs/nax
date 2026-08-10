const MAX_TEXT_BYTES = 2048
const MAX_STRUCTURED_BYTES = 256 * 1024
const MAX_STRING_BYTES = 64 * 1024
const MAX_ARRAY_ITEMS = 500
const MAX_NEXT_ACTIONS = 8
const { isSecretKey, redactSecretText } = require('./security')

/**
 * @typedef {import('../contracts').ControlPlaneContext} ControlPlaneContext
 * @typedef {import('../contracts').ControlPlaneJsonObject} ControlPlaneJsonObject
 * @typedef {import('../contracts').ControlPlaneJsonValue} ControlPlaneJsonValue
 * @typedef {import('../contracts').ControlPlaneNextAction} ControlPlaneNextAction
 *
 * @typedef {{
 *   runtime: 'local-dashboard' | 'desktop' | 'hosted',
 *   scope: import('../contracts').ControlPlaneScope,
 *   local?: import('../contracts').ControlPlaneLocalDiagnostics,
 * }} McpResultContext
 *
 * @typedef {{
 *   ok: true,
 *   data: unknown,
 *   context?: McpResultContext,
 *   next_actions: ControlPlaneNextAction[],
 * }} McpSuccessEnvelope
 *
 * @typedef {{
 *   summary: string,
 *   data: unknown,
 *   context?: McpResultContext | ControlPlaneContext,
 *   nextActions?: ControlPlaneNextAction[],
 * }} McpSuccessResultInput
 *
 * @typedef {{
 *   content: Array<{ type: 'text', text: string }>,
 *   structuredContent: McpSuccessEnvelope,
 * }} McpSuccessToolResult
 */

/**
 * @param {unknown} value
 * @param {string} [key]
 * @param {number} [depth]
 * @param {WeakSet<Record<string, unknown> | unknown[]>} [seen]
 * @returns {ControlPlaneJsonValue | undefined}
 */
function sanitizeMcpValue(value, key = '', depth = 0, seen = new WeakSet()) {
  if (isSecretKey(key)) return undefined
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string') {
    const redacted = redactSecretText(value)
    if (Buffer.byteLength(redacted, 'utf8') <= MAX_STRING_BYTES) return redacted
    return `${Buffer.from(redacted).subarray(0, MAX_STRING_BYTES).toString('utf8')}\n[truncated]`
  }
  if (typeof value === 'bigint') return String(value)
  if (!value || typeof value !== 'object') return undefined
  if (depth >= 12) return '[maximum depth reached]'
  const seenValue = /** @type {Record<string, unknown> | unknown[]} */ (value)
  if (seen.has(seenValue)) return '[circular]'
  seen.add(seenValue)
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).flatMap((entry) => {
      const item = sanitizeMcpValue(entry, key, depth + 1, seen)
      return item === undefined ? [] : [item]
    })
  }
  /** @type {ControlPlaneJsonObject} */
  const result = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    const item = sanitizeMcpValue(childValue, childKey, depth + 1, seen)
    if (item !== undefined) result[childKey] = item
  }
  return result
}

/** @param {unknown} value @returns {ControlPlaneJsonObject} */
function sanitizeMcpObject(value) {
  const sanitized = sanitizeMcpValue(value)
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? /** @type {ControlPlaneJsonObject} */ (sanitized)
    : {}
}

/** @param {unknown} value */
function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/**
 * @param {unknown} value
 * @param {Set<string>} [uris]
 * @returns {Set<string>}
 */
function collectResourceUris(value, uris = new Set()) {
  if (!value || typeof value !== 'object') return uris
  if (Array.isArray(value)) {
    for (const entry of value) collectResourceUris(entry, uris)
    return uris
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && /^(?:resourceUri|resource_uri|uri)$/i.test(key) && entry.startsWith('nax://')) uris.add(entry)
    else collectResourceUris(entry, uris)
  }
  return uris
}

/**
 * @param {unknown} value
 * @param {number} [maxBytes]
 * @returns {unknown}
 */
function boundStructuredData(value, maxBytes = MAX_STRUCTURED_BYTES) {
  const sanitized = sanitizeMcpValue(value)
  const data = sanitized === undefined ? null : sanitized
  if (jsonBytes(data) <= maxBytes) return data
  const resourceUris = [...collectResourceUris(data)].slice(0, 32)
  return {
    truncated: true,
    reason: `Structured data exceeded the ${maxBytes}-byte MCP result budget. Read the linked resources for full content.`,
    resource_uris: resourceUris,
  }
}

/** @param {unknown} value @param {number} [maxBytes] */
function conciseText(value, maxBytes = MAX_TEXT_BYTES) {
  const text = redactSecretText(value).trim() || 'NAX operation completed.'
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  return `${bytes.subarray(0, Math.max(0, maxBytes - 16)).toString('utf8')}\n[truncated]`
}

/**
 * @param {McpResultContext | ControlPlaneContext | undefined} context
 * @returns {McpResultContext | undefined}
 */
function resultContext(context) {
  if (!context) return undefined
  return {
    runtime: context.runtime,
    scope: { ...context.scope },
    ...(context.local ? { local: { ...context.local } } : {}),
  }
}

/**
 * @param {ControlPlaneNextAction[]} [actions]
 * @returns {ControlPlaneNextAction[]}
 */
function boundedNextActions(actions = []) {
  /** @type {ControlPlaneNextAction[]} */
  const result = []
  for (const action of actions.slice(0, MAX_NEXT_ACTIONS)) {
    if (!action || typeof action !== 'object') continue
    if (action.kind === 'tool' && action.tool) {
      result.push({ kind: 'tool', tool: action.tool, arguments: sanitizeMcpObject(action.arguments) })
      continue
    }
    if (action.kind === 'resource' && typeof action.uri === 'string' && action.uri.startsWith('nax://')) {
      result.push({ kind: 'resource', uri: action.uri })
      continue
    }
    if (action.kind === 'command' && typeof action.command === 'string') {
      result.push({ kind: 'command', command: conciseText(action.command, 1024) })
    }
  }
  return result
}

/**
 * Pins tool follow-ups to the scope that produced them. Resource URIs already
 * carry their scope and command actions do not invoke MCP tools.
 * @param {ControlPlaneNextAction[]} actions
 * @param {McpResultContext | ControlPlaneContext | undefined} context
 * @returns {ControlPlaneNextAction[]}
 */
function scopeNextActions(actions, context) {
  const scopeId = context?.scope?.scopeId
  if (!scopeId) return actions
  return actions.map((action) => action.kind === 'tool'
    ? { ...action, arguments: { ...action.arguments, scope_id: scopeId } }
    : action)
}

/**
 * @param {McpSuccessResultInput} input
 * @returns {McpSuccessToolResult}
 */
function successResult({ summary, data, context, nextActions = [] }) {
  const structuredContent = {
    ok: /** @type {const} */ (true),
    data: boundStructuredData(data),
    ...(resultContext(context) ? { context: resultContext(context) } : {}),
    next_actions: boundedNextActions(scopeNextActions(nextActions, context)),
  }
  return {
    content: [{ type: /** @type {const} */ ('text'), text: conciseText(summary) }],
    structuredContent,
  }
}

module.exports = {
  MAX_ARRAY_ITEMS,
  MAX_NEXT_ACTIONS,
  MAX_STRING_BYTES,
  MAX_STRUCTURED_BYTES,
  MAX_TEXT_BYTES,
  boundStructuredData,
  boundedNextActions,
  collectResourceUris,
  conciseText,
  jsonBytes,
  redactSecretText,
  resultContext,
  sanitizeMcpObject,
  sanitizeMcpValue,
  scopeNextActions,
  successResult,
}
