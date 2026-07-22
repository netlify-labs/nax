// Tests for the nax costs report: credits-led rows over recent run states
// with a grand total, in table and JSON shapes.
const test = require('node:test')
const assert = require('node:assert/strict')

const { buildCostsReport, formatCostsTable } = require('../../src/cli/display/costs-report')

const states = [
  {
    runId: '2026-07-20T10-00-00-000Z-review',
    flowId: 'review',
    flowTitle: 'Review',
    status: 'completed',
    createdAt: '2026-07-20T10:00:00.000Z',
    steps: [{
      id: 'one',
      runs: [
        { agent: 'codex', status: 'completed', usage: { totalCreditsCost: 4.5, totalTokens: 1200 } },
        { agent: 'gemini', status: 'completed', usage: { totalCreditsCost: 3, totalTokens: 950 } },
      ],
    }],
  },
  {
    runId: '2026-07-21T09-00-00-000Z-audit',
    flowId: 'security-audit',
    flowTitle: 'Security Audit',
    status: 'failed',
    createdAt: '2026-07-21T09:00:00.000Z',
    steps: [{
      id: 'audit',
      runs: [{ agent: 'claude', status: 'failed', usage: { totalCreditsCost: 1.25, totalTokens: 400 } }],
    }],
  },
  {
    runId: '2026-07-19T08-00-00-000Z-quiet',
    flowId: 'review',
    flowTitle: 'Review',
    status: 'completed',
    createdAt: '2026-07-19T08:00:00.000Z',
    steps: [{ id: 'one', runs: [{ agent: 'codex', status: 'completed' }] }],
  },
]

test('buildCostsReport sorts newest first, honors limit, and totals credits', () => {
  const report = buildCostsReport(states, { limit: 2 })
  assert.deepEqual(report.runs.map((run) => run.flowTitle), ['Security Audit', 'Review'])
  assert.equal(report.runs[0].usage.totalCreditsCost, 1.25)
  assert.equal(report.runs[1].usage.totalCreditsCost, 7.5)
  assert.equal(report.total.totalCreditsCost, 8.75)
  assert.equal(report.total.totalTokens, 2550)
  assert.equal(report.shownCount, 2)
  assert.equal(report.totalCount, 3)
})

test('buildCostsReport includes runs without usage as empty rows', () => {
  const report = buildCostsReport(states, { limit: 10 })
  assert.equal(report.runs.length, 3)
  const quiet = report.runs.find((run) => run.runId.includes('quiet'))
  assert.deepEqual(quiet.usage, {})
  assert.equal(quiet.summary, '')
})

test('formatCostsTable renders credits-led rows and a total line', () => {
  const lines = formatCostsTable(buildCostsReport(states, { limit: 10 }))
  const text = lines.join('\n')
  assert.match(text, /Security Audit/)
  assert.match(text, /1\.25 credits/)
  assert.match(text, /Total \(3 runs\)/)
  assert.match(text, /8\.75 credits/)
})
