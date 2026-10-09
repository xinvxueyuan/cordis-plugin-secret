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
import { NAME_DEADLINE_MS } from './naming.ts'
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
      // R1: a blank credential key is completed by the local rule and — when
      // this profile has a model — improved by one session-free suggestion.
      // `llm` is deliberately NOT in the hard `inject` list above: a profile
      // without it must still activate this plugin.
      nameSuggester: (request) => suggestCredentialKey(ctx, request),
      nameDeadlineMs: NAME_DEADLINE_MS,
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

/** The optional `llm` service, as this plugin needs it: one streaming call. */
interface LlmStreamLike {
  stream(options: Record<string, unknown>): AsyncIterable<unknown>
}

/** Optional-service lookup: an absent service is `undefined`, never a throw. */
interface OptionalServiceLookup {
  get(name: string): unknown
}

/** The one session fact a key suggestion needs: which model this conversation uses. */
interface RequestHeaderLike {
  requestHeader?(): { readonly config?: { readonly provider?: unknown; readonly model?: unknown } } | undefined
}

/**
 * Ask the session's own model for a credential key, outside the conversation.
 *
 * Three promises, all of them structural:
 *
 * - the model is **optional** — no `llm` service in the profile means this
 *   returns undefined and the local rule alone decides the key;
 * - the call is **session-free** — no `sessionId` is passed to the stream, no
 *   event is appended to any session and no tool is offered, so neither the
 *   request nor its answer leaves a trace in the conversation;
 * - the request carries **only the redacted prompt** the service built from the
 *   human's title and the value's shape.
 */
async function suggestCredentialKey(
  ctx: Context,
  request: {
    readonly sessionId: string
    readonly system: string
    readonly user: string
    readonly signal: AbortSignal
  },
): Promise<string | undefined> {
  const llm = (ctx as unknown as OptionalServiceLookup).get('llm') as LlmStreamLike | undefined
  if (llm === undefined) return undefined
  const session = ctx.sessions.get(request.sessionId as never) as RequestHeaderLike | undefined
  const route = session?.requestHeader?.()?.config
  const provider = route?.provider
  const model = route?.model
  if (typeof provider !== 'string' || typeof model !== 'string' || provider.length === 0 || model.length === 0) {
    return undefined
  }
  let text = ''
  const stream = llm.stream({
    provider,
    model,
    system: request.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: request.user }] }],
    maxTokens: 24,
    // The `session-title` purpose is what makes the harness force reasoning
    // effort to 'off' for this call: the cheapest way to ask for a name.
    purpose: 'session-title',
    signal: request.signal,
  })
  for await (const chunk of stream) {
    if (typeof chunk === 'object' && chunk !== null) {
      const piece = chunk as { type?: unknown; text?: unknown }
      if (piece.type === 'text-delta' && typeof piece.text === 'string') text += piece.text
    }
  }
  return text
}
