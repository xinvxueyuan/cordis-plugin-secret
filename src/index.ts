import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-tools'
import { anchorSessionOf, authorizationPort, classifyCaller, credentialsPort, sessionById, sessionOf } from './adapters.ts'
import { AttachStore } from './attach.ts'
import { assertConfig, Config, type SecretConfig } from './config.ts'
import { EnvContributorRegistry } from './envs.ts'
import { GrantStore } from './grants.ts'
import { HistoryStore } from './history.ts'
import { installAttachBinding, noteSourcesOn, type AttachNoteReader } from './inject.ts'
import { registerSecretRoutes } from './routes.ts'
import { SecretService } from './service.ts'
import { defineSecretManageTool, defineSecretRequestTool } from './tool.ts'

export const name = 'cordis-plugin-secret'

/**
 * Hard dependencies: without any one of them this plugin cannot do its job, so
 * it stays inactive in a profile that lacks it instead of throwing.
 */
export const inject = [
  'tools',
  'authorization',
  'credentials',
  'shellEnv',
  'sessions',
  'agents',
  'connection',
]

export { Config }

/** Register the `secret_request` tool, the dialog routes, and the env contributor. */
export function apply(ctx: Context, config: SecretConfig): void {
  assertConfig(config)

  const grants = new GrantStore()
  const envs = new EnvContributorRegistry(ctx, grants)
  // The history is memory-only, session-scoped, and bounded: it is the one
  // place a released, discarded, expired or revoked entry still exists.
  const history = new HistoryStore({ capacity: config.maxHistoryPerSession })
  const attachments = new AttachStore({
    ttlMs: config.attachTtlMs,
    capacity: config.maxAttachmentsPerSession,
    schedule: (delayMs, callback) => {
      const timer = setTimeout(callback, delayMs)
      return () => {
        clearTimeout(timer)
      }
    },
    // Only a TTL expiry lands in the history from here: every explicit removal
    // is recorded by the caller that asked for it (with its own reason), and the
    // binding's own consumption of a staged entry is not a loss at all.
    onDrop: (sessionId, envVar, reason) => {
      service.noteDropped(sessionId, envVar, reason)
    },
  })
  const service = new SecretService(
    {
      config,
      credentials: credentialsPort(ctx),
      authorization: authorizationPort(ctx),
      envs,
      attachments,
      history,
      classifyCaller: (agent) => classifyCaller(ctx, agent),
      sessionOf: (agent) => sessionOf(ctx, agent),
      sessionById: (id) => sessionById(ctx, id),
      anchorSessionOf: (agent) => anchorSessionOf(ctx, agent),
      now: () => Date.now(),
      schedule: (delayMs, callback) => {
        const timer = setTimeout(callback, delayMs)
        return () => {
          clearTimeout(timer)
        }
      },
      newId: () => `secret-${globalThis.crypto.randomUUID()}`,
    },
    grants,
  )

  // Session-scoped grants must not survive their session.
  ctx.on('session/disposed', (session) => {
    grants.forget(String(session.id))
    service.forgetAttachments(String(session.id))
    history.forget(String(session.id))
  })
  // A dialog can never outlive the plugin that owns it.
  ctx.effect(() => () => {
    service.pending.abortAll()
    attachments.disposeAll()
    history.disposeAll()
  })

  // The reverse direction: a secret the human attached to their own message.
  installAttachBinding(ctx, {
    store: attachments,
    grants,
    envs,
    now: () => Date.now(),
    sessionOf: (agent) => sessionOf(ctx, agent),
    // One note per attachment: the note itself is durable, so a step that
    // re-admits the same markers must not stack another copy.
    visibleNotes: (session) => noteSourcesOn(session as unknown as AttachNoteReader),
    onBound: (attach) => {
      service.noteBound(attach)
    },
  })

  registerSecretRoutes(ctx, service)
  ctx.tools.register(defineSecretRequestTool(service, config))
  // The management surface is a second tool: the request tool's schema, result,
  // card and persisted meta are a frozen contract, and changing an existing
  // secret is a different question from asking for a new one.
  ctx.tools.register(defineSecretManageTool(service, config))
}
