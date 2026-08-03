import {
  createAuthenticatedNetlifyClient,
} from './request.js'
import type {
  AuthTelemetryEvent,
} from './request.js'
import {
  resolveNetlifyToken,
} from './token.js'
import type {
  NetlifyCliConfigOptions,
} from './token.js'

export type NetlifyPreflightResult =
  | {
      ok: true
      code: 'ok'
      accountEmail: string
      site: {
        id: string
        name: string
        accountSlug: string
      }
    }
  | {
      ok: false
      code: 'missing-token' | 'missing-site'
    }
  | {
      ok: false
      code: 'invalid-token' | 'expired-token'
      status: 401
    }
  | {
      ok: false
      code: 'under-scoped'
      status: 403 | 404
      accountEmail: string
    }
  | {
      ok: false
      code: 'network-error'
      status?: number
      accountEmail: string
      errorName?: string
    }

export interface NetlifyPreflightOptions extends NetlifyCliConfigOptions {
  siteId: string
  token?: string
  fetch?: typeof globalThis.fetch
  baseUrl?: string
  timeoutMs?: number
  userAgent?: string
  onTelemetry?: (event: AuthTelemetryEvent) => void
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function payloadSaysExpired(value: unknown): boolean {
  try {
    return /expir(?:ed|ation)/i.test(JSON.stringify(value))
  } catch {
    return false
  }
}

export async function preflightNetlifyAccess({
  siteId,
  token,
  fetch,
  env = process.env,
  home,
  platform,
  baseUrl,
  timeoutMs = 5_000,
  userAgent,
  onTelemetry,
}: NetlifyPreflightOptions): Promise<NetlifyPreflightResult> {
  const auth = resolveNetlifyToken({
    token,
    env,
    ...(home === undefined ? {} : { home }),
    ...(platform === undefined ? {} : { platform }),
  })
  if (!auth.token) return { ok: false, code: 'missing-token' }
  if (!siteId.trim()) return { ok: false, code: 'missing-site' }

  const client = createAuthenticatedNetlifyClient({
    token: auth.token,
    fetch,
    env,
    ...(home === undefined ? {} : { home }),
    ...(platform === undefined ? {} : { platform }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    timeoutMs,
    retryAttempts: 1,
    ...(userAgent === undefined ? {} : { userAgent }),
    onTelemetry,
  })

  try {
    const user = await client.requestResponse('GET', '/user', {
      operation: 'preflight-user',
    })
    if (user.status === 401) {
      return {
        ok: false,
        code: payloadSaysExpired(user.payload)
          ? 'expired-token'
          : 'invalid-token',
        status: 401,
      }
    }
    const userPayload = objectValue(user.payload)
    const accountEmail = user.ok ? stringValue(userPayload.email) : ''

    const site = await client.requestResponse(
      'GET',
      `/sites/${encodeURIComponent(siteId)}`,
      { operation: 'preflight-site' },
    )
    if (site.status === 403 || site.status === 404) {
      return {
        ok: false,
        code: 'under-scoped',
        status: site.status,
        accountEmail,
      }
    }
    if (!site.ok) {
      return {
        ok: false,
        code: 'network-error',
        status: site.status,
        accountEmail,
      }
    }
    const sitePayload = objectValue(site.payload)
    return {
      ok: true,
      code: 'ok',
      accountEmail,
      site: {
        id: siteId,
        name: stringValue(sitePayload.name),
        accountSlug: stringValue(sitePayload.account_slug),
      },
    }
  } catch (error: unknown) {
    return {
      ok: false,
      code: 'network-error',
      accountEmail: '',
      errorName: error instanceof Error ? error.name : 'Error',
    }
  }
}
