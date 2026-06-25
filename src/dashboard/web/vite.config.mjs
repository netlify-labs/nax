import { createRequire } from 'module'
import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { codeInspectorPlugin } from 'code-inspector-plugin'

const require = createRequire(import.meta.url)
const { listFlows, loadFlow } = require('../../workflows/catalog/flows')
const { publicFlow } = require('../api/serializers')
const { flowToGraph } = require('../shared/graph')
const { createLocalEventStreamAdapter } = require('../events/local-stream')
const { createLocalEventStore } = require('../storage/local-events')
const { createLocalRunStore } = require('../storage/local-runs')

const webRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(webRoot, '../../..')
const flowOptions = { projectRoot: repoRoot, flowsDirs: ['tests/fixtures/workflows'] }

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

function methodNotAllowed(res, method) {
  jsonResponse(res, 405, errorPayload(405, 'method_not_allowed', `Method ${method} is not allowed for this endpoint.`))
}

function devApiPlugin() {
  return {
    name: 'nax-dev-api',
    configureServer(server) {
      const runStore = createLocalRunStore({
        projectRoot: repoRoot,
        flowStore: {
          loadWorkflow: (id) => loadFlow(id, flowOptions),
        },
      })
      const eventStream = createLocalEventStreamAdapter({
        liveRuns: {
          getRawRun: () => null,
          registerSseClient: () => {},
        },
        eventStore: createLocalEventStore({ getRunState: runStore.getRunState }),
      })

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
            const page = runStore.listRunsPage({
              limit: requestUrl.searchParams.get('limit') || '',
              cursor: requestUrl.searchParams.get('cursor') || '',
            })
            jsonResponse(res, 200, {
              active: [],
              durable: page.durable,
              pagination: page.pagination,
            })
            return
          }

          const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/)
          if (runMatch) {
            if (req.method !== 'GET') {
              methodNotAllowed(res, req.method || 'UNKNOWN')
              return
            }
            const run = runStore.getRun(safeDecode(runMatch[1]))
            if (!run) {
              jsonResponse(res, 404, errorPayload(404, 'not_found', 'Unknown dashboard run.'))
              return
            }
            jsonResponse(res, 200, { run })
            return
          }

          const runEventsJsonMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events\.json$/)
          if (runEventsJsonMatch) {
            if (req.method !== 'GET') {
              methodNotAllowed(res, req.method || 'UNKNOWN')
              return
            }
            const runId = safeDecode(runEventsJsonMatch[1])
            const replay = eventStream.replayEvents({
              runId,
              since: Number(requestUrl.searchParams.get('since') || 0),
            })
            if (!replay.ok) {
              jsonResponse(res, 404, errorPayload(404, 'not_found', 'Unknown dashboard run.'))
              return
            }
            jsonResponse(res, 200, {
              run: replay.run,
              events: replay.events || [],
              errors: replay.errors || [],
            })
            return
          }

          const runEventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
          if (runEventsMatch) {
            if (req.method !== 'GET') {
              methodNotAllowed(res, req.method || 'UNKNOWN')
              return
            }
            const runId = safeDecode(runEventsMatch[1])
            const replay = eventStream.streamEvents({
              req,
              res,
              runId,
              since: Number(requestUrl.searchParams.get('since') || 0),
            })
            if (!replay.ok) {
              jsonResponse(res, 404, errorPayload(404, 'not_found', 'Unknown dashboard run.'))
              return
            }
            return
          }

          const runGraphMatch = pathname.match(/^\/api\/runs\/([^/]+)\/graph$/)
          if (runGraphMatch) {
            if (req.method !== 'GET') {
              methodNotAllowed(res, req.method || 'UNKNOWN')
              return
            }
            const runId = safeDecode(runGraphMatch[1])
            const graph = await runStore.getRunGraph(runId)
            if (!graph) {
              jsonResponse(res, 404, errorPayload(404, 'not_found', 'Unknown dashboard run.'))
              return
            }
            jsonResponse(res, 200, graph)
            return
          }

          const runDetailsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/details$/)
          if (runDetailsMatch) {
            if (req.method !== 'GET') {
              methodNotAllowed(res, req.method || 'UNKNOWN')
              return
            }
            const runId = safeDecode(runDetailsMatch[1])
            const details = await runStore.getRunDetails(runId)
            if (!details) {
              jsonResponse(res, 404, errorPayload(404, 'not_found', 'Unknown dashboard run.'))
              return
            }
            jsonResponse(res, 200, details)
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
