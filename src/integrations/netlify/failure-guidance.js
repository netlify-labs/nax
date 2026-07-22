// Maps known agent-runner failure signatures to plain-language guidance.
// Guidance always prepends; the original error detail is preserved after it.
const { accessDeniedMessage } = require('./preflight')

/**
 * @typedef {{ siteId?: string, email?: string, attempts?: number }} FailureContext
 * @typedef {{ code: string, message: string }} ExplainedFailure
 * @typedef {{ code: string, pattern: RegExp, guidance: (ctx: FailureContext) => string }} FailureSignature
 */

/** @param {FailureContext} ctx */
function retriesPhrase(ctx) {
  return ctx.attempts && ctx.attempts > 1 ? ` through ${ctx.attempts} automatic retries` : ''
}

/** @type {FailureSignature[]} */
const SIGNATURES = [
  {
    code: 'prompt_too_large',
    pattern: /argument list too long/i,
    guidance: () => 'The step prompt exceeds the runner\'s argument size limit. Shrink the prompt or step context — retrying will not help.',
  },
  {
    code: 'model_capacity',
    pattern: /model is currently at capacity/i,
    guidance: (ctx) => `The agent model is at capacity${retriesPhrase(ctx)}. Try again shortly or switch the step's agent.`,
  },
  {
    code: 'token_expired',
    pattern: /token.{0,20}(expired|invalid|revoked)|\b401\b/i,
    guidance: () => 'Netlify auth token is invalid or expired. Run `netlify login`.',
  },
  {
    code: 'wrong_account',
    pattern: /\b403\b|\b404\b|unauthorized|not found|access denied/i,
    guidance: (ctx) => accessDeniedMessage({ email: ctx.email, siteId: ctx.siteId }),
  },
  {
    code: 'rate_limited',
    pattern: /rate limit|too many requests|\b429\b/i,
    guidance: (ctx) => `Netlify API rate limit persisted${retriesPhrase(ctx)}. Wait a minute and re-run.`,
  },
  {
    code: 'netlify_5xx',
    pattern: /\b50[0-4]\b|bad gateway|gateway|service unavailable|internal server error/i,
    guidance: (ctx) => `Netlify API errors persisted${retriesPhrase(ctx)} — likely a service issue; check status.netlify.com.`,
  },
  // out-of-credits: exact stderr text not yet captured (plan O1) — add the
  // entry the day we observe it rather than guessing the wording.
]

/**
 * @param {unknown} detail
 * @param {FailureContext} [ctx]
 * @returns {ExplainedFailure | null}
 */
function explainFailure(detail, ctx = {}) {
  const text = typeof detail === 'string' ? detail : ''
  if (!text) return null
  for (const signature of SIGNATURES) {
    if (!signature.pattern.test(text)) continue
    return { code: signature.code, message: signature.guidance(ctx) }
  }
  return null
}

/**
 * @param {unknown} error
 * @param {FailureContext} [ctx]
 * @returns {unknown}
 */
function wrapFailure(error, ctx = {}) {
  const detail = error instanceof Error ? error.message : ''
  const explained = explainFailure(detail, ctx)
  if (!explained) return error
  const wrapped = /** @type {Error & { code?: string }} */ (new Error(`${explained.message} (${detail})`))
  wrapped.code = explained.code
  return wrapped
}

/**
 * Formats a terminal failure detail for display: guidance first when the
 * detail matches a known signature, the raw detail alone otherwise.
 * @param {unknown} detail
 * @param {FailureContext} [ctx]
 * @returns {string}
 */
function describeRunFailure(detail, ctx = {}) {
  const text = typeof detail === 'string' ? detail : ''
  if (!text) return ''
  const explained = explainFailure(text, ctx)
  return explained ? `${explained.message} (${text})` : text
}

module.exports = {
  describeRunFailure,
  explainFailure,
  wrapFailure,
}
