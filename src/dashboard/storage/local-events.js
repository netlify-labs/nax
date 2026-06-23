const { eventLogPathForRunState, readEventLog } = require('../../runner-event-log')
const { publicRunState } = require('../api/serializers')

/**
 * @typedef {{
 *   getRunState: (id: string) => Record<string, unknown> | null,
 * }} LocalEventStoreOptions
 *
 * @typedef {{
 *   runId?: string,
 *   since?: number,
 * }} LocalEventsInput
 */

/** @param {Record<string, unknown>} event */
function eventSeq(event = {}) {
  return Number(event.seq ?? event.id ?? 0)
}

/**
 * @param {Record<string, unknown>} event
 * @param {number} since
 */
function eventAfter(event, since = 0) {
  const minimum = Number.isFinite(Number(since)) ? Number(since) : 0
  return eventSeq(event) > minimum
}

/** @param {LocalEventStoreOptions} options */
function createLocalEventStore({ getRunState }) {
  return {
    /** @param {LocalEventsInput} [input] */
    listEvents({ runId, since = 0 } = {}) {
      const durable = getRunState(runId || '')
      if (!durable) return null
      const replay = readEventLog(eventLogPathForRunState(durable), { since })
      return {
        run: publicRunState(durable),
        events: replay.events,
        errors: replay.errors,
      }
    },
  }
}

module.exports = {
  createLocalEventStore,
  eventAfter,
}
