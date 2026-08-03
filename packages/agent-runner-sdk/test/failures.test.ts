import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BasicAgentRunnerSdkError,
  CORE_FAILURE_PROFILES,
  CreateAmbiguousError,
  GITHUB_FAILURE_PROFILES,
  HttpResponseError,
  InvalidApiShapeError,
  PrHeadChangedError,
  classifyCoreFailure,
  classifyFailure,
  classifyGithubFailure,
} from '../src/index.js'
import type {
  EffectiveStartInput,
  FailureCategory,
} from '../src/index.js'

const input: EffectiveStartInput = {
  siteId: 'site-1',
  prompt: 'work',
  requestId: '44444444-4444-4444-8444-444444444444',
}

test('core failure profiles cover every stable core category', () => {
  const cases: Array<{
    category: FailureCategory
    error: unknown
    context?: Parameters<typeof classifyCoreFailure>[1]
    retryable: boolean
  }> = [
    {
      category: 'authentication',
      error: new BasicAgentRunnerSdkError('auth-expired', 'expired'),
      retryable: false,
    },
    {
      category: 'permission',
      error: new BasicAgentRunnerSdkError(
        'missing-coding-installation',
        'missing',
      ),
      retryable: false,
    },
    {
      category: 'not-found',
      error: new HttpResponseError('not-found', 404, '/runner'),
      retryable: false,
    },
    {
      category: 'validation',
      error: new BasicAgentRunnerSdkError(
        'validation-error',
        'invalid',
      ),
      retryable: false,
    },
    {
      category: 'rate-limit',
      error: new HttpResponseError('rate-limited', 429, '/runner'),
      retryable: true,
    },
    {
      category: 'transport',
      error: new BasicAgentRunnerSdkError(
        'network-error',
        'network failed',
      ),
      retryable: false,
    },
    {
      category: 'capacity',
      error: new Error('The selected model is currently at capacity'),
      retryable: true,
    },
    {
      category: 'argv-too-long',
      error: new Error('spawn E2BIG: argument list too long'),
      retryable: false,
    },
    {
      category: 'terminal',
      error: new Error('arbitrary terminal failure'),
      context: { terminal: 'session' },
      retryable: false,
    },
    {
      category: 'timeout',
      error: new BasicAgentRunnerSdkError(
        'request-timeout',
        'request timed out',
      ),
      retryable: false,
    },
    {
      category: 'cancelled',
      error: 'runner cancelled',
      retryable: false,
    },
    {
      category: 'prompt',
      error: new BasicAgentRunnerSdkError(
        'prompt-ref-expired',
        'expired',
      ),
      retryable: false,
    },
    {
      category: 'blob',
      error: {
        code: 'blob-fetch-failed',
        message: 'blob fetch failed',
      },
      retryable: false,
    },
    {
      category: 'api-drift',
      error: new InvalidApiShapeError('/runner', 'id'),
      retryable: false,
    },
    {
      category: 'ambiguity',
      error: new CreateAmbiguousError(
        input,
        { sentAt: 1, failedAt: 2 },
      ),
      retryable: false,
    },
    {
      category: 'landing',
      error: new Error('durable landing checkpoint failed'),
      context: { stage: 'landing' },
      retryable: false,
    },
    {
      category: 'platform',
      error: new HttpResponseError('http-error', 503, '/runner'),
      retryable: true,
    },
    {
      category: 'unknown',
      error: new Error('unrecognized failure'),
      retryable: false,
    },
  ]

  for (const entry of cases) {
    const classified = classifyCoreFailure(entry.error, entry.context)
    assert.equal(classified.category, entry.category)
    assert.equal(classified.retryable, entry.retryable)
    assert.ok(classified.code.length > 0)
    assert.ok(classified.title.length > 0)
    assert.ok(classified.message.length > 0)
    assert.ok(classified.remediation.length > 0)
    assert.equal(classified.severity, entry.category === 'capacity'
      || entry.category === 'rate-limit'
      || entry.category === 'cancelled'
      ? 'warning'
      : 'error')
  }

  for (const value of Object.values(CORE_FAILURE_PROFILES)) {
    assert.equal(Object.isFrozen(value), true)
    assert.equal(Object.isFrozen(value.remediation), true)
  }
})

test('nax signatures map to stable profiles without copying raw details', () => {
  const capacity = classifyFailure(
    'The model is currently at capacity for secret-customer-name',
  )
  assert.equal(capacity.category, 'capacity')
  assert.equal(capacity.code, 'model-capacity')
  assert.doesNotMatch(capacity.message, /secret-customer-name/)

  assert.equal(
    classifyFailure('Netlify API returned too many requests').category,
    'rate-limit',
  )
  assert.equal(
    classifyFailure('Bad gateway: service unavailable 503').category,
    'platform',
  )
  assert.equal(
    classifyFailure('spawn failed: argument list too long').category,
    'argv-too-long',
  )
})

test('GitHub profiles are a separate optional extension', () => {
  const drift = new PrHeadChangedError('expected', 'actual')
  assert.equal(classifyCoreFailure(drift).category, 'unknown')
  assert.equal(
    classifyGithubFailure(drift)?.code,
    'pr-head-changed',
  )
  assert.equal(classifyFailure(drift).category, 'github')
  assert.equal(
    classifyGithubFailure(new Error('not a GitHub failure')),
    undefined,
  )
  for (const value of Object.values(GITHUB_FAILURE_PROFILES)) {
    assert.equal(Object.isFrozen(value), true)
    assert.equal(Object.isFrozen(value.remediation), true)
  }
})
