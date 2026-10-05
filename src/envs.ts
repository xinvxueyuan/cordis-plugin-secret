import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { GrantSessionLike, GrantStore } from './grants.ts'
import type { EnvPort } from './service.ts'

/**
 * One `shellEnv` contributor per exposed variable.
 *
 * The registry validates `variables` as declared key ownership and rejects a
 * resolver result for an undeclared key, so the declaration cannot be dynamic
 * per execution: one contributor is declared for each variable the first time a
 * session is granted it, and its resolver answers per execution for whichever
 * session that execution belongs to.
 */
export class EnvContributorRegistry implements EnvPort {
  private readonly disposers = new Map<string, () => void>()
  private readonly ctx: Context
  private readonly grants: GrantStore

  constructor(ctx: Context, grants: GrantStore) {
    this.ctx = ctx
    this.grants = grants
    this.ctx.effect(() => () => {
      this.disposeAll()
    })
  }

  /** Declare the contributor for one variable, once. */
  ensure(envVar: string): void {
    if (this.disposers.has(envVar)) return
    const dispose = this.ctx.shellEnv.register({
      name: `cordis-plugin-secret:${envVar}`,
      variables: {
        [envVar]: {
          description: `${envVar}: 由 secret_request 人工授权后注入的密钥（明文永不进入模型上下文；授权随会话回退/fork 失效）。`,
        },
      },
      resolve: (execution) => {
        const session = this.sessionOf(execution.agent)
        if (session === undefined) return {}
        const value = this.grants.valueFor(session, envVar)
        if (value === undefined) return {}
        return { [envVar]: value }
      },
    })
    this.disposers.set(envVar, dispose)
  }

  /** Whether one variable's contributor is declared (diagnostics and tests). */
  declared(envVar: string): boolean {
    return this.disposers.has(envVar)
  }

  /** Withdraw every contributor this plugin declared. */
  disposeAll(): void {
    for (const dispose of this.disposers.values()) dispose()
    this.disposers.clear()
  }

  private sessionOf(agent: unknown): GrantSessionLike | undefined {
    const id = agentIdOf(agent)
    if (id === undefined) return undefined
    return this.ctx.sessions.get(id as SessionId)
  }
}

/** The session id of an execution's agent, when it carries one. */
export function agentIdOf(agent: unknown): string | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const candidate = agent as { id?: unknown; session?: { header?: { id?: unknown } } }
  const own = candidate.session?.header?.id
  if (typeof own === 'string' && own.length > 0) return own
  return typeof candidate.id === 'string' && candidate.id.length > 0 ? candidate.id : undefined
}
