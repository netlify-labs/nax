/**
 * @param {number} statusCode
 * @param {string} code
 * @param {string} message
 * @returns {{ error: { statusCode: number, code: string, message: string } }}
 */
function errorPayload(statusCode, code, message) {
  return {
    error: {
      statusCode,
      code,
      message,
    },
  }
}

/**
 * @param {number} statusCode
 * @param {string} code
 * @param {string} message
 * @returns {Error & { statusCode: number, code: string }}
 */
function requestError(statusCode, code, message) {
  const error = /** @type {Error & { statusCode: number, code: string }} */ (new Error(message))
  error.statusCode = statusCode
  error.code = code
  return error
}

module.exports = {
  errorPayload,
  requestError,
}
