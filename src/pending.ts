import { pendingView } from './protocol.ts'
import type { ModalAnswer, PendingView, SecretScope } from './types.ts'

/** One dialog interaction waiting for a human. Never carries a secret value. */
export interface PendingRequest {
  readonly id: string
  /** The `tool/call` that raised it: the in-stream card claims its request by this. */
  readonly callId: string
  /** Session owning the call. */
  readonly sessionId: string
  readonly name: string
  readonly envVar: string
  readonly label: string
  readonly reason: string
  readonly description?: string
  readonly requestedScope: SecretScope
  readonly alreadyConfigured: boolean
  readonly createdAt: number
  /** The submitted decision once the human answered. */
  answer?: ModalAnswer
}

/** How one wait ended. */
export type WaitOutcome =
  | { readonly kind: 'answer'; readonly answer: ModalAnswer }
  | { readonly kind: 'timeout' }

/** Timer seam so unit tests never depend on the wall clock. */
export type Scheduler = (delayMs: number, callback: () => void) => () => void

/** Inputs of one wait. */
export interface WaitOptions {
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly schedule: Scheduler
}

/** Raised when the caller withdrew (or the plugin unloaded) while a dialog was open. */
export class SecretAbortedError extends Error {
  readonly code = 'ABORTED'

  constructor(message = 'secret_request was aborted before the human answered') {
    super(message)
    this.name = 'SecretAbortedError'
  }
}

interface Waiter {
  readonly resolve: (outcome: WaitOutcome) => void
  readonly reject: (error: Error) => void
}

/**
 * The set of dialog interactions currently waiting for a human, plus the one
 * waiter each of them may carry. In-memory only: nothing here survives a
 * restart, and no value is ever stored here.
 */
export class PendingStore {
  private readonly items = new Map<string, PendingRequest>()
  private readonly waiters = new Map<string, Waiter>()

  /**
   * Register one interaction.
   * @param request - the interaction, without a waiter.
   * @param capacity - maximum number of simultaneous interactions.
   * @returns the stored request, or undefined at capacity.
   */
  add(request: PendingRequest, capacity: number): PendingRequest | undefined {
    if (this.items.size >= capacity) return undefined
    // The store owns its own copy: settling must never mutate the caller's object.
    const stored: PendingRequest = { ...request }
    this.items.set(stored.id, stored)
    return stored
  }

  /** The dialog-facing views of every waiting interaction, oldest first. */
  views(): readonly PendingView[] {
    return [...this.items.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((request) => pendingView(request))
  }

  /** One waiting interaction. */
  get(id: string): PendingRequest | undefined {
    return this.items.get(id)
  }

  /** Number of waiting interactions. */
  get size(): number {
    return this.items.size
  }

  /**
   * Wait for the human's decision. Resolves `'timeout'` when the dialog window
   * closes first, and rejects with {@link SecretAbortedError} when the caller
   * withdraws or the store is drained.
   */
  wait(id: string, options: WaitOptions): Promise<WaitOutcome> {
    const request = this.items.get(id)
    if (request === undefined) {
      return Promise.reject(new SecretAbortedError('the dialog interaction is no longer waiting'))
    }
    if (request.answer !== undefined) {
      return Promise.resolve({ kind: 'answer', answer: request.answer })
    }
    return new Promise<WaitOutcome>((resolve, reject) => {
      let cancelTimer: () => void = () => {}
      const cleanup = () => {
        cancelTimer()
        options.signal.removeEventListener('abort', onAbort)
      }
      const finish = (outcome: WaitOutcome) => {
        cleanup()
        this.waiters.delete(id)
        resolve(outcome)
      }
      function onAbort() {
        cleanup()
        reject(new SecretAbortedError())
      }
      this.waiters.set(id, { resolve: finish, reject })
      options.signal.addEventListener('abort', onAbort, { once: true })
      cancelTimer = options.schedule(options.timeoutMs, () => {
        finish({ kind: 'timeout' })
      })
      if (options.signal.aborted) onAbort()
    })
  }

  /** Submit one decision. Returns false for an unknown or already-answered id. */
  settle(id: string, answer: ModalAnswer): boolean {
    const request = this.items.get(id)
    if (request === undefined || request.answer !== undefined) return false
    request.answer = answer
    const waiter = this.waiters.get(id)
    if (waiter !== undefined) {
      this.waiters.delete(id)
      waiter.resolve({ kind: 'answer', answer })
    }
    return true
  }

  /** Forget one interaction (its request finished). */
  remove(id: string): void {
    this.items.delete(id)
    this.waiters.delete(id)
  }

  /** Forget everything (plugin unload / session teardown). */
  clear(): void {
    this.items.clear()
    this.waiters.clear()
  }

  /** Wake every waiter as aborted, e.g. when the plugin unloads. */
  abortAll(): void {
    for (const [id, waiter] of [...this.waiters]) {
      this.waiters.delete(id)
      waiter.reject(new SecretAbortedError('the secret plugin unloaded while a dialog was open'))
    }
    this.items.clear()
  }
}
