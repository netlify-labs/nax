const { publicRunState } = require('../api/serializers')
const { securityHeaders } = require('../api/security')
const { eventAfter, eventText } = require('../runtime/live-run-registry')

/**
 * @typedef {{
 *   getRawRun: (id: string) => import('../runtime/live-run-registry').LiveRun | null,
 *   registerSseClient: (run: import('../runtime/live-run-registry').LiveRun, req: import('http').IncomingMessage, res: import('http').ServerResponse) => void,
 * }} LiveRunStreamRegistry
 *
 * @typedef {{
 *   getRunState: (id: string) => Record<string, unknown> | null,
 *   listEvents: (input?: { runId?: string, since?: number }) => import('../../storage/interfaces').EventsReplay | null,
 * }} EventStreamStore
 *
 * @typedef {{
 *   liveRuns: LiveRunStreamRegistry,
 *   eventStore: EventStreamStore,
 * }} LocalEventStreamOptions
 *
 * @typedef {{
 *   ok: boolean,
 *   active?: boolean,
 *   running?: boolean,
 *   run?: import('../runtime/live-run-registry').LiveRun | import('../../storage/interfaces').DashboardRunPayload,
 *   events?: Array<Record<string, unknown>>,
 *   errors?: Array<Record<string, unknown>>,
 *   message?: string,
 * }} EventReplayResult
 */

/**
 * @param {import('../runtime/live-run-registry').LiveRun} run
 * @param {number} since
 * @returns {EventReplayResult}
 */
function activeEventReplay(run, since = 0) {
  return {
    ok: true,
    active: true,
    running: run.status === 'running',
    run,
    events: run.events.filter((candidate) => eventAfter(candidate, since)),
    errors: [],
  }
}

/**
 * @param {Record<string, unknown>} durable
 * @param {import('../../storage/interfaces').EventsReplay} replay
 * @returns {EventReplayResult}
 */
function durableEventReplay(durable, replay) {
  return {
    ok: true,
    active: false,
    running: false,
    run: replay.run || publicRunState(durable),
    events: replay.events,
    errors: replay.errors,
  }
}

/** @param {LocalEventStreamOptions} options */
function createLocalEventStreamAdapter({ liveRuns, eventStore }) {
  return {
    /**
     * @param {{ runId: string, since?: number }} input
     * @returns {EventReplayResult}
     */
    replayEvents({ runId, since = 0 }) {
      const active = liveRuns.getRawRun(runId)
      if (active) return activeEventReplay(active, since)
      const durable = eventStore.getRunState(runId)
      if (!durable) return { ok: false, message: 'Unknown dashboard run.' }
      const replay = eventStore.listEvents({ runId, since })
      if (!replay) return { ok: false, message: 'Unknown dashboard run.' }
      return durableEventReplay(durable, replay)
    },
    /**
     * @param {{ req: import('http').IncomingMessage, res: import('http').ServerResponse, runId: string, since?: number }} input
     * @returns {EventReplayResult}
     */
    streamEvents({ req, res, runId, since = 0 }) {
      const replay = this.replayEvents({ runId, since })
      if (!replay.ok) return replay
      res.writeHead(200, {
        ...securityHeaders(),
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      for (const event of replay.events || []) res.write(eventText(event))
      for (const error of replay.errors || []) {
        res.write(eventText({
          id: 0,
          type: 'runner_event_error',
          at: new Date().toISOString(),
          runId,
          ...error,
        }))
      }
      const active = liveRuns.getRawRun(runId)
      if (active && active.status === 'running') {
        liveRuns.registerSseClient(active, req, res)
      } else {
        res.end()
      }
      return replay
    },
  }
}

module.exports = {
  activeEventReplay,
  createLocalEventStreamAdapter,
  durableEventReplay,
}
