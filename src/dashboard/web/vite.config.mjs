import { createRequire } from 'module'
import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { codeInspectorPlugin } from 'code-inspector-plugin'

const require = createRequire(import.meta.url)
const { listFlows, loadFlow } = require('../../flows')
const { isUnfinishedRun, listRunStates } = require('../../run-state')
const { flowToGraph } = require('../shared/graph')
const { buildRunDetails } = require('../shared/run-details')

const webRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(webRoot, '../../..')
const flowOptions = { projectRoot: repoRoot }

function jsonResponse(res, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function errorPayload(statusCode, code, message) {
  return {
    error: {
      statusCode,
      code,
      message,
    },
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch (_err) {
    return value
  }
}

function publicFlow(flow = {}) {
  return {
    id: flow.id || '',
    title: flow.title || '',
    description: flow.description || '',
    source: flow.source || '',
    sourceLabel: flow.sourceLabel || '',
    sourceDir: flow.sourceDir || '',
    sourcePriority: flow.sourcePriority ?? null,
    dir: flow.dir || '',
    file: flow.file || '',
    defaults: flow.defaults || {},
    options: flow.options || {},
    steps: Array.isArray(flow.steps)
      ? flow.steps.map((step) => ({
        id: step.id || '',
        title: step.title || '',
        description: step.description || '',
        prompt: step.prompt || '',
        type: step.type || '',
        action: step.action || '',
        submit: step.submit || '',
        agents: Array.isArray(step.agents) ? step.agents : [],
        input: Array.isArray(step.input) ? step.input : [],
        waitFor: step.waitFor || '',
        review: step.review || null,
        autoArchive: step.autoArchive,
        isArchivable: step.isArchivable,
      }))
      : [],
  }
}

function publicRunState(runState = {}) {
  const summaryPath = runState.dir ? path.join(runState.dir, 'artifacts', 'summary.md') : ''
  return {
    runId: runState.runId || '',
    flowId: runState.flowId || '',
    flowTitle: runState.flowTitle || '',
    status: runState.status || '',
    transport: runState.transport || '',
    branch: runState.branch || '',
    createdAt: runState.createdAt || '',
    updatedAt: runState.updatedAt || '',
    dir: runState.dir || '',
    summaryPath,
    resumable: isUnfinishedRun(runState),
    steps: Array.isArray(runState.steps) ? runState.steps : [],
  }
}

function methodNotAllowed(res, method) {
  jsonResponse(res, 405, errorPayload(405, 'method_not_allowed', `Method ${method} is not allowed for this endpoint.`))
}

function devApiPlugin() {
  return {
    name: 'nax-dev-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
        const pathname = requestUrl.pathname
        if (!pathname.startsWith('/api/')) {
          next()
          return
        }

        try {
          if (pathname === '/api/health') {
            if (req.method !== 'GET') {
              methodNotAllowed(res, req.method || 'UNKNOWN')
              return
            }
            jsonResponse(res, 200, {
              ok: true,
              projectRoot: repoRoot,
              viteDevApi: true,
              tokenRequiredForMutations: false,
              tokenRequiredForSensitiveReads: false,
              capabilities: {
                deploymentMode: 'local',
                canStartRuns: false,
                canDryRun: false,
                canOpenLocalFiles: true,
                canStreamRunEvents: false,
                requiresAuth: false,
              },
            })
            return
          }

          if (pathname === '/api/workflows') {
            if (req.method !== 'GET') {
              methodNotAllowed(res, req.method || 'UNKNOWN')
              return
            }
            const flows = await listFlows(flowOptions)
            jsonResponse(res, 200, {
              count: flows.length,
              items: flows.map(publicFlow),
            })
            return
          }

          if (pathname === '/api/runs') {
            if (req.method !== 'GET') {
              methodNotAllowed(res, req.method || 'UNKNOWN')
              return
            }
            jsonResponse(res, 200, {
              active: [],
              durable: listRunStates(repoRoot).map(publicRunState),
            })
            return
          }

          const runGraphMatch = pathname.match(/^\/api\/runs\/([^/]+)\/graph$/)
          if (runGraphMatch) {
            if (req.method !== 'GET') {
              methodNotAllowed(res, req.method || 'UNKNOWN')
              return
            }
            const runId = safeDecode(runGraphMatch[1])
            const runState = listRunStates(repoRoot).find((state) => state.runId === runId)
            if (!runState) {
              jsonResponse(res, 404, errorPayload(404, 'not_found', 'Unknown dashboard run.'))
              return
            }
            const flow = runState.flow && Array.isArray(runState.flow.steps)
              ? runState.flow
              : await loadFlow(runState.flowId, flowOptions)
            jsonResponse(res, 200, {
              run: publicRunState(runState),
              workflow: publicFlow(flow),
              graph: flowToGraph({ flow, runState }),
            })
            return
          }

          const runDetailsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/details$/)
          if (runDetailsMatch) {
            if (req.method !== 'GET') {
              methodNotAllowed(res, req.method || 'UNKNOWN')
              return
            }
            const runId = safeDecode(runDetailsMatch[1])
            const runState = listRunStates(repoRoot).find((state) => state.runId === runId)
            if (!runState) {
              jsonResponse(res, 404, errorPayload(404, 'not_found', 'Unknown dashboard run.'))
              return
            }
            jsonResponse(res, 200, {
              run: publicRunState(runState),
              details: buildRunDetails(runState),
            })
            return
          }

          const graphMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/graph$/)
          if (graphMatch) {
            if (req.method !== 'GET') {
              methodNotAllowed(res, req.method || 'UNKNOWN')
              return
            }
            const flow = await loadFlow(safeDecode(graphMatch[1]), flowOptions)
            jsonResponse(res, 200, {
              workflow: publicFlow(flow),
              graph: flowToGraph({ flow }),
            })
            return
          }

          const workflowMatch = pathname.match(/^\/api\/workflows\/([^/]+)$/)
          if (workflowMatch) {
            if (req.method !== 'GET') {
              methodNotAllowed(res, req.method || 'UNKNOWN')
              return
            }
            jsonResponse(res, 200, publicFlow(await loadFlow(safeDecode(workflowMatch[1]), flowOptions)))
            return
          }

          jsonResponse(
            res,
            501,
            errorPayload(501, 'vite_dev_api_read_only', 'Vite dev API only supports workflow browsing. Use `nax dashboard` for dry-run and run actions.'),
          )
        } catch (error) {
          const message = error?.message || String(error)
          const statusCode = /^Unknown flow /.test(message) ? 404 : 500
          jsonResponse(res, statusCode, errorPayload(statusCode, statusCode === 404 ? 'not_found' : 'internal_error', message))
        }
      })
    },
  }
}

function normalizeBackendTarget(rawValue) {
  const raw = String(rawValue || '').trim()
  if (!raw) {
    return ''
  }

  const url = new URL(raw)
  if (url.pathname.replace(/\/+$/, '') === '/api') {
    url.pathname = '/'
  }
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function devBackendProxy() {
  const target = normalizeBackendTarget(
    process.env.NAX_DASHBOARD_API_URL || process.env.VITE_NAX_DASHBOARD_API_URL,
  )
  if (!target) {
    return null
  }

  const token = String(process.env.NAX_DASHBOARD_TOKEN || '').trim()
  return {
    target,
    changeOrigin: true,
    secure: false,
    timeout: 0,
    configure(proxy) {
      proxy.on('proxyReq', (proxyReq) => {
        if (token && !proxyReq.getHeader('x-nax-token')) {
          proxyReq.setHeader('x-nax-token', token)
        }
      })
    },
  }
}

function devApiModePlugin(proxy) {
  return {
    name: 'nax-dev-api-mode',
    configureServer() {
      const mode = proxy
        ? `proxying /api to ${proxy.target}`
        : 'serving read-only workflow data from Vite'
      console.log(`Nax dashboard dev: ${mode}`)
    },
  }
}

const realApiProxy = devBackendProxy()
const plugins = [
  codeInspectorPlugin({
    bundler: 'vite',
  }),
  react(),
  devApiModePlugin(realApiProxy),
]

if (!realApiProxy) {
  plugins.push(devApiPlugin())
}

export default defineConfig({
  plugins,
  root: webRoot,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    ...(realApiProxy ? { proxy: { '/api': realApiProxy } } : {}),
  },
})
