/**
 * @param {number} statusCode
 * @param {string} code
 * @param {string} message
 * @param {{ recoverable?: boolean, details?: Record<string, unknown> }} [options]
 * @returns {{ error: { statusCode: number, code: string, message: string, recoverable?: boolean, details?: Record<string, unknown> } }}
 */
function errorPayload(statusCode, code, message, options = {}) {
  return {
    error: {
      statusCode,
      code,
      message,
      ...(typeof options.recoverable === 'boolean' ? { recoverable: options.recoverable } : {}),
      ...(options.details && typeof options.details === 'object' && !Array.isArray(options.details) ? { details: options.details } : {}),
    },
  }
}

/**
 * @param {number} statusCode
 * @param {string} code
 * @param {string} message
 * @param {{ recoverable?: boolean, details?: Record<string, unknown> }} [options]
 * @returns {Error & { statusCode: number, code: string, recoverable?: boolean, details?: Record<string, unknown> }}
 */
function requestError(statusCode, code, message, options = {}) {
  const error = /** @type {Error & { statusCode: number, code: string, recoverable?: boolean, details?: Record<string, unknown> }} */ (new Error(message))
  error.statusCode = statusCode
  error.code = code
  if (typeof options.recoverable === 'boolean') error.recoverable = options.recoverable
  if (options.details && typeof options.details === 'object' && !Array.isArray(options.details)) error.details = options.details
  return error
}

module.exports = {
  errorPayload,
  requestError,
}
