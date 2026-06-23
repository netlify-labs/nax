const crypto = require('crypto')

const SESSION_COOKIE_NAME = 'nax_dashboard_token'

/**
 * @param {string | undefined} provided
 * @param {string | undefined} expected
 */
function timingSafeTokenEqual(provided, expected) {
  if (!provided || !expected) return false
  const providedDigest = crypto.createHash('sha256').update(String(provided)).digest()
  const expectedDigest = crypto.createHash('sha256').update(String(expected)).digest()
  return crypto.timingSafeEqual(providedDigest, expectedDigest)
}

/**
 * @param {import('http').IncomingMessage | { headers?: Record<string, unknown> }} req
 * @param {URL} [_requestUrl]
 */
function explicitTokenFromRequest(req, _requestUrl) {
  const raw = req.headers?.['x-nax-token']
  const headerToken = Array.isArray(raw) ? raw[0] : raw
  if (headerToken) return String(headerToken)
  return ''
}

/**
 * @param {import('http').IncomingMessage | { headers?: Record<string, unknown> }} req
 * @param {string} name
 */
function cookieValue(req, name) {
  const header = String(req.headers?.cookie || '')
  for (const part of header.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=')
    if (rawKey !== name) continue
    try {
      return decodeURIComponent(rawValue.join('='))
    } catch (_err) {
      return rawValue.join('=')
    }
  }
  return ''
}

/**
 * @param {import('http').IncomingMessage | { headers?: Record<string, unknown> }} req
 * @param {URL} [_requestUrl]
 */
function tokenFromRequest(req, _requestUrl) {
  const explicitToken = explicitTokenFromRequest(req)
  if (explicitToken) return explicitToken
  return cookieValue(req, SESSION_COOKIE_NAME)
}

/** @param {string} token @param {{ secure?: boolean }} [options] */
function sessionCookieHeader(token, options = {}) {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(String(token || ''))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(options.secure ? ['Secure'] : []),
  ].join('; ')
}

/** @param {string} token @param {{ secure?: boolean }} [options] */
function sessionBootstrapHeaders(token, options = {}) {
  return { 'set-cookie': sessionCookieHeader(token, options) }
}

/**
 * @param {import('http').IncomingMessage | { headers?: Record<string, unknown> }} req
 * @param {URL} requestUrl
 * @param {string} token
 * @param {{ secure?: boolean }} [options]
 */
function sessionBootstrapHeadersForRequest(req, requestUrl, token, options = {}) {
  const explicitToken = explicitTokenFromRequest(req)
  return timingSafeTokenEqual(explicitToken, token) ? sessionBootstrapHeaders(token, options) : {}
}

module.exports = {
  SESSION_COOKIE_NAME,
  cookieValue,
  explicitTokenFromRequest,
  sessionBootstrapHeaders,
  sessionBootstrapHeadersForRequest,
  sessionCookieHeader,
  timingSafeTokenEqual,
  tokenFromRequest,
}
