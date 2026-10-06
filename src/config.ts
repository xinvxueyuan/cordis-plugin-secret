import z from '@deepseek-ai/schemastery'

/** Runtime configuration of cordis-plugin-secret. */
export interface SecretConfig {
  /** How long one `secret_request` waits for the human before failing closed. */
  requestTimeoutMs: number
  /** How many authorization dialogs may wait for a human at the same time. */
  maxPendingRequests: number
  /**
   * How long an attached-but-never-sent secret is kept in memory before being
   * dropped. A staged attach is never a grant: nothing is injected while it
   * waits, and this bound is what keeps a value out of a long-lived process.
   */
  attachTtlMs: number
  /** How many attached secrets one session may hold at the same time. */
  maxAttachmentsPerSession: number
}

export const Config = z.object({
  requestTimeoutMs: z.number().default(300000),
  maxPendingRequests: z.number().default(4),
  attachTtlMs: z.number().default(1800000),
  maxAttachmentsPerSession: z.number().default(8),
})

/** Hand-check constraints the schema DSL does not express. */
export function assertConfig(config: SecretConfig): void {
  for (const key of [
    'requestTimeoutMs',
    'maxPendingRequests',
    'attachTtlMs',
    'maxAttachmentsPerSession',
  ] as const) {
    const value = config[key]
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`cordis-plugin-secret: ${key} must be a positive integer`)
    }
  }
}
