// Serves the nax acp turn engine as an Agent Client Protocol agent over newline-delimited JSON-RPC.
// stdout carries protocol frames only, so diagnostics from this process must go to stderr.
const { Readable, Writable } = require('stream')
const { createNaxAcpAgent } = require('./agent')

/**
 * @typedef {Omit<import('./agent').NaxAcpAgentOptions, 'sendUpdate'>} AcpEngineOptions
 */

/**
 * Builds the ACP agent app; the SDK is ESM-only, so it is loaded with a dynamic import.
 * @param {AcpEngineOptions} [engineOptions]
 */
async function createAcpAgentApp(engineOptions = {}) {
  const acp = await import('@agentclientprotocol/sdk')
  /** @type {{ notify: (method: string, params: unknown) => Promise<void> } | null} */
  let client = null
  const engine = createNaxAcpAgent({
    ...engineOptions,
    sendUpdate: async (sessionId, update) => {
      if (!client) throw new Error('ACP client is not connected.')
      await client.notify(acp.methods.client.session.update, { sessionId, update })
    },
  })
  /**
   * The SDK reports thrown errors as a bare "Internal error"; keep the message so clients can show what went wrong.
   * @template P, R
   * @param {(params: P) => Promise<R>} handler
   * @returns {(context: { params: P }) => Promise<R>}
   */
  const withMessage = (handler) => async ({ params }) => {
    try {
      return await handler(params)
    } catch (error) {
      if (error instanceof acp.RequestError) throw error
      throw new acp.RequestError(-32603, error instanceof Error ? error.message : String(error))
    }
  }
  const { agent: agentMethods } = acp.methods
  return acp.agent({ name: 'nax' })
    .onConnect((connection) => { client = connection.client })
    .onRequest(agentMethods.initialize, withMessage(engine.initialize))
    .onRequest(agentMethods.session.new, withMessage(engine.newSession))
    .onRequest(agentMethods.session.load, withMessage(engine.loadSession))
    .onRequest(agentMethods.session.setConfigOption, withMessage(engine.setConfigOption))
    .onRequest(agentMethods.session.prompt, withMessage(engine.prompt))
    .onNotification(agentMethods.session.cancel, ({ params }) => engine.cancel(params))
}

/**
 * Runs nax acp on a pair of byte streams until the client closes its input.
 * @param {AcpEngineOptions & { input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [options]
 * @returns {Promise<void>}
 */
async function serveAcp({ input = process.stdin, output = process.stdout, ...engineOptions } = {}) {
  const acp = await import('@agentclientprotocol/sdk')
  const app = await createAcpAgentApp(engineOptions)
  const stream = acp.ndJsonStream(
    /** @type {WritableStream<Uint8Array>} */ (Writable.toWeb(/** @type {import('stream').Writable} */ (output))),
    /** @type {ReadableStream<Uint8Array>} */ (Readable.toWeb(/** @type {import('stream').Readable} */ (input))),
  )
  const connection = app.connect(stream)
  await connection.closed
}

module.exports = {
  createAcpAgentApp,
  serveAcp,
}
