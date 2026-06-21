const DEFAULT_NOTIFY_EVENTS = [
  'workflow.completed',
  'workflow.failed',
  'workflow.interrupted',
  'workflow.awaiting_review',
  'step.completed',
  'step.failed',
  'step.awaiting_review',
]

/**
 * Fetch-compatible webhook sender response used by notifications.
 * @typedef {{
 *   ok: boolean,
 *   status: number,
 * }} NotificationFetchResponse
 *
 * Fetch-compatible function used to deliver webhook notifications.
 * @callback NotificationFetch
 * @param {string | URL | Request} input
 * @param {RequestInit} [init]
 * @returns {Promise<NotificationFetchResponse>}
 */

/**
 * Notification source event emitted by workflow and runner code.
 * @typedef {Record<string, unknown> & {
 *   type?: string,
 *   status?: string,
 *   runId?: string,
 *   flowId?: string,
 *   flowTitle?: string,
 *   branch?: string,
 *   transport?: string,
 *   stepId?: string,
 *   stepTitle?: string,
 *   title?: string,
 *   agent?: string,
 *   runnerId?: string,
 *   sessionId?: string,
 *   issueUrl?: string,
 *   links?: import('./types').StringMap,
 *   summaryPath?: string,
 *   durationMs?: number,
 *   usage?: import('./types').UsageSummary,
 *   at?: string,
 * }} NotificationEvent
 *
 * Compact webhook payload sent to notification endpoints.
 * @typedef {{
 *   event: string,
 *   runId: string,
 *   flowId: string,
 *   flowTitle: string,
 *   branch: string,
 *   transport: string,
 *   status: string,
 *   stepId: string,
 *   stepTitle: string,
 *   agent: string,
 *   runnerId: string,
 *   sessionId: string,
 *   issueUrl: string,
 *   links: import('./types').StringMap,
 *   summaryPath: string,
 *   durationMs: number | null,
 *   usage: import('./types').UsageSummary | null,
 *   at: string,
 * }} NotificationPayload
 *
 * Webhook payload accepted by the low-level webhook formatter.
 * @typedef {Partial<NotificationPayload> & {
 *   event: string,
 * }} NotificationWebhookPayload
 *
 * Notification dispatcher configuration.
 * @typedef {{
 *   notifyUrl?: string,
 *   notifyURL?: string,
 *   notifyEvents?: string | string[],
 *   env?: NodeJS.ProcessEnv,
 *   fetch?: NotificationFetch,
 *   timeoutMs?: string | number,
 *   warn?: boolean,
 * }} NotificationDispatcherOptions
 *
 * Notification dispatcher used by workflow event contexts.
 * @typedef {{
 *   enabled: boolean,
 *   events: string[],
 *   notify: (event?: NotificationEvent) => Promise<void> | null,
 *   flush: () => Promise<string[]>,
 *   warnings: string[],
 * }} NotificationDispatcher
 */

/** @param {unknown} value @param {string[]} [fallback] @returns {string[]} */
function normalizeEventList(value, fallback = DEFAULT_NOTIFY_EVENTS) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean)
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean)
  }
  return [...fallback]
}

/** @param {NotificationEvent} [event] @returns {string} */
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

/** @param {string} eventName @param {NotificationEvent} [event] @returns {NotificationPayload} */
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

/**
 * @param {string} url
 * @param {NotificationWebhookPayload} payload
 * @returns {{ contentType: string, body: string }}
 */
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

/**
 * @param {string} url
 * @param {NotificationPayload} payload
 * @param {{ fetchImpl?: NotificationFetch, timeoutMs?: number }} [options]
 * @returns {Promise<void>}
 */
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

/** @param {NotificationDispatcherOptions} [options] @param {NodeJS.ProcessEnv} [env] @returns {string} */
function resolveNotifyUrl(options = {}, env = process.env) {
  return String(options.notifyUrl || options.notifyURL || env.NAX_NOTIFY_URL || '').trim()
}

/** @param {NotificationDispatcherOptions} [options] @returns {NotificationDispatcher} */
function createNotificationDispatcher(options = {}) {
  const env = options.env || process.env
  const url = resolveNotifyUrl(options, env)
  const enabled = Boolean(url)
  const events = new Set(normalizeEventList(options.notifyEvents || env.NAX_NOTIFY_EVENTS))
  const fetchImpl = options.fetch || globalThis.fetch
  const timeoutMs = Number.parseInt(String(options.timeoutMs || env.NAX_NOTIFY_TIMEOUT_MS || '5000'), 10)
  const pending = []
  const warnings = []

  /** @param {string} message */
  function warn(message) {
    warnings.push(message)
    if (options.warn !== false) console.warn(message)
  }

  /** @param {NotificationEvent} [event] */
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
          const secondMessage = secondError instanceof Error ? secondError.message : ''
          const firstMessage = firstError instanceof Error ? firstError.message : ''
          const message = secondMessage || firstMessage || String(secondError || firstError)
          warn(`nax notification delivery failed for ${eventName}: ${message}`)
        }
      }
    })()
    pending.push(task)
    return task
  }

  /** @returns {Promise<string[]>} */
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
