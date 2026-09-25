// Child-process worker for run lock tests: holds, tries, or resumes a run from a separate process.
// Modes: hold <runDir> (acquire, report, release on "release" stdin line), try <runDir>, resume <workflow.json>.
const fs = require('fs')
const { acquireRunLock } = require('../../../src/storage/local/run-lock')

const [mode, target] = process.argv.slice(2)

/** Reports are prefixed so the test can tell them apart from the engine's own progress output. */
/** @param {Record<string, unknown>} message */
function report(message) {
  process.stdout.write(`REPORT ${JSON.stringify(message)}\n`)
}

/** @param {unknown} error */
function errorCode(error) {
  return String(/** @type {{ code?: string }} */ (error)?.code || '')
}

async function resume() {
  const { resumeLocalFlow } = require('../../../src/workflows/engine/local-executor')
  const runState = JSON.parse(fs.readFileSync(target, 'utf8'))
  let submitted = 0
  try {
    await resumeLocalFlow({
      flow: runState.flow,
      runState,
      projectRoot: runState.projectRoot,
      resolveRemoteSha: () => String(runState.target?.sha || ''),
      submitAgentRun: async ({ run }) => {
        submitted += 1
        await new Promise((resolve) => setTimeout(resolve, 1500))
        return { ...run, status: 'submitted', runnerId: `runner-${process.pid}`, sessionId: `session-${process.pid}` }
      },
      waitForAgentRuns: async ({ runs = [], onTerminalRun = () => {} } = {}) => {
        const completed = { ...runs[0], status: 'completed', resultText: `result from ${process.pid}` }
        onTerminalRun(completed)
        return [completed]
      },
    })
    report({ ok: true, submitted })
  } catch (error) {
    report({ ok: false, code: errorCode(error), submitted })
  }
}

if (mode === 'hold') {
  const lock = acquireRunLock(target, { runId: 'run-1', command: 'worker hold' })
  report({ locked: true, pid: process.pid })
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    if (!String(chunk).includes('release')) return
    report({ released: lock.release() })
    process.exit(0)
  })
} else if (mode === 'try') {
  try {
    const lock = acquireRunLock(target, { runId: 'run-1', command: 'worker try' })
    report({ locked: true, pid: process.pid })
    lock.release()
  } catch (error) {
    report({ locked: false, code: errorCode(error) })
  }
} else if (mode === 'resume') {
  resume()
}
