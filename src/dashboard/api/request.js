const { requestError } = require('./errors')

/**
 * JSON body reader input. This intentionally matches the small stream surface
 * used by the HTTP server and by unit-test fakes.
 * @typedef {{
 *   setEncoding: (encoding: BufferEncoding) => void,
 *   pause: () => unknown,
 *   on: (event: string, listener: (...args: unknown[]) => void) => unknown,
 * }} JsonBodyRequest
 */

/**
 * @param {JsonBodyRequest} req
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
function readJsonBody(req, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let body = ''
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (settled) return
      body += chunk
      if (body.length > maxBytes) {
        req.pause()
        settle(reject, requestError(413, 'payload_too_large', 'Request body is too large.'))
      }
    })
    req.on('end', () => {
      if (!body.trim()) {
        settle(resolve, {})
        return
      }
      try {
        settle(resolve, JSON.parse(body))
      } catch (_err) {
        settle(reject, requestError(400, 'invalid_json', 'Request body must be valid JSON.'))
      }
    })
    req.on('error', (error) => settle(reject, error))
  })
}

module.exports = {
  readJsonBody,
}
