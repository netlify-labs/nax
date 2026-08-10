const SECRET_KEY_PATTERN = /(?:^|_)(?:api[_-]?key|authorization|cookie|password|secret|token)(?:$|_)/i
const SECRET_VALUE_PATTERNS = Object.freeze([
  /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:nfp|ntl|gh[pousr]|npm|sk)_[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
])

/** @param {unknown} value */
function redactSecretText(value) {
  let text = String(value ?? '')
  for (const pattern of SECRET_VALUE_PATTERNS) text = text.replace(pattern, '[redacted]')
  return text
}

/** @param {string} key */
function isSecretKey(key) {
  return SECRET_KEY_PATTERN.test(key)
}

module.exports = {
  SECRET_KEY_PATTERN,
  SECRET_VALUE_PATTERNS,
  isSecretKey,
  redactSecretText,
}
