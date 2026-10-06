import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationFlow } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey, CredentialRecord, CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AnchorSessionLike } from './anchor.ts'
import { agentIdOf } from './envs.ts'
import type { GrantSessionLike } from './grants.ts'
import type {
  AuthorizationAttemptInput,
  AuthorizationAttemptResult,
  AuthorizationPort,
  CallerClass,
  CredentialsPort,
} from './service.ts'
import type { ModalAnswer } from './types.ts'

/** Method id this plugin offers on its authorization flow. */
const ATTEMPT_METHOD = 'confirm'

/**
 * The dialog decided something the authorization seam cannot commit (a
 * decline, a free-text instruction, or a human override to session scope). It
 * escapes the flow so the service can settle on the recorded decision.
 */
class DialogEscapeError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`the secret dialog ended without an authorizable outcome (${reason})`)
    this.name = 'DialogEscapeError'
    this.reason = reason
  }
}

/** Whether an agent is the exact live runtime root, a stale id, or a delegated child. */
export function classifyCaller(ctx: Context, agent: unknown): CallerClass {
  const id = agentIdOf(agent)
  if (id === undefined) return 'not-live'
  const live = ctx.agents.get(id as SessionId)
  if (live === undefined) return 'not-live'
  return ctx.agents.roots().some((root) => String(root.id) === id) ? 'live-root' : 'delegated'
}

/** The live session one approval is anchored to. */
export function sessionOf(ctx: Context, agent: unknown): GrantSessionLike | undefined {
  const id = agentIdOf(agent)
  if (id === undefined) return undefined
  return ctx.sessions.get(id as SessionId)
}

/** The live session's event log, used to find the approval anchor. */
export function anchorSessionOf(ctx: Context, agent: unknown): AnchorSessionLike | undefined {
  const id = agentIdOf(agent)
  if (id === undefined) return undefined
  return ctx.sessions.get(id as SessionId)
}

/**
 * One live session addressed by id: what an attach submission names, and what
 * the capsule's own-session attachment list is resolved against.
 */
export function sessionById(ctx: Context, id: string): GrantSessionLike | undefined {
  return ctx.sessions.get(id as SessionId)
}

/** The credential service, seen through this plugin's port. */
export function credentialsPort(ctx: Context): CredentialsPort {
  const credentials = ctx.credentials
  return {
    describe: async (ref) => await credentials.describe(ref as CredentialRef),
    resolve: async (ref) => await credentials.resolve(ref as CredentialRef),
    set: async (ref, value) => {
      await credentials.set(ref as CredentialRef, value)
    },
    commitRecord: async (key, payload) => {
      const record: CredentialRecord = { kind: 'grant', payload }
      await credentials.modifyRecord(key as CredentialKey, () => Promise.resolve(record))
    },
  }
}

/**
 * The authorization seam, seen through this plugin's port.
 *
 * The Harness ships no Web renderer for `AuthorizationPrompt` (verified by
 * inspection of the installed packages), so this plugin's own dialog is the
 * surface: the flow's `session.prompt({ kind: 'secret' })` is answered from the
 * value the dialog already collected, and the prompt message is never rendered.
 */
export function authorizationPort(ctx: Context): AuthorizationPort {
  return {
    async attempt(input: AuthorizationAttemptInput): Promise<AuthorizationAttemptResult> {
      let recorded: ModalAnswer | undefined
      const flow: AuthorizationFlow = {
        key: input.key as CredentialKey,
        label: input.label,
        methods: [{ id: ATTEMPT_METHOD, label: '在此界面中确认' }],
        run: async (session) => {
          const answer = await input.answer()
          recorded = answer
          if (answer.decision !== 'approved') throw new DialogEscapeError(answer.decision)
          if (answer.scope !== 'persistent') throw new DialogEscapeError('session-override')
          if (input.valueNeeded) {
            const value = await session.prompt({
              kind: 'secret',
              message: `${input.label}：请输入密钥值`,
              placeholder: '粘贴密钥后点击「同意」',
            })
            await input.persist(value)
          }
          await session.commit({ kind: 'grant', payload: input.marker() })
        },
      }

      let dispose: (() => void) | undefined
      try {
        dispose = ctx.authorization.registerFlow(flow)
        const outcome = await ctx.authorization.begin({
          key: flow.key,
          method: ATTEMPT_METHOD,
          interaction: {
            notify: () => undefined,
            prompt: async (prompt) => {
              if (prompt.kind !== 'secret') throw new DialogEscapeError('unexpected-prompt')
              const value = recorded?.decision === 'approved' ? recorded.value : undefined
              if (value === undefined || value.length === 0) throw new DialogEscapeError('no-value')
              return value
            },
          },
        })
        return { status: outcome.status }
      } catch (error) {
        if (error instanceof DialogEscapeError) return { status: 'escaped', reason: error.reason }
        return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
      } finally {
        dispose?.()
      }
    },
  }
}
