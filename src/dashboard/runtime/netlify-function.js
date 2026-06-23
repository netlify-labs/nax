const { createDashboardApi } = require('../api/app')
const { hostedPlaceholderCapabilities } = require('../api/capabilities')
const { createHostedNetlifyApiTransport } = require('../transports/netlify-api')

/**
 * @typedef {{
 *   httpMethod?: string,
 *   rawUrl?: string,
 *   path?: string,
 *   queryStringParameters?: Record<string, string | undefined> | null,
 *   headers?: Record<string, string | undefined>,
 *   body?: string | null,
 *   isBase64Encoded?: boolean,
 *   requestContext?: { http?: { method?: string } },
 * }} NetlifyFunctionEvent
 *
 * @typedef {{
 *   statusCode: number,
 *   headers: Record<string, string>,
 *   body: string,
 *   isBase64Encoded: boolean,
 * }} NetlifyFunctionResponse
 *
 * @typedef {{
 *   token?: string,
 *   capabilities?: Record<string, boolean | string>,
 *   netlifyApiClient?: import('../transports/netlify-api').HostedNetlifyApiClient,
 *   siteId?: string,
 *   initialRunnerIds?: string[],
 * }} NetlifyDashboardFunctionOptions
 */

/** @param {NetlifyDashboardFunctionOptions} [options] */
function createHostedDashboardApi({ token = '', capabilities, netlifyApiClient, siteId = '', initialRunnerIds = [] } = {}) {
  const transport = netlifyApiClient ? createHostedNetlifyApiTransport({ client: netlifyApiClient, siteId, initialRunnerIds }) : null
  const resolvedCapabilities = capabilities || hostedPlaceholderCapabilities({
    canReadRuns: Boolean(transport),
    canReadRunDetails: Boolean(transport),
    canReadEventsJson: Boolean(transport),
    canStartRuns: Boolean(transport),
    canCancelRuns: Boolean(transport),
    canSubmitFollowups: Boolean(transport),
  })
  return createDashboardApi({
    runtime: {
      mode: 'netlify-function',
      deploymentMode: 'web',
      capabilities: resolvedCapabilities,
      healthCapabilities: resolvedCapabilities,
    },
    token,
    runStore: transport
      ? {
          listRunsPage: () => transport.listRunsPage(),
          getRun: (id) => transport.getRun(id),
          getRunGraph: (id) => transport.getRunGraph(id),
          getRunDetails: (id) => transport.getRunDetails(id),
        }
      : {},
    eventStore: transport
      ? {
          listEvents: (input) => transport.listEvents(input),
        }
      : {},
    mutations: transport
      ? {
          startWorkflow: (id, body) => transport.startWorkflowRun(id, body),
          cancelRun: (id) => transport.cancelRun(id),
          submitFollowup: (id, body) => transport.submitFollowup(id, body),
          cancelFollowup: (id, body) => transport.cancelFollowup(id, body),
        }
      : {},
  })
}

/** @param {NetlifyFunctionEvent} event */
function eventUrl(event) {
  if (event.rawUrl) return event.rawUrl
  const url = new URL(event.path || '/', 'https://dashboard.netlify.local')
  for (const [key, value] of Object.entries(event.queryStringParameters || {})) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url.toString()
}

/** @param {NetlifyFunctionEvent} event */
function eventHeaders(event) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (value !== undefined) headers.set(key, value)
  }
  return headers
}

/** @param {NetlifyFunctionEvent} event */
function eventBody(event) {
  if (!event.body) return undefined
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body
}

/** @param {Response} response */
async function netlifyResponse(response) {
  /** @type {Record<string, string>} */
  const headers = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  return {
    statusCode: response.status,
    headers,
    body: await response.text(),
    isBase64Encoded: false,
  }
}

/** @param {NetlifyDashboardFunctionOptions} [options] */
function createNetlifyDashboardFunction(options = {}) {
  const app = createHostedDashboardApi(options)
  /** @param {NetlifyFunctionEvent} event @returns {Promise<NetlifyFunctionResponse>} */
  return async function dashboardFunction(event) {
    const response = await app.request(eventUrl(event), {
      method: event.httpMethod || event.requestContext?.http?.method || 'GET',
      headers: eventHeaders(event),
      body: eventBody(event),
    })
    return netlifyResponse(response)
  }
}

module.exports = {
  createHostedDashboardApi,
  createNetlifyDashboardFunction,
}
