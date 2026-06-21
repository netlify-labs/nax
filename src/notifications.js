const DEFAULT_NOTIFY_EVENTS = [
  'workflow.completed',
  'workflow.failed',
  'workflow.interrupted',
  'workflow.awaiting_review',
  'step.completed',
  'step.failed',
  'step.awaiting_review',
]

function normalizeEventList(value, fallback = DEFAULT_NOTIFY_EVENTS) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean)
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean)
  }
  return [...fallback]
}

function eventNameForRunnerEvent(event = {}) {
  const type = String(event.type || '')
  const status = String(event.status || '').toLowerCase()
  if (type === 'workflow_completed') return 'workflow.completed'
  if (type === 'workflow_failed') return 'workflow.failed'
  if (type === 'workflow_interrupted') return 'workflow.interrupted'
  if (type === 'workflow_awaiting_review') return 'workflow.awaiting_review'
  if (type === 'workflow_cancelled') return 'workflow.cancelled'
  if (type !== 'step_status') return ''
  if (status === 'completed') return 'step.completed'
  if (status === 'failed' || status === 'timeout') return 'step.failed'
  if (status === 'awaiting_review') return 'step.awaiting_review'
  return ''
}

function compactPayload(eventName, event = {}) {
  return {
    event: eventName,
    runId: event.runId || '',
    flowId: event.flowId || '',
    flowTitle: event.flowTitle || '',
    branch: event.branch || '',
    transport: event.transport || '',
    status: event.status || '',
    stepId: event.stepId || '',
    stepTitle: event.stepTitle || event.title || '',
    agent: event.agent || '',
    runnerId: event.runnerId || '',
    sessionId: event.sessionId || '',
    issueUrl: event.issueUrl || '',
    links: event.links || {},
    summaryPath: event.summaryPath || '',
    durationMs: event.durationMs || null,
    usage: event.usage || null,
    at: event.at || new Date().toISOString(),
  }
}

function webhookBody(url, payload) {
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    host = ''
  }
  if (host === 'hooks.slack.com') {
    const subject = payload.stepTitle
      ? `${payload.event}: ${payload.flowTitle || payload.flowId} / ${payload.stepTitle}`
      : `${payload.event}: ${payload.flowTitle || payload.flowId}`
    return {
      contentType: 'application/json',
      body: JSON.stringify({
        text: subject,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${subject}*\nRun: \`${payload.runId || 'unknown'}\`\nStatus: \`${payload.status || payload.event}\``,
            },
          },
        ],
      }),
    }
  }
  if (host === 'discord.com' || host === 'discordapp.com') {
    const subject = payload.stepTitle
      ? `${payload.event}: ${payload.flowTitle || payload.flowId} / ${payload.stepTitle}`
      : `${payload.event}: ${payload.flowTitle || payload.flowId}`
    return {
      contentType: 'application/json',
      body: JSON.stringify({
        content: `${subject}\nRun: ${payload.runId || 'unknown'}\nStatus: ${payload.status || payload.event}`,
      }),
    }
  }
  return {
    contentType: 'application/json',
    body: JSON.stringify(payload),
  }
}

async function postWebhook(url, payload, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Webhook notifications require global fetch support.')
  const { contentType, body } = webhookBody(url, payload)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': contentType,
      },
      body,
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Webhook returned ${response.status}.`)
  } finally {
    clearTimeout(timer)
  }
}

function resolveNotifyUrl(options = {}, env = process.env) {
  return String(options.notifyUrl || options.notifyURL || env.NAX_NOTIFY_URL || '').trim()
}

function createNotificationDispatcher(options = {}) {
  const env = options.env || process.env
  const url = resolveNotifyUrl(options, env)
  const enabled = Boolean(url)
  const events = new Set(normalizeEventList(options.notifyEvents || env.NAX_NOTIFY_EVENTS))
  const fetchImpl = options.fetch || globalThis.fetch
  const timeoutMs = Number.parseInt(options.timeoutMs || env.NAX_NOTIFY_TIMEOUT_MS || '5000', 10)
  const pending = []
  const warnings = []

  function warn(message) {
    warnings.push(message)
    if (options.warn !== false) console.warn(message)
  }

  function notify(event = {}) {
    if (!enabled) return null
    const eventName = eventNameForRunnerEvent(event)
    if (!eventName || !events.has(eventName)) return null
    const payload = compactPayload(eventName, event)
    const task = (async () => {
      try {
        await postWebhook(url, payload, { fetchImpl, timeoutMs })
      } catch (firstError) {
        try {
          await postWebhook(url, payload, { fetchImpl, timeoutMs })
        } catch (secondError) {
          warn(`nax notification delivery failed for ${eventName}: ${secondError?.message || firstError?.message || String(secondError || firstError)}`)
        }
      }
    })()
    pending.push(task)
    return task
  }

  async function flush() {
    await Promise.allSettled(pending)
    return warnings
  }

  return {
    enabled,
    events: [...events],
    notify,
    flush,
    warnings,
  }
}

module.exports = {
  DEFAULT_NOTIFY_EVENTS,
  compactPayload,
  createNotificationDispatcher,
  eventNameForRunnerEvent,
  normalizeEventList,
  postWebhook,
  resolveNotifyUrl,
  webhookBody,
}
