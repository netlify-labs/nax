const {
  blobRefForStep,
  buildBlobPayload,
  buildFetchInstruction,
  safePromptBytes,
  utf8ByteLength,
} = require('./prompt-offload')

class FollowupDeliveryError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message)
    this.name = 'FollowupDeliveryError'
    this.code = code
    this.statusCode = statusCode
  }
}

function promptIntro() {
  return [
    'Use the existing conversation context when available.',
    'If prior details are missing or incomplete, use the attached source workflow context before acting.',
  ].join('\n')
}

/**
 * @param {{
 *   contextPackage?: { markdown?: string, artifactCount?: number },
 *   runId?: string,
 *   stepId?: string,
 *   options?: Record<string, any>,
 *   writeBlob?: (input: { ref: Record<string, any>, payload: string }) => Promise<any> | any,
 * }} [input]
 */
async function prepareFollowupContextDelivery({
  contextPackage = {},
  runId = '',
  stepId = 'followup-context',
  options = {},
  writeBlob,
} = {}) {
  const markdown = String(contextPackage.markdown || '').trim()
  const artifactCount = Number(contextPackage.artifactCount || 0)
  if (!markdown || artifactCount === 0) {
    return {
      delivery: 'none',
      artifactCount: 0,
      promptContext: '',
      bytes: 0,
    }
  }

  const intro = promptIntro()
  const inlineText = [intro, '', markdown].join('\n')
  const inlineBytes = utf8ByteLength(inlineText)
  const safeBytes = safePromptBytes(options)
  if (inlineBytes <= safeBytes) {
    return {
      delivery: 'inline',
      artifactCount,
      promptContext: inlineText,
      bytes: inlineBytes,
    }
  }

  if (typeof writeBlob !== 'function') {
    throw new FollowupDeliveryError(
      'context_too_large',
      `Selected follow-up context is ${inlineBytes.toLocaleString()} bytes, above the safe prompt budget of ${safeBytes.toLocaleString()} bytes, and blob delivery is not available.`,
    )
  }

  const ref = blobRefForStep({
    runId: runId || `followup-${Date.now()}`,
    stepId,
    payloadSeed: markdown,
    kind: 'prior-results',
  })
  const payload = buildBlobPayload({ fullResults: markdown, sentinel: ref.sentinel })
  await writeBlob({ ref, payload })
  const promptContext = [intro, '', buildFetchInstruction(ref)].join('\n')
  return {
    delivery: 'blob',
    artifactCount,
    promptContext,
    bytes: utf8ByteLength(promptContext),
    blobRef: ref,
    offloadedBytes: utf8ByteLength(payload),
  }
}

module.exports = {
  FollowupDeliveryError,
  prepareFollowupContextDelivery,
  promptIntro,
}
