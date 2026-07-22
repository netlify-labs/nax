// Tests for the client-side usage formatting helpers: credits-led compact
// badge text and the fuller summary label for run details.
import test from 'node:test'
import assert from 'node:assert/strict'

import { usageBadgeText, usageSummaryLabel } from '../../src/dashboard/web/src/run-format'

test('usageBadgeText leads with credits and stays empty without them', () => {
  assert.equal(usageBadgeText({ totalCreditsCost: 7.5, totalTokens: 2150 }), '7.5 cr')
  assert.equal(usageBadgeText({ totalCreditsCost: 0.1 }), '0.1 cr')
  assert.equal(usageBadgeText({ totalTokens: 2150 }), '')
  assert.equal(usageBadgeText(undefined), '')
})

test('usageSummaryLabel joins credits, tokens, and credit-limit flag', () => {
  assert.equal(usageSummaryLabel({ totalCreditsCost: 7.5, totalTokens: 2150 }), '7.5 credits · 2,150 tokens')
  assert.equal(usageSummaryLabel({ totalTokens: 950 }), '950 tokens')
  assert.equal(
    usageSummaryLabel({ totalCreditsCost: 12, creditLimitExceeded: true }),
    '12 credits · credit limit exceeded',
  )
  assert.equal(usageSummaryLabel({}), '')
  assert.equal(usageSummaryLabel(undefined), '')
})
