// Regression test: `--json` must not crash CLI startup through box-logger's argv sniffing.
// Runs the real CLI entry point as a subprocess.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const { spawnSync } = require('child_process')

const NAX_BIN = path.join(__dirname, '..', '..', 'src', 'cli', 'nax.js')

test('nax list --json prints parseable JSON instead of crashing in box rendering', () => {
  const result = spawnSync(process.execPath, [NAX_BIN, 'list', '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stderr, /borderFn is not a function/)
  const payload = JSON.parse(result.stdout)
  assert.ok(payload.items.some((/** @type {{ id: string }} */ item) => item.id === 'review'))
})
