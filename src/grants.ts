import type { SecretScope } from './types.ts'

/**
 * The subset of a live `Session` this store reads. Declared structurally so the
 * store stays testable without a Session instance; a real `Session` satisfies it
 * (`SessionSurface.nodes` is a readonly array of branded numbers, which widens to
 * `readonly number[]`).
 */
export interface GrantSessionLike {
  readonly id: string
  /** Next sequence number (the live log length). */
  readonly seq: number
  /** Current model-visible surface, read live on every check. */
  readonly surface: {
    readonly nodes: readonly number[]
    readonly replaceGeneration: number
  }
  /** Whether a sequence belongs to this session rather than its fork-inherited prefix. */
  isOwnSeq(seq: number): boolean
}

/** One approved exposure of one secret to one session. */
export interface Grant {
  readonly sessionId: string
  readonly name: string
  readonly envVar: string
  readonly scope: SecretScope
  /** The value served to this session (durable for `persistent`, memory-only for `session`). */
  readonly value: string
  readonly source: 'store' | 'entered'
  /** Sequence of the approval-anchoring event (the assistant message that called the tool). */
  readonly anchorSeq: number
  /** Tool call identity that produced this grant. */
  readonly callId: string
  /** `surface.replaceGeneration` observed at approval time. */
  readonly replaceGenerationAtApproval: number
  readonly authorizedAt: number
}

/** Why a lookup failed. */
export type GrantVerdictCode =
  | 'ok'
  /** No grant for this session and name. */
  | 'not-found'
  /** The anchoring event is not this session's own event (fork-inherited history). */
  | 'revoked-not-own'
  /** The anchoring event left the model-visible surface (rewind / edit-and-retry). */
  | 'revoked-anchor'

/** Result of one grant lookup. */
export interface GrantLookup {
  readonly code: GrantVerdictCode
  readonly grant?: Grant
}

/** One revocation retained so a later request can explain why it is asked again. */
export interface RevocationNote {
  readonly sessionId: string
  readonly name: string
  readonly code: Exclude<GrantVerdictCode, 'ok' | 'not-found'>
  readonly at: number
}

function pairKey(sessionId: string, name: string): string {
  return `${sessionId}\u0000${name}`
}

/**
 * In-memory session grants, anchored to a live session surface.
 *
 * This is the derived cache practices.md describes: the session log is the
 * source of truth, and every read re-derives validity from the *live* surface.
 * Nothing here is ever written to disk, a forked child (a different session id)
 * cannot see its parent's grants, and a grant whose anchor left the surface is
 * dropped rather than served.
 */
export class GrantStore {
  private readonly grants = new Map<string, Grant>()
  private readonly namesByEnvVar = new Map<string, Set<string>>()
  private readonly revocations = new Map<string, RevocationNote>()

  /** Record one approval. Replaces any earlier grant for the same session+name. */
  put(grant: Grant): void {
    const key = pairKey(grant.sessionId, grant.name)
    const previous = this.grants.get(key)
    if (previous !== undefined && previous.envVar !== grant.envVar) {
      this.namesByEnvVar.get(previous.envVar)?.delete(grant.name)
    }
    this.grants.set(key, grant)
    const names = this.namesByEnvVar.get(grant.envVar) ?? new Set<string>()
    names.add(grant.name)
    this.namesByEnvVar.set(grant.envVar, names)
    this.revocations.delete(key)
  }

  /**
   * Verify and return the grant for one session and name. A grant that no longer
   * holds is dropped here, so a revoked secret is never served twice.
   */
  resolve(session: GrantSessionLike, name: string): GrantLookup {
    const sessionId = String(session.id)
    const key = pairKey(sessionId, name)
    const grant = this.grants.get(key)
    if (grant === undefined) return { code: 'not-found' }
    if (grant.sessionId !== sessionId) {
      this.dropKey(key, grant, 'revoked-not-own')
      return { code: 'not-found' }
    }
    if (!session.isOwnSeq(grant.anchorSeq)) {
      this.dropKey(key, grant, 'revoked-not-own')
      return { code: 'revoked-not-own' }
    }
    if (!session.surface.nodes.includes(grant.anchorSeq)) {
      this.dropKey(key, grant, 'revoked-anchor')
      return { code: 'revoked-anchor' }
    }
    return { code: 'ok', grant }
  }

  /** The value to inject for one exposed variable in one execution's session. */
  valueFor(session: GrantSessionLike, envVar: string): string | undefined {
    for (const name of this.namesByEnvVar.get(envVar) ?? []) {
      const lookup = this.resolve(session, name)
      if (lookup.code === 'ok') return lookup.grant?.value
    }
    return undefined
  }

  /** The credential keys currently bound to one exposed variable. */
  namesForEnvVar(envVar: string): readonly string[] {
    return [...(this.namesByEnvVar.get(envVar) ?? [])]
  }

  /** Every name this session currently holds a *valid* grant for. */
  validNames(session: GrantSessionLike): readonly string[] {
    const sessionId = String(session.id)
    const names: string[] = []
    for (const grant of this.grants.values()) {
      if (grant.sessionId !== sessionId) continue
      if (this.resolve(session, grant.name).code === 'ok') names.push(grant.name)
    }
    return names
  }

  /** Drop every grant of one session (session end, so nothing session-scoped survives). */
  forget(sessionId: string): void {
    for (const [key, grant] of [...this.grants]) {
      if (grant.sessionId === sessionId) this.dropKey(key, grant, 'revoked-not-own', false)
    }
    for (const [key, note] of [...this.revocations]) {
      if (note.sessionId === sessionId) this.revocations.delete(key)
    }
  }

  /** The revocation recorded for one session and name, if any. */
  revocationFor(sessionId: string, name: string): RevocationNote | undefined {
    return this.revocations.get(pairKey(sessionId, name))
  }

  /** Number of live grants (diagnostics and tests). */
  size(): number {
    return this.grants.size
  }

  private dropKey(
    key: string,
    grant: Grant,
    code: Exclude<GrantVerdictCode, 'ok' | 'not-found'>,
    remember = true,
  ): void {
    this.grants.delete(key)
    const names = this.namesByEnvVar.get(grant.envVar)
    if (names !== undefined) {
      names.delete(grant.name)
      if (names.size === 0) this.namesByEnvVar.delete(grant.envVar)
    }
    if (remember) {
      this.revocations.set(key, {
        sessionId: grant.sessionId,
        name: grant.name,
        code,
        at: Date.now(),
      })
    }
  }
}
