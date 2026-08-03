import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto'

import { getStore } from '@netlify/blobs'

import type { BlobRef, BlobStore } from '../domain.js'
import { BasicAgentRunnerSdkError } from '../errors.js'

export const DEFAULT_NETLIFY_BLOB_STORE = 'nax-agent-runner-prompts'
export const DEFAULT_PROMPT_BLOB_TTL_SECONDS = 24 * 60 * 60
export const MAX_PROMPT_BLOB_TTL_SECONDS = 7 * 24 * 60 * 60
export const MAX_PROMPT_BLOB_BYTES = 5 * 1024 * 1024

export interface NetlifyBlobClient {
  set(
    key: string,
    bytes: Blob,
    options?: {
      metadata?: Record<string, unknown>
      onlyIfNew?: boolean
    },
  ): Promise<{ modified: boolean }>
  delete(key: string): Promise<void>
}

export interface NetlifyBlobStoreOptions {
  siteId: string
  token: string
  storeName?: string
  maxBytes?: number
  maxTtlSeconds?: number
  now?: () => number
  randomUUID?: () => string
  client?: NetlifyBlobClient
}

const encoder = new TextEncoder()

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      `${field} must be a positive integer.`,
    )
  }
  return value
}

function identityText(value: string, field: string, maximum: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      `${field} is invalid.`,
    )
  }
  return value
}

function tenantHash(tenant: string): string {
  return createHash('sha256').update(tenant).digest('hex').slice(0, 32)
}

function logicalKeySegment(key: string): string {
  const normalized = key
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return normalized || 'prompt'
}

function tenantPrefix(tenant: string): string {
  return `tenants/${tenantHash(tenant)}/`
}

function physicalKey(
  tenant: string,
  key: string,
  randomUUID: () => string,
): string {
  const nonce = randomUUID().replace(/[^A-Za-z0-9_-]/g, '')
  if (!nonce) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      'randomUUID returned an invalid blob-key nonce.',
    )
  }
  return `${tenantPrefix(tenant)}${logicalKeySegment(key)}-${nonce}`
}

function sentinelFor(ref: BlobRef): string {
  return `nax-${createHash('sha256')
    .update(`${ref.store}\0${ref.tenant}\0${ref.key}`)
    .digest('hex')
    .slice(0, 32)}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function assertOwnedRef(ref: BlobRef, storeName: string): void {
  const tenant = identityText(ref.tenant, 'BlobRef.tenant', 512)
  const key = identityText(ref.key, 'BlobRef.key', 1_024)
  if (
    ref.store !== storeName
    || !key.startsWith(tenantPrefix(tenant))
  ) {
    throw new BasicAgentRunnerSdkError(
      'blob-ref-invalid',
      'The blob reference does not belong to this store and tenant.',
    )
  }
  if (!Number.isFinite(ref.expiresAt) || ref.expiresAt <= 0) {
    throw new BasicAgentRunnerSdkError(
      'blob-ref-invalid',
      'The blob reference expiry is invalid.',
    )
  }
}

function storedPayload(bytes: Uint8Array, sentinel: string): Uint8Array {
  const prefix = encoder.encode(`NAX-BLOB-SENTINEL ${sentinel}\n\n`)
  const payload = new Uint8Array(prefix.byteLength + bytes.byteLength)
  payload.set(prefix)
  payload.set(bytes, prefix.byteLength)
  return payload
}

function blobPayload(bytes: Uint8Array, sentinel: string): Blob {
  const payload = storedPayload(bytes, sentinel)
  const buffer = new ArrayBuffer(payload.byteLength)
  new Uint8Array(buffer).set(payload)
  return new Blob([buffer])
}

export function createNetlifyBlobStore(
  options: NetlifyBlobStoreOptions,
): BlobStore {
  const siteId = identityText(options.siteId, 'siteId', 512)
  const token = identityText(options.token, 'token', 16_384)
  const storeName = identityText(
    options.storeName ?? DEFAULT_NETLIFY_BLOB_STORE,
    'storeName',
    255,
  )
  const maxBytes = positiveInteger(
    options.maxBytes ?? MAX_PROMPT_BLOB_BYTES,
    'maxBytes',
  )
  const maxTtlSeconds = positiveInteger(
    options.maxTtlSeconds ?? MAX_PROMPT_BLOB_TTL_SECONDS,
    'maxTtlSeconds',
  )
  const now = options.now ?? Date.now
  const randomUUID = options.randomUUID ?? nodeRandomUUID
  const client = options.client ?? getStore({
    name: storeName,
    siteID: siteId,
    token,
  })

  return {
    async put(key, bytes, putOptions) {
      identityText(key, 'blob key', 1_024)
      const tenant = identityText(
        putOptions.tenant,
        'blob tenant',
        512,
      )
      const ttlSeconds = positiveInteger(
        putOptions.ttlSeconds,
        'ttlSeconds',
      )
      if (ttlSeconds > maxTtlSeconds) {
        throw new BasicAgentRunnerSdkError(
          'blob-ttl-too-long',
          'The requested blob lifetime exceeds the configured maximum.',
        )
      }
      if (!(bytes instanceof Uint8Array)) {
        throw new BasicAgentRunnerSdkError(
          'validation-error',
          'Blob bytes must be a Uint8Array.',
        )
      }
      if (bytes.byteLength > maxBytes) {
        throw new BasicAgentRunnerSdkError(
          'prompt-too-large',
          'The prompt exceeds the configured blob size ceiling.',
        )
      }

      const createdAt = now()
      const expiresAt = createdAt + ttlSeconds * 1_000
      if (
        !Number.isSafeInteger(createdAt)
        || createdAt < 0
        || !Number.isSafeInteger(expiresAt)
      ) {
        throw new BasicAgentRunnerSdkError(
          'validation-error',
          'The blob clock produced an invalid expiry.',
        )
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const ref: BlobRef = {
          store: storeName,
          key: physicalKey(tenant, key, randomUUID),
          tenant,
          expiresAt,
        }
        const sentinel = sentinelFor(ref)
        try {
          const result = await client.set(
            ref.key,
            blobPayload(bytes, sentinel),
            {
              onlyIfNew: true,
              metadata: {
                naxExpiresAt: expiresAt,
                naxTenantHash: tenantHash(tenant),
              },
            },
          )
          if (result.modified) return ref
        } catch {
          throw new BasicAgentRunnerSdkError(
            'blob-write-failed',
            'The prompt blob could not be stored.',
          )
        }
      }
      throw new BasicAgentRunnerSdkError(
        'blob-write-failed',
        'The prompt blob could not reserve a collision-resistant key.',
      )
    },

    async delete(ref) {
      assertOwnedRef(ref, storeName)
      try {
        await client.delete(ref.key)
      } catch {
        throw new BasicAgentRunnerSdkError(
          'blob-delete-failed',
          'The prompt blob could not be removed.',
        )
      }
    },

    runnerFetchInstruction(ref) {
      assertOwnedRef(ref, storeName)
      return {
        shell: [
          'NETLIFY_SITE_ID="${NETLIFY_SITE_ID:-$SITE_ID}"',
          'netlify',
          'blobs:get',
          shellQuote(ref.store),
          shellQuote(ref.key),
        ].join(' '),
        sentinel: sentinelFor(ref),
      }
    },
  }
}
