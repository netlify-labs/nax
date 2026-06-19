const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  appendEventLog,
  eventLogPathForRunDir,
  eventLogPathForRunState,
  readEventLog,
} = require('../../src/runner-event-log')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-runner-event-log-'))
}

test('event log resolves paths from durable run state', () => {
  const dir = tmpDir()
  assert.equal(eventLogPathForRunDir(dir), path.join(dir, 'events.jsonl'))
  assert.equal(eventLogPathForRunState({ dir }), path.join(dir, 'events.jsonl'))
})

test('event log appends and replays events after seq', () => {
  const filePath = path.join(tmpDir(), 'events.jsonl')
  appendEventLog(filePath, { seq: 1, type: 'workflow_started' })
  appendEventLog(filePath, { seq: 2, type: 'step_started' })
  appendEventLog(filePath, { seq: 3, type: 'step_completed' })

  assert.deepEqual(readEventLog(filePath, { since: 1 }).events.map((event) => event.seq), [2, 3])
  assert.deepEqual(readEventLog(filePath, { since: 3 }).events, [])
})

test('event log replay reports malformed lines without throwing', () => {
  const filePath = path.join(tmpDir(), 'events.jsonl')
  fs.writeFileSync(filePath, '{"seq":1,"type":"ok"}\nnope\n[]\n{"seq":2,"type":"after"}\n')

  const replay = readEventLog(filePath)
  assert.deepEqual(replay.events.map((event) => event.type), ['ok', 'after'])
  assert.equal(replay.errors.length, 2)
  assert.equal(replay.errors[0].line, 2)
  assert.equal(replay.errors[0].code, 'parse_error')
  assert.equal(replay.errors[1].code, 'invalid_event')
})

test('missing event log replays as empty result', () => {
  assert.deepEqual(readEventLog(path.join(tmpDir(), 'missing.jsonl')), { events: [], errors: [] })
})
