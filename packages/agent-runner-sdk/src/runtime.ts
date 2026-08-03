export type AgentRuntime = 'local' | 'netlify-build' | 'agent-runner'

export interface RuntimeEnvironment {
  readonly [key: string]: string | undefined
}

function isTruthy(value: string | undefined): boolean {
  return value === 'true' || value === '1'
}

export function detectRuntime(
  env: RuntimeEnvironment = process.env,
): AgentRuntime {
  if (!isTruthy(env.NETLIFY)) return 'local'
  const hasBuildMetadata = Boolean(
    env.BUILD_ID
      || env.DEPLOY_ID
      || env.DEPLOY_URL
      || env.DEPLOY_PRIME_URL,
  )
  if (hasBuildMetadata) return 'netlify-build'
  return env.CONTEXT === 'dev-server' ? 'agent-runner' : 'netlify-build'
}
