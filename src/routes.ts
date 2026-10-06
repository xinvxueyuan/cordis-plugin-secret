import type { Context } from '@deepseek-ai/cordis'
import { attachedSessionId, jsonResponse, sessionIdQuery } from './protocol.ts'
import type { SecretService } from './service.ts'

/** Exact `/api` route the dialog polls for waiting interactions. */
export const PENDING_PATH = '/api/secret.pending'
/** Exact `/api` route the dialog submits decisions to. */
export const ANSWER_PATH = '/api/secret.answer'
/** Exact `/api` route one human-attached secret is registered on. */
export const ATTACH_PATH = '/api/secret.attach'
/** Exact `/api` route one staged attach is dropped on. */
export const RELEASE_PATH = '/api/secret.release'
/** Exact `/api` route the capsule reads its own session's attachments from. */
export const ATTACHED_PATH = '/api/secret.attached'
/** Exact `/api` route the capsule reads one session's attachment history from. */
export const HISTORY_PATH = '/api/secret.history'
/** Exact `/api` route the `@` menu reads this session's usable secrets from. */
export const AVAILABLE_PATH = '/api/secret.available'
/** Exact `/api` route one durably stored secret is registered for a session on. */
export const ADOPT_PATH = '/api/secret.adopt'

/**
 * Mount this plugin's authenticated routes on the shared API channel.
 *
 * All of them live inside Connection's trust fence (loopback/trusted Host,
 * same-origin markers, signed browser cookie), so only the page that already
 * talks to this Harness can list, read history from, adopt or answer a request.
 * The value travels only in the attach/answer POST bodies — never a query
 * string, never a URL, never a response body; the read-only routes carry names,
 * scopes and states only.
 */
export function registerSecretRoutes(ctx: Context, service: SecretService): void {
  ctx.effect(() => {
    const disposers = [
      ctx.connection.fetch.register({
        path: PENDING_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => Promise.resolve(jsonResponse({ ok: true, requests: service.views() })),
      }),
      ctx.connection.fetch.register({
        path: ATTACHED_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => {
          const sessionId = attachedSessionId({ sessionId: new URL(request.url).searchParams.get('sessionId') })
          if (sessionId === undefined) {
            return Promise.resolve(jsonResponse({ ok: false, error: 'attached.sessionId is required' }, 400))
          }
          return Promise.resolve(
            jsonResponse({ ok: true, attachments: service.attachedViews(sessionId) }),
          )
        },
      }),
      ctx.connection.fetch.register({
        path: ATTACH_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body: unknown
          try {
            body = await request.json()
          } catch {
            return jsonResponse({ ok: false, error: 'attach body must be JSON' }, 400)
          }
          const outcome = await service.attach(body)
          return outcome.ok
            ? jsonResponse({ ok: true, ...outcome.outcome })
            : jsonResponse({ ok: false, error: outcome.error }, outcome.status)
        },
      }),
      ctx.connection.fetch.register({
        path: RELEASE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body: unknown
          try {
            body = await request.json()
          } catch {
            return jsonResponse({ ok: false, error: 'release body must be JSON' }, 400)
          }
          const outcome = service.release(body)
          return outcome.ok
            ? jsonResponse({ ok: true, released: outcome.released, state: outcome.state })
            : jsonResponse({ ok: false, error: outcome.error }, outcome.status)
        },
      }),
      ctx.connection.fetch.register({
        path: HISTORY_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => {
          const sessionId = sessionIdQuery({ sessionId: new URL(request.url).searchParams.get('sessionId') })
          if (sessionId === undefined) {
            return Promise.resolve(jsonResponse({ ok: false, error: 'history.sessionId is required' }, 400))
          }
          return Promise.resolve(jsonResponse({ ok: true, entries: service.historyFor(sessionId).entries }))
        },
      }),
      ctx.connection.fetch.register({
        path: AVAILABLE_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const sessionId = sessionIdQuery({ sessionId: new URL(request.url).searchParams.get('sessionId') })
          if (sessionId === undefined) {
            return jsonResponse({ ok: false, error: 'available.sessionId is required' }, 400)
          }
          return jsonResponse({ ok: true, entries: await service.available(sessionId) })
        },
      }),
      ctx.connection.fetch.register({
        path: ADOPT_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body: unknown
          try {
            body = await request.json()
          } catch {
            return jsonResponse({ ok: false, error: 'adopt body must be JSON' }, 400)
          }
          const outcome = await service.adopt(body)
          return outcome.ok
            ? jsonResponse({ ok: true, ...outcome.outcome })
            : jsonResponse({ ok: false, error: outcome.error }, outcome.status)
        },
      }),
      ctx.connection.fetch.register({
        path: ANSWER_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body: unknown
          try {
            body = await request.json()
          } catch {
            return jsonResponse({ ok: false, error: 'answer body must be JSON' }, 400)
          }
          const outcome = service.answer(body)
          return outcome.ok
            ? jsonResponse({ ok: true })
            : jsonResponse({ ok: false, error: outcome.error }, outcome.status)
        },
      }),
    ]
    return () => {
      for (const dispose of disposers) void dispose()
    }
  })
}
