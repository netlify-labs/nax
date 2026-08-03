const REQUEST_MARKER_PATTERN =
  /<!--\s*agent-runner-sdk-request-id:[^>]*-->/gi
const BEARER_PATTERN = /\bBearer\s+[^\s,;]+/gi

function collectStrings(
  value: unknown,
  strings: Set<string>,
  seen: WeakSet<object>,
): void {
  if (typeof value === 'string') {
    if (value.length >= 4) {
      strings.add(value)

      const withoutRequestMarker = value
        .replace(REQUEST_MARKER_PATTERN, '')
        .trim()
      if (withoutRequestMarker.length >= 4) strings.add(withoutRequestMarker)

      for (const line of value.split(/\r?\n/)) {
        const trimmedLine = line.trim()
        if (trimmedLine.length >= 4) strings.add(trimmedLine)
      }
    }
    return
  }
  if (typeof value !== 'object' || value === null) return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, strings, seen)
    return
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectStrings(item, strings, seen)
  }
}

export function redactSensitiveText(
  value: unknown,
  sensitiveValues: readonly unknown[] = [],
): string {
  let text = value === undefined || value === null ? '' : String(value)
  const strings = new Set<string>()
  const seen = new WeakSet<object>()
  for (const sensitive of sensitiveValues) {
    collectStrings(sensitive, strings, seen)
  }
  for (const sensitive of [...strings].sort(
    (left, right) => right.length - left.length,
  )) {
    text = text.split(sensitive).join('[redacted]')
  }
  return text
    .replace(REQUEST_MARKER_PATTERN, '[redacted request marker]')
    .replace(BEARER_PATTERN, 'Bearer [redacted]')
}
