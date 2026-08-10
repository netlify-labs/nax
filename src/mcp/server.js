const path = require('node:path')
const { fileURLToPath } = require('node:url')

const { McpServer } = require('@modelcontextprotocol/server')
const { StdioServerTransport, serveStdio } = require('@modelcontextprotocol/server/stdio')

const { PACKAGE_VERSION } = require('../core/artifact-metadata')
const { canonicalProjectRoot } = require('../runtime/local/mcp-instance-registry')
const { createLocalDashboardClient } = require('./adapters/local-dashboard')
const { createMcpProjectRouter } = require('./project-router')
const { registerNaxPrompts } = require('./prompts')
const { registerNaxResources } = require('./resources')
const { registerControlPlaneTools } = require('./tools')

const SERVER_NAME = 'nax-control-plane'

/**
 * @typedef {{ uri: string }} McpRoot
 * @typedef {{ era: 'legacy' | 'modern', authInfo?: unknown, requestInfo?: Request }} McpRequestContext
 * @typedef {{
 *   server: import('@modelcontextprotocol/server').McpServer,
 *   projectRoot: string,
 *   requestContext: McpRequestContext,
 *   client: import('../contracts').NaxControlPlaneClient,
 *   resolveClient: import('./routing').McpClientResolver,
 * }} McpSurfaceContext
 */

/**
 * @param {string | McpRoot} root
 * @returns {string | null}
 */
function pathFromMcpRoot(root) {
  const value = typeof root === 'string' ? root : root?.uri
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value)
    return url.protocol === 'file:' ? fileURLToPath(url) : null
  } catch {
    return path.isAbsolute(value) ? value : null
  }
}

/**
 * Resolves the default local project hint before the multi-project router is
 * constructed. Claude's project environment is preferred to MCP roots because
 * it is available before initialization on both protocol eras.
 *
 * @param {{
 *   projectRoot?: string,
 *   env?: NodeJS.ProcessEnv,
 *   clientRoots?: Array<string | McpRoot>,
 *   cwd?: string,
 *   canonicalize?: (value: string) => string,
 * }} [options]
 */
function resolveMcpProjectRoot({
  projectRoot = '',
  env = process.env,
  clientRoots = [],
  cwd = process.cwd(),
  canonicalize = canonicalProjectRoot,
} = {}) {
  const explicit = projectRoot.trim()
  if (explicit) return canonicalize(explicit)

  const claudeProjectRoot = String(env.CLAUDE_PROJECT_DIR || '').trim()
  if (claudeProjectRoot) return canonicalize(claudeProjectRoot)

  for (const root of clientRoots) {
    const rootPath = pathFromMcpRoot(root)
    if (rootPath) return canonicalize(rootPath)
  }
  return canonicalize(cwd)
}

/**
 * Creates one MCP server instance. The v2 stdio entry may call this factory
 * once for a discovery probe and again for the connection it ultimately pins.
 *
 * @param {{
 *   projectRoot?: string,
 *   requestContext?: McpRequestContext,
 *   client?: import('../contracts').NaxControlPlaneClient,
 *   resolveClient?: import('./routing').McpClientResolver,
 *   projectRouter?: ReturnType<typeof createMcpProjectRouter>,
 *   registry?: import('../runtime/local/mcp-instance-registry').RegistryPathOptions,
 *   clientFactory?: (options: { projectRoot: string }) => import('../contracts').NaxControlPlaneClient,
 *   registerSurface?: (context: McpSurfaceContext) => void,
 * }} [options]
 */
function buildServer({
  projectRoot = resolveMcpProjectRoot(),
  requestContext = { era: 'legacy' },
  client,
  resolveClient,
  projectRouter,
  registry = {},
  clientFactory = createLocalDashboardClient,
  registerSurface,
} = {}) {
  const router = projectRouter || (!client && !resolveClient
    ? createMcpProjectRouter({ defaultProjectRoot: projectRoot, registry, clientFactory })
    : null)
  const selectedClient = client || router?.defaultClient || clientFactory({ projectRoot })
  const selectedResolver = resolveClient || router?.resolveClient
  const server = new McpServer({
    name: SERVER_NAME,
    version: PACKAGE_VERSION,
  }, {
    capabilities: { tools: {} },
    instructions: 'Resolve the intended NAX project with context_get, then preserve its returned scope_id while planning or controlling remote agent workflows.',
  })

  if (registerSurface) registerSurface({ server, projectRoot, requestContext, client: selectedClient, resolveClient: selectedResolver || (async () => ({ client: selectedClient, context: await selectedClient.getContext(), projectRoot })) })
  else {
    registerControlPlaneTools({ server, client: selectedClient, ...(selectedResolver ? { resolveClient: selectedResolver } : {}) })
    registerNaxResources({ server, client: selectedClient, ...(selectedResolver ? { resolveClient: selectedResolver } : {}) })
    registerNaxPrompts({ server })
  }
  return server
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Starts the stdio adapter. Closing this runtime tears down only MCP stdio;
 * the dashboard process and all remote Agent Runner work remain independent.
 *
 * @param {{
 *   projectRoot?: string,
 *   env?: NodeJS.ProcessEnv,
 *   clientRoots?: Array<string | McpRoot>,
 *   cwd?: string,
 *   stdin?: import('node:stream').Readable,
 *   stdout?: import('node:stream').Writable,
 *   stderr?: import('node:stream').Writable,
 *   installSignalHandlers?: boolean,
 *   registerSurface?: (context: McpSurfaceContext) => void,
 *   serveStdioImpl?: typeof serveStdio,
 * }} [options]
 */
function serveMcpStdio({
  projectRoot: projectRootOption = '',
  env = process.env,
  clientRoots = [],
  cwd = process.cwd(),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  installSignalHandlers = true,
  registerSurface,
  serveStdioImpl = serveStdio,
} = {}) {
  const projectRoot = resolveMcpProjectRoot({
    projectRoot: projectRootOption,
    env,
    clientRoots,
    cwd,
  })
  const transport = new StdioServerTransport(stdin, stdout)
  const handle = serveStdioImpl(
    (requestContext) => buildServer({ projectRoot, requestContext, registerSurface }),
    {
      transport,
      onerror: (error) => stderr.write(`[nax mcp] ${errorMessage(error)}\n`),
    },
  )

  let closed = false
  /** @type {Map<NodeJS.Signals, () => void>} */
  const signalHandlers = new Map()
  const removeSignalHandlers = () => {
    for (const [signal, listener] of signalHandlers) process.removeListener(signal, listener)
    signalHandlers.clear()
  }
  const close = async () => {
    if (closed) return
    closed = true
    removeSignalHandlers()
    await handle.close()
  }

  if (installSignalHandlers) {
    for (const signal of /** @type {NodeJS.Signals[]} */ (['SIGINT', 'SIGTERM'])) {
      const listener = () => {
        void close().catch((error) => {
          stderr.write(`[nax mcp] shutdown failed: ${errorMessage(error)}\n`)
          process.exitCode = 1
        })
      }
      signalHandlers.set(signal, listener)
      process.once(signal, listener)
    }
  }

  return Object.freeze({ projectRoot, close })
}

module.exports = {
  SERVER_NAME,
  buildServer,
  pathFromMcpRoot,
  resolveMcpProjectRoot,
  serveMcpStdio,
}
