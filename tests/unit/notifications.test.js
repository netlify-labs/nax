const assert = require('node:assert/strict')
const test = require('node:test')

const {
  compactPayload,
  createNotificationDispatcher,
  eventNameForRunnerEvent,
  validateNotifyUrl,
  webhookBody,
} = require('../../src/integrations/notifications')

test('notification event names map durable runner events to webhook events', () => {
  assert.equal(eventNameForRunnerEvent({ type: 'workflow_completed' }), 'workflow.completed')
  assert.equal(eventNameForRunnerEvent({ type: 'workflow_failed' }), 'workflow.failed')
  assert.equal(eventNameForRunnerEvent({ type: 'workflow_awaiting_review' }), 'workflow.awaiting_review')
  assert.equal(eventNameForRunnerEvent({ type: 'step_status', status: 'completed' }), 'step.completed')
  assert.equal(eventNameForRunnerEvent({ type: 'step_status', status: 'awaiting_review' }), 'step.awaiting_review')
  assert.equal(eventNameForRunnerEvent({ type: 'agent_status', status: 'completed' }), '')
})

test('notification payload is compact and excludes large result text by default', () => {
  const payload = compactPayload('step.completed', {
    type: 'step_status',
    runId: 'run-1',
    flowId: 'security-audit',
    flowTitle: 'Security Audit',
    stepId: 'audit',
    stepTitle: 'Audit Security',
    status: 'completed',
    resultText: 'large result',
  })
  assert.deepEqual(payload, {
    event: 'step.completed',
    runId: 'run-1',
    flowId: 'security-audit',
    flowTitle: 'Security Audit',
    branch: '',
    transport: '',
    status: 'completed',
    stepId: 'audit',
    stepTitle: 'Audit Security',
    agent: '',
    runnerId: '',
    sessionId: '',
    issueUrl: '',
    links: {},
    summaryPath: '',
    durationMs: null,
    usage: null,
    at: payload.at,
  })
})

test('webhook body uses raw JSON except for known chat webhook hosts', () => {
  const payload = { event: 'workflow.completed', flowTitle: 'Review', runId: 'run-1', status: 'completed' }
  assert.deepEqual(webhookBody('https://example.com/hook', payload), {
    contentType: 'application/json',
    body: JSON.stringify(payload),
  })
  const slack = webhookBody('https://hooks.slack.com/services/T/B/C', payload)
  assert.equal(slack.contentType, 'application/json')
  assert.match(slack.body, /workflow.completed: Review/)
  const discord = webhookBody('https://discord.com/api/webhooks/1/2', payload)
  assert.match(discord.body, /workflow.completed: Review/)
})

test('notification dispatcher posts matching events and ignores unmatched events', async () => {
  const posted = []
  const dispatcher = createNotificationDispatcher({
    notifyUrl: 'https://example.com/hook',
    notifyEvents: 'step.awaiting_review',
    warn: false,
    fetch: async (url, request) => {
      posted.push({ url, body: request.body })
      return { ok: true, status: 200 }
    },
  })
  dispatcher.notify({ type: 'step_status', status: 'completed', runId: 'run-1' })
  dispatcher.notify({ type: 'step_status', status: 'awaiting_review', runId: 'run-1', stepId: 'review' })
  await dispatcher.flush()
  assert.equal(posted.length, 1)
  assert.equal(JSON.parse(posted[0].body).event, 'step.awaiting_review')
})

test('notification dispatcher rejects private webhook destinations unless explicitly allowed', async () => {
  assert.equal(validateNotifyUrl('https://hooks.example.com/path').ok, true)
  assert.equal(validateNotifyUrl('file:///tmp/hook').ok, false)
  assert.equal(validateNotifyUrl('http://127.0.0.1:9999/hook').ok, false)
  assert.equal(validateNotifyUrl('http://127.0.0.1:9999/hook', { allowPrivate: true }).ok, true)

  const blocked = createNotificationDispatcher({
    notifyUrl: 'http://127.0.0.1:9999/hook',
    notifyEvents: 'step.completed',
    warn: false,
  })
  assert.equal(blocked.enabled, false)
  assert.match(blocked.warnings[0], /notification disabled/)

  const allowed = createNotificationDispatcher({
    notifyUrl: 'http://127.0.0.1:9999/hook',
    notifyEvents: 'step.completed',
    warn: false,
    allowPrivateNotifyUrl: true,
    fetch: async () => ({ ok: true, status: 200 }),
  })
  assert.equal(allowed.enabled, true)
})
