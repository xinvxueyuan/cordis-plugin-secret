import assert from 'node:assert/strict'
import { test } from 'node:test'
import { anchorSessionOf, classifyCaller, credentialsPort, sessionOf } from '../src/adapters.ts'
import { findAnchorSeq } from '../src/anchor.ts'
import { approvedResult, mapNonApproved, planGrant } from '../src/decisions.ts'
import { EnvContributorRegistry, agentIdOf } from '../src/envs.ts'
import { GrantStore, type GrantSessionLike } from '../src/grants.ts'
import { deriveEnvVar, effectiveEnvVar, recordKey, validateRequest } from '../src/naming.ts'
import { PendingStore, SecretAbortedError } from '../src/pending.ts'
import { parseAnswer } from '../src/protocol.ts'
import {
  SecretFailure,
  SecretService,
  callerFailure,
  type AuthorizationAttemptInput,
  type AuthorizationAttemptResult,
  type AuthorizationPort,
  type CallerClass,
  type CredentialsPort,
  type SecretServiceDeps,
} from '../src/service.ts'
import type { ModalAnswer, SecretRequestResult } from '../src/types.ts'
import { defineSecretRequestTool } from '../src/tool.ts'

const SECRET = 'sk-live-DO-NOT-LEAK'

/** Minimal scripted session satisfying every structural contract the plugin reads. */
class FakeSession implements GrantSessionLike {
  id = 'session-root'
  nodes: number[] = []
  replaceGeneration = 0
  contentGeneration = 0
  ownFrom = 0
  events: { type: string; seq: number; data?: unknown }[] = []

  get seq(): number {
    return this.events.length
  }

  get surface(): { nodes: readonly number[]; replaceGeneration: number } {
    return { nodes: this.nodes, replaceGeneration: this.replaceGeneration }
  }

  isOwnSeq(seq: number): boolean {
    return seq >= this.ownFrom && seq < this.seq
  }

  snapshotEvents(): readonly { type: string; seq: number; data?: unknown }[] {
    return this.events
  }
}

function sessionWithCall(callId: string, options: { sessionId?: string; inheritedFrom?: number } = {}): FakeSession {
  const session = new FakeSession()
  session.id = options.sessionId ?? 'session-root'
  session.ownFrom = options.inheritedFrom ?? 0
  session.events = [
    { type: 'user/message', seq: 0, data: { message: { content: [{ type: 'text', text: 'go' }] } } },
    {
      type: 'assistant/message',
      seq: 1,
      data: { message: { content: [{ type: 'tool-call', id: callId, name: 'secret_request', arguments: '{}' }] } },
    },
    { type: 'tool/call', seq: 2, data: { callId } },
  ]
  session.nodes = [0, 1]
  return session
}

interface Harness {
  readonly service: SecretService
  readonly calls: string[]
  readonly store: Map<string, string>
  readonly session: FakeSession
}

function harness(
  options: {
    session?: FakeSession
    classify?: CallerClass
    configured?: boolean
    schedule?: SecretServiceDeps['schedule']
    authorization?: AuthorizationPort
    maxPendingRequests?: number
    /** Overrides for the fake credential port, e.g. a throwing backend. */
    credentials?: Partial<CredentialsPort>
  } = {},
): Harness {
  const calls: string[] = []
  const store = new Map<string, string>()
  const session = options.session ?? sessionWithCall('call-1')
  const credentials: CredentialsPort = {
    describe: async (ref) => {
      calls.push(`describe:${ref}`)
      const configured = options.configured === true || store.has(ref)
      return configured ? { configured: true, source: 'provider', writable: true } : { configured: false, writable: true }
    },
    resolve: async (ref) => {
      calls.push(`resolve:${ref}`)
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'provider' }
    },
    set: async (ref, value) => {
      calls.push(`set:${ref}`)
      store.set(ref, value)
    },
    commitRecord: async (key) => {
      calls.push(`commitRecord:${key}`)
    },
    ...options.credentials,
  }
  const authorization: AuthorizationPort =
    options.authorization ??
    {
      attempt: async (input: AuthorizationAttemptInput): Promise<AuthorizationAttemptResult> => {
        calls.push(`attempt:${input.key}`)
        const answer = await input.answer()
        if (answer.decision !== 'approved') return { status: 'escaped', reason: answer.decision }
        if (answer.scope !== 'persistent') return { status: 'escaped', reason: 'session-override' }
        if (input.valueNeeded) await input.persist(answer.value ?? '')
        await credentials.commitRecord(input.key, input.marker())
        calls.push('committed')
        return { status: 'authorized' }
      },
    }
  let counter = 0
  const service = new SecretService({
    config: { requestTimeoutMs: 60000, maxPendingRequests: options.maxPendingRequests ?? 4 },
    credentials,
    authorization,
    envs: { ensure: (envVar) => calls.push(`ensure:${envVar}`) },
    classifyCaller: () => options.classify ?? 'live-root',
    sessionOf: () => session,
    anchorSessionOf: () => session,
    now: () => 1700000000000,
    schedule: options.schedule ?? (() => () => undefined),
    newId: () => `req-${String((counter += 1))}`,
  })
  return { service, calls, store, session }
}

/** Answer the first waiting dialog once the request has registered it. */
async function answerNext(service: SecretService, build: (id: string) => unknown): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const view = service.views()[0]
    if (view !== undefined) {
      const outcome = service.answer(build(view.id))
      assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error)
      return
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  }
  throw new Error('the secret request never registered a pending dialog')
}

function approvedJson(result: SecretRequestResult): string {
  return JSON.stringify(result)
}

test('validateRequest accepts a minimal request and an envVar override', () => {
  const minimal = validateRequest({ name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'session' })
  assert.equal(minimal.ok, true)
  if (minimal.ok) {
    assert.deepEqual(minimal.value, { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'session' })
  }
  const overridden = validateRequest({
    name: 'openai_key',
    label: 'OpenAI',
    reason: 'run completions',
    scope: 'persistent',
    description: 'used by the eval harness',
    envVar: 'DSH_SECRET_OPENAI',
  })
  assert.equal(overridden.ok, true)
  if (overridden.ok) assert.equal(overridden.value.envVar, 'DSH_SECRET_OPENAI')
})

test('validateRequest rejects missing reason, label and scope, and bad names', () => {
  const missingReason = validateRequest({ name: 'openai', label: 'OpenAI', scope: 'session' })
  assert.equal(missingReason.ok, false)
  if (!missingReason.ok) assert.match(missingReason.error, /reason is required/u)

  const missingLabel = validateRequest({ name: 'openai', reason: 'because', scope: 'session' })
  assert.equal(missingLabel.ok, false)
  if (!missingLabel.ok) assert.match(missingLabel.error, /label is required/u)

  const missingScope = validateRequest({ name: 'openai', label: 'OpenAI', reason: 'because' })
  assert.equal(missingScope.ok, false)
  if (!missingScope.ok) assert.match(missingScope.error, /scope is required/u)

  for (const name of ['OpenAI', '-openai', 'open ai', 'openai!', '', '9lives']) {
    const bad = validateRequest({ name, label: 'L', reason: 'R', scope: 'session' })
    assert.equal(bad.ok, false, `name ${JSON.stringify(name)} must be rejected`)
  }

  const badEnvVar = validateRequest({
    name: 'openai',
    label: 'L',
    reason: 'R',
    scope: 'session',
    envVar: 'OPENAI_KEY',
  })
  assert.equal(badEnvVar.ok, false)

  const reserved = validateRequest({
    name: 'openai',
    label: 'L',
    reason: 'R',
    scope: 'session',
    envVar: 'DSH_SESSION_ID',
  })
  assert.equal(reserved.ok, false)
})

test('variable names derive from name, and envVar overrides them', () => {
  assert.equal(deriveEnvVar('openai'), 'DSH_SECRET_OPENAI')
  assert.equal(deriveEnvVar('openai-key'), 'DSH_SECRET_OPENAI_KEY')
  assert.equal(deriveEnvVar('openai_key'), 'DSH_SECRET_OPENAI_KEY')
  assert.equal(deriveEnvVar('a1-b2_c3'), 'DSH_SECRET_A1_B2_C3')
  assert.equal(effectiveEnvVar({ name: 'openai', label: 'l', reason: 'r', scope: 'session' }), 'DSH_SECRET_OPENAI')
  assert.equal(
    effectiveEnvVar({ name: 'openai', label: 'l', reason: 'r', scope: 'session', envVar: 'DSH_SECRET_CUSTOM' }),
    'DSH_SECRET_CUSTOM',
  )
  // CredentialKey segments only allow [a-z0-9-]; underscores must not reach them.
  assert.equal(recordKey('openai_key'), 'cordis-plugin-secret/openai-key')
})

test('decision mapping covers all four decisions without carrying a value', () => {
  const rejected = mapNonApproved({ decision: 'rejected', reason: 'no' })
  assert.deepEqual(rejected, { decision: 'rejected', reason: 'no' })
  assert.deepEqual(mapNonApproved({ decision: 'rejected' }), { decision: 'rejected' })
  assert.deepEqual(mapNonApproved({ decision: 'ignored' }), { decision: 'ignored' })
  assert.deepEqual(mapNonApproved({ decision: 'other', text: 'use the sandbox key' }), {
    decision: 'other',
    text: 'use the sandbox key',
  })

  const planSession = planGrant({ answerScope: 'session', answerValue: SECRET, alreadyConfigured: false })
  const planPersistent = planGrant({ answerScope: 'persistent', answerValue: SECRET, alreadyConfigured: false })
  const planStored = planGrant({ answerScope: 'persistent', alreadyConfigured: true })
  const results: SecretRequestResult[] = [
    approvedResult(planSession, 'DSH_SECRET_OPENAI'),
    approvedResult(planPersistent, 'DSH_SECRET_OPENAI'),
    approvedResult(planStored, 'DSH_SECRET_OPENAI'),
    rejected,
    mapNonApproved({ decision: 'ignored' }),
    mapNonApproved({ decision: 'other', text: 'later' }),
  ]
  for (const result of results) {
    assert.equal(approvedJson(result).includes(SECRET), false)
    assert.equal(approvedJson(result).includes('sk-live'), false)
  }
  assert.equal(approvedJson(approvedResult(planPersistent, 'DSH_SECRET_OPENAI')).includes('DSH_SECRET_OPENAI'), true)
})

test('session and persistent approvals take different storage routes', () => {
  const session = planGrant({ answerScope: 'session', answerValue: SECRET, alreadyConfigured: false })
  assert.equal(session.storage, 'session-entered')
  assert.equal(session.refSpace, 'session-shell-env')
  assert.equal(session.source, 'entered')

  const persistent = planGrant({ answerScope: 'persistent', answerValue: SECRET, alreadyConfigured: false })
  assert.equal(persistent.storage, 'credentials-set')
  assert.equal(persistent.refSpace, 'credential-ref')
  assert.equal(persistent.source, 'entered')

  const existing = planGrant({ answerScope: 'persistent', alreadyConfigured: true })
  assert.equal(existing.storage, 'credentials-existing')
  assert.equal(existing.source, 'store')
  assert.equal(existing.persistValue, undefined)

  const existingSession = planGrant({ answerScope: 'session', alreadyConfigured: true })
  assert.equal(existingSession.storage, 'session-from-store')
  assert.equal(existingSession.resolveValue, true)
})

test('parseAnswer rebuilds answers field by field and refuses a value on a rejection', () => {
  const smuggled = parseAnswer({ id: 'x', decision: 'rejected', value: SECRET }, true)
  assert.equal(smuggled.ok, true)
  if (smuggled.ok) {
    assert.deepEqual(smuggled.answer, { decision: 'rejected' })
    assert.equal(JSON.stringify(smuggled.answer).includes(SECRET), false)
  }
  assert.equal(parseAnswer({ id: 'x', decision: 'approved', scope: 'session' }, true).ok, false)
  assert.equal(parseAnswer({ id: 'x', decision: 'approved', scope: 'session', value: SECRET }, false).ok, true)
  assert.equal(parseAnswer({ id: 'x', decision: 'other' }, true).ok, false)
  assert.equal(parseAnswer({ decision: 'ignored' }, true).ok, false)
  assert.equal(parseAnswer({ id: 'x', decision: 'maybe' }, true).ok, false)
})

test('an approved session request keeps the value in memory and never touches the store', async () => {
  const { service, calls, session } = harness()
  const pending = service.request(
    { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'session' },
    { agent: { id: session.id }, callId: 'call-1', signal: new AbortController().signal },
  )
  await answerNext(service, (id) => ({ id, decision: 'approved', scope: 'session', value: SECRET }))
  const result = await pending

  assert.equal(result.decision, 'approved')
  if (result.decision === 'approved') {
    assert.equal(result.variable, 'DSH_SECRET_OPENAI')
    assert.equal(result.scope, 'session')
    assert.equal(result.source, 'entered')
    assert.deepEqual(result.ref, { space: 'session-shell-env', name: 'DSH_SECRET_OPENAI' })
  }
  assert.equal(calls.filter((call) => call.startsWith('set:')).length, 0)
  assert.equal(calls.some((call) => call.startsWith('attempt:')), false)
  assert.equal(calls.includes('ensure:DSH_SECRET_OPENAI'), true)
  assert.equal(approvedJson(result).includes(SECRET), false)
  assert.equal(service.grants.valueFor(session, 'DSH_SECRET_OPENAI'), SECRET)
  assert.equal(service.grants.size(), 1)
})

test('an approved persistent request writes through credentials and commits a record', async () => {
  const { service, calls, store, session } = harness()
  const pending = service.request(
    { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'persistent' },
    { agent: { id: session.id }, callId: 'call-1', signal: new AbortController().signal },
  )
  await answerNext(service, (id) => ({ id, decision: 'approved', scope: 'persistent', value: SECRET }))
  const result = await pending

  assert.equal(result.decision, 'approved')
  if (result.decision === 'approved') {
    assert.equal(result.ref.space, 'credential-ref')
    assert.equal(result.source, 'entered')
  }
  assert.deepEqual(calls.filter((call) => call.startsWith('set:')), ['set:DSH_SECRET_OPENAI'])
  assert.equal(store.get('DSH_SECRET_OPENAI'), SECRET)
  assert.deepEqual(calls.filter((call) => call.startsWith('attempt:')), ['attempt:cordis-plugin-secret/openai'])
  assert.equal(calls.includes('committed'), true)
  assert.equal(approvedJson(result).includes(SECRET), false)
})

test('an already-stored credential is exposed without asking for a value again', async () => {
  const { service, calls, store, session } = harness({ configured: true })
  store.set('DSH_SECRET_OPENAI', SECRET)
  const pending = service.request(
    { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'persistent' },
    { agent: { id: session.id }, callId: 'call-1', signal: new AbortController().signal },
  )
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const view = service.views()[0]
    if (view !== undefined) {
      assert.equal(view.alreadyConfigured, true)
      // No value is submitted for an already-configured credential.
      assert.equal(service.answer({ id: view.id, decision: 'approved', scope: 'persistent' }).ok, true)
      break
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  }
  const result = await pending
  assert.equal(result.decision, 'approved')
  if (result.decision === 'approved') {
    assert.equal(result.source, 'store')
    assert.equal(result.scope, 'persistent')
  }
  assert.equal(calls.filter((call) => call.startsWith('set:')).length, 0)
  assert.equal(approvedJson(result).includes(SECRET), false)
})

test('a human scope override turns a persistent request into a memory-only grant', async () => {
  const { service, calls, session } = harness()
  const pending = service.request(
    { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'persistent' },
    { agent: { id: session.id }, callId: 'call-1', signal: new AbortController().signal },
  )
  await answerNext(service, (id) => ({ id, decision: 'approved', scope: 'session', value: SECRET }))
  const result = await pending
  assert.equal(result.decision, 'approved')
  if (result.decision === 'approved') {
    assert.equal(result.scope, 'session')
    assert.equal(result.ref.space, 'session-shell-env')
  }
  assert.equal(calls.filter((call) => call.startsWith('set:')).length, 0)
  assert.equal(calls.includes('committed'), false)
  assert.equal(service.grants.valueFor(session, 'DSH_SECRET_OPENAI'), SECRET)
})

test('rejected, ignored and other decisions map onto their results', async () => {
  const cases: { answer: ModalAnswer; expected: string }[] = [
    { answer: { decision: 'rejected', reason: 'not needed' }, expected: 'rejected' },
    { answer: { decision: 'ignored' }, expected: 'ignored' },
    { answer: { decision: 'other', text: 'use the staging key' }, expected: 'other' },
  ]
  for (const item of cases) {
    const { service, session } = harness()
    const pending = service.request(
      { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'session' },
      { agent: { id: session.id }, callId: 'call-1', signal: new AbortController().signal },
    )
    await answerNext(service, (id) => ({ id, ...item.answer }))
    const result = await pending
    assert.equal(result.decision, item.expected)
    assert.equal(service.grants.size(), 0)
    if (result.decision === 'other') assert.equal(result.text, 'use the staging key')
  }
})

test('a delegated or non-live caller fails closed before any dialog exists', async () => {
  for (const callerClass of ['delegated', 'not-live'] as const) {
    const { service, calls, session } = harness({ classify: callerClass })
    await assert.rejects(
      service.request(
        { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'session' },
        { agent: { id: session.id }, callId: 'call-1', signal: new AbortController().signal },
      ),
      (error: unknown) => {
        assert.equal(error instanceof SecretFailure, true)
        const failure = error as SecretFailure
        assert.equal(failure.code, callerClass === 'delegated' ? 'DELEGATED_CALLER' : 'CALLER_NOT_LIVE')
        assert.match(failure.message, /会话根代理/u)
        assert.equal(failure.message.includes(SECRET), false)
        return true
      },
    )
    assert.equal(service.views().length, 0)
    assert.equal(calls.length, 0)
  }
  assert.equal(callerFailure('delegated').code, 'DELEGATED_CALLER')
  assert.equal(callerFailure('not-live').code, 'CALLER_NOT_LIVE')
})

test('an unanswered dialog times out into a structured failure', async () => {
  const fired = { value: false }
  const { service, session } = harness({
    schedule: (_delayMs, callback) => {
      if (!fired.value) {
        fired.value = true
        void Promise.resolve().then(callback)
      }
      return () => undefined
    },
  })
  await assert.rejects(
    service.request(
      { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'session' },
      { agent: { id: session.id }, callId: 'call-1', signal: new AbortController().signal },
    ),
    (error: unknown) => {
      assert.equal(error instanceof SecretFailure, true)
      assert.equal((error as SecretFailure).code, 'TIMEOUT')
      return true
    },
  )
  assert.equal(service.grants.size(), 0)
})

test('O1: a recorded approval outlives a failed attempt, and never claims persistence', async () => {
  const { service, session, store, calls } = harness({
    authorization: {
      attempt: async (input: AuthorizationAttemptInput): Promise<AuthorizationAttemptResult> => {
        const answer = await input.answer()
        assert.equal(answer.decision, 'approved')
        assert.equal(input.valueNeeded, true)
        // The seam reports a failed attempt. It may or may not have written the
        // value before failing to commit — which is exactly why the plugin's
        // notice must not assert either way.
        return { status: 'failed', message: 'credential store write failed' }
      },
    },
  })
  const pending = service.request(
    { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'persistent' },
    { agent: { id: session.id }, callId: 'call-1', signal: new AbortController().signal },
  )
  await answerNext(service, (id) => ({ id, decision: 'approved', scope: 'persistent', value: SECRET }))
  const result = await pending

  // The human's decision stands (it is not discarded as an authorization failure)...
  assert.equal(result.decision, 'approved')
  if (result.decision !== 'approved') return
  // ...but the result must not pretend the durable write happened, and must not
  // over-claim the opposite either.
  assert.equal(result.scope, 'session')
  assert.equal(result.ref.space, 'session-shell-env')
  assert.equal(result.source, 'entered')
  assert.match(String(result.notice), /未能完成持久化登记的确认/u)
  assert.equal(/未做任何持久化|已写入凭据库/u.test(String(result.notice)), false)
  // In this fake the plugin's own path never calls `set` — but that is a
  // property of this fake, not a promise about the real seam (which persists
  // before it commits).
  assert.equal(store.has('DSH_SECRET_OPENAI'), false)
  assert.equal(calls.some((entry) => entry.startsWith('set:')), false)
  assert.equal(JSON.stringify(result).includes(SECRET), false)
  // The value is still usable for this session only, as reported.
  assert.equal(service.grants.valueFor(session, 'DSH_SECRET_OPENAI'), SECRET)
})

test('a credential-store read failure is collapsed into a value-free SecretFailure', async () => {
  // A backend error the plugin cannot control, quoting something it must never
  // forward into a tool result.
  const sentinel = 'postgres://dsh:sk-store-DO-NOT-LEAK@127.0.0.1:5432/creds'

  const readFailing = harness({
    configured: true,
    credentials: {
      resolve: async () => {
        throw new Error(`credential backend exploded: ${sentinel}`)
      },
    },
  })
  const pending = readFailing.service.request(
    { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'session' },
    { agent: { id: readFailing.session.id }, callId: 'call-1', signal: new AbortController().signal },
  )
  await answerNext(readFailing.service, (id) => ({ id, decision: 'approved', scope: 'session' }))
  await assert.rejects(pending, (error: unknown) => {
    assert.equal(error instanceof SecretFailure, true)
    const failure = error as SecretFailure
    assert.equal(failure.code, 'STORE_READ_FAILED')
    assert.equal(failure.message, '凭据库读取失败；细节已省略')
    assert.equal(failure.message.includes(sentinel), false, 'the upstream error text must not be forwarded')
    assert.equal(String(error).includes(sentinel), false)
    return true
  })

  // The same convergence on the describe() path, which runs before any dialog.
  const describeFailing = harness({
    credentials: {
      describe: async () => {
        throw new Error(`credential backend exploded: ${sentinel}`)
      },
    },
  })
  await assert.rejects(
    describeFailing.service.request(
      { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'session' },
      { agent: { id: describeFailing.session.id }, callId: 'call-1', signal: new AbortController().signal },
    ),
    (error: unknown) => {
      assert.equal(error instanceof SecretFailure, true)
      assert.equal((error as SecretFailure).code, 'STORE_READ_FAILED')
      assert.equal((error as SecretFailure).message.includes(sentinel), false)
      return true
    },
  )
  assert.equal(describeFailing.service.views().length, 0, 'no dialog may be registered for a failed read')

  // The same rule on the seam's own failure text: it is never forwarded, even
  // when no approval was recorded to redact against.
  const seamFailing = harness({
    authorization: {
      attempt: async (): Promise<AuthorizationAttemptResult> => ({
        status: 'failed',
        message: `credential backend exploded: ${sentinel}`,
      }),
    },
  })
  await assert.rejects(
    seamFailing.service.request(
      { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'persistent' },
      { agent: { id: seamFailing.session.id }, callId: 'call-1', signal: new AbortController().signal },
    ),
    (error: unknown) => {
      assert.equal(error instanceof SecretFailure, true)
      assert.equal((error as SecretFailure).code, 'AUTHORIZATION_FAILED')
      assert.equal((error as SecretFailure).message.includes(sentinel), false, 'the seam text must not be forwarded')
      assert.equal(String(error).includes(sentinel), false)
      return true
    },
  )
})

test('O2: a persistent wait that times out reports TIMEOUT, not a generic authorization failure', async () => {
  const fired = { value: false }
  const { service, session } = harness({
    schedule: (_delayMs, callback) => {
      if (!fired.value) {
        fired.value = true
        void Promise.resolve().then(callback)
      }
      return () => undefined
    },
    authorization: {
      attempt: async (input: AuthorizationAttemptInput): Promise<AuthorizationAttemptResult> => {
        try {
          await input.answer()
        } catch {
          // The flow rethrows the plugin's own TIMEOUT; the seam turns that into
          // a failed attempt, which must not mask the timeout.
        }
        return { status: 'failed', message: 'secret_request: 等待人工确认超时。' }
      },
    },
  })
  await assert.rejects(
    service.request(
      { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'persistent' },
      { agent: { id: session.id }, callId: 'call-1', signal: new AbortController().signal },
    ),
    (error: unknown) => {
      assert.equal(error instanceof SecretFailure, true)
      assert.equal((error as SecretFailure).code, 'TIMEOUT')
      return true
    },
  )
  assert.equal(service.grants.size(), 0)
})

test('the persisted presentation payload is value-free for every decision', () => {
  const tool = defineSecretRequestTool(
    { request: async () => ({ decision: 'ignored' }) } as never,
    { requestTimeoutMs: 1000, maxPendingRequests: 1 } as never,
  )
  const present = (value: unknown): Record<string, unknown> =>
    (tool.output as unknown as { presentationMeta: (args: unknown, value: unknown) => unknown }).presentationMeta(
      {},
      value,
    ) as Record<string, unknown>

  const approved = present({
    decision: 'approved',
    variable: 'DSH_SECRET_OPENAI',
    scope: 'session',
    ref: { space: 'session-shell-env', name: 'DSH_SECRET_OPENAI' },
    source: 'entered',
    notice: '降级说明',
  })
  assert.equal(approved.v, 1)
  assert.equal(approved.kind, 'secret-request')
  assert.equal(approved.decision, 'approved')
  assert.equal(approved.variable, 'DSH_SECRET_OPENAI')
  assert.equal(approved.scope, 'session')
  assert.equal(approved.source, 'entered')
  assert.equal(approved.notice, '降级说明')
  assert.equal('value' in approved, false)

  const rejected = present({ decision: 'rejected', reason: 'not this key' })
  assert.deepEqual(rejected, { v: 1, kind: 'secret-request', decision: 'rejected', reason: 'not this key' })
  const ignored = present({ decision: 'ignored' })
  assert.deepEqual(ignored, { v: 1, kind: 'secret-request', decision: 'ignored' })
  const other = present({ decision: 'other', text: 'use the sandbox key' })
  assert.deepEqual(other, { v: 1, kind: 'secret-request', decision: 'other', text: 'use the sandbox key' })

  // The invariant: no arm of the payload can carry the value the human typed.
  for (const payload of [approved, rejected, ignored, other]) {
    assert.equal(JSON.stringify(payload).includes(SECRET), false)
    assert.equal('value' in payload, false)
  }
})

test('a grant is revoked when its anchor leaves the session surface and the entry is dropped', async () => {
  const { service, session } = harness()
  const pending = service.request(
    { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'session' },
    { agent: { id: session.id }, callId: 'call-1', signal: new AbortController().signal },
  )
  await answerNext(service, (id) => ({ id, decision: 'approved', scope: 'session', value: SECRET }))
  await pending
  assert.equal(service.grants.resolve(session, 'openai').code, 'ok')

  // Edit-an-earlier-message-and-retry rewrites the surface: the anchoring
  // assistant message is shadowed and the grant must die with it.
  session.nodes = []
  const lookup = service.grants.resolve(session, 'openai')
  assert.equal(lookup.code, 'revoked-anchor')
  assert.equal(service.grants.size(), 0)
  assert.equal(service.grants.valueFor(session, 'DSH_SECRET_OPENAI'), undefined)

  // The next request explains why it is asked again.
  const again = service.request(
    { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'session' },
    { agent: { id: session.id }, callId: 'call-1', signal: new AbortController().signal },
  )
  session.nodes = [0, 1]
  await answerNext(service, (id) => ({ id, decision: 'approved', scope: 'session', value: SECRET }))
  const result = await again
  assert.equal(result.decision, 'approved')
  if (result.decision === 'approved') assert.match(String(result.notice), /回退/u)
})

test('replaceGeneration moving on its own never revokes; a real fold that keeps the anchor does not either', async () => {
  const { service, session } = harness()
  const pending = service.request(
    { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'session' },
    { agent: { id: session.id }, callId: 'call-1', signal: new AbortController().signal },
  )
  await answerNext(service, (id) => ({ id, decision: 'approved', scope: 'session', value: SECRET }))
  await pending

  // The counter alone is irrelevant: it is recorded for diagnosis, never compared.
  session.replaceGeneration += 3
  assert.equal(service.grants.resolve(session, 'openai').code, 'ok')

  // A compaction folds earlier events into a summary: the surface really is
  // rewritten (an unrelated node leaves it) and the generation advances — but
  // the anchoring assistant message is still on it, so the grant stands.
  session.nodes = [1]
  session.replaceGeneration += 1
  assert.equal(service.grants.resolve(session, 'openai').code, 'ok')
  assert.equal(service.grants.valueFor(session, 'DSH_SECRET_OPENAI'), SECRET)
  assert.equal(service.grants.size(), 1)
})

test('a compaction that folds the anchoring event away revokes the grant', async () => {
  const { service, session } = harness()
  const pending = service.request(
    { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'session' },
    { agent: { id: session.id }, callId: 'call-1', signal: new AbortController().signal },
  )
  await answerNext(service, (id) => ({ id, decision: 'approved', scope: 'session', value: SECRET }))
  await pending
  assert.equal(service.grants.size(), 1)

  // This time the summary swallowed the anchoring event itself: fail closed.
  session.nodes = [0]
  session.replaceGeneration += 1
  assert.equal(service.grants.resolve(session, 'openai').code, 'revoked-anchor')
  assert.equal(service.grants.valueFor(session, 'DSH_SECRET_OPENAI'), undefined)
  assert.equal(service.grants.size(), 0)
})

test('a forked child cannot see the parent grant, and the parent keeps it', async () => {
  const parent = sessionWithCall('call-1', { sessionId: 'session-parent' })
  const { service } = harness({ session: parent })
  const pending = service.request(
    { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'session' },
    { agent: { id: parent.id }, callId: 'call-1', signal: new AbortController().signal },
  )
  await answerNext(service, (id) => ({ id, decision: 'approved', scope: 'session', value: SECRET }))
  await pending
  assert.equal(service.grants.resolve(parent, 'openai').code, 'ok')

  const child = sessionWithCall('call-1', { sessionId: 'session-child', inheritedFrom: 3 })
  child.events = parent.events.map((event) => ({ ...event }))
  child.nodes = [0, 1]
  assert.equal(service.grants.resolve(child, 'openai').code, 'not-found')
  assert.equal(service.grants.valueFor(child, 'DSH_SECRET_OPENAI'), undefined)
  assert.equal(service.grants.resolve(parent, 'openai').code, 'ok')

  // A grant the child obtained itself is not the parent's either.
  assert.equal(service.grants.validNames(child).length, 0)
  assert.deepEqual(service.grants.validNames(parent), ['openai'])
})

test('a grant inherited through a fork seed is not the child\'s own event', () => {
  const store = new GrantStore()
  const child = sessionWithCall('call-1', { sessionId: 'session-child', inheritedFrom: 3 })
  store.put({
    sessionId: 'session-child',
    name: 'openai',
    envVar: 'DSH_SECRET_OPENAI',
    scope: 'session',
    value: SECRET,
    source: 'entered',
    anchorSeq: 1,
    callId: 'call-1',
    replaceGenerationAtApproval: 0,
    authorizedAt: 0,
  })
  assert.equal(store.resolve(child, 'openai').code, 'revoked-not-own')
  assert.equal(store.size(), 0)
})

test('findAnchorSeq anchors on the assistant message that issued the call', () => {
  const session = sessionWithCall('call-1')
  assert.equal(findAnchorSeq(session, 'call-1'), 1)
  assert.equal(findAnchorSeq(session, 'call-missing'), undefined)
})

test('session end forgets every session-scoped grant', async () => {
  const { service, session } = harness()
  const pending = service.request(
    { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'session' },
    { agent: { id: session.id }, callId: 'call-1', signal: new AbortController().signal },
  )
  await answerNext(service, (id) => ({ id, decision: 'approved', scope: 'session', value: SECRET }))
  await pending
  assert.equal(service.grants.size(), 1)
  service.grants.forget(String(session.id))
  assert.equal(service.grants.size(), 0)
  assert.equal(service.grants.valueFor(session, 'DSH_SECRET_OPENAI'), undefined)
})

test('pending store settles once, times out and rejects on abort', async () => {
  const store = new PendingStore()
  const makeRequest = (id: string) => ({
    id,
    callId: `call-${id}`,
    sessionId: 'session-root',
    name: 'openai',
    envVar: 'DSH_SECRET_OPENAI',
    label: 'OpenAI',
    reason: 'because',
    requestedScope: 'session' as const,
    alreadyConfigured: false,
    createdAt: 1,
  })
  assert.notEqual(store.add(makeRequest('r1'), 1), undefined)
  assert.equal(store.add(makeRequest('r2'), 1), undefined)
  assert.equal(store.views()[0]?.id, 'r1')
  // The card claims its request by the call that raised it, so the view must
  // carry both identities.
  assert.equal(store.views()[0]?.callId, 'call-r1')
  assert.equal(store.views()[0]?.sessionId, 'session-root')

  const waiting = store.wait('r1', {
    signal: new AbortController().signal,
    timeoutMs: 10,
    schedule: () => () => undefined,
  })
  assert.equal(store.settle('r1', { decision: 'ignored' }), true)
  assert.equal(store.settle('r1', { decision: 'ignored' }), false)
  const outcome = await waiting
  assert.equal(outcome.kind, 'answer')

  const aborting = new PendingStore()
  aborting.add(makeRequest('r3'), 4)
  const abortController = new AbortController()
  const aborted = aborting.wait('r3', {
    signal: abortController.signal,
    timeoutMs: 10,
    schedule: () => () => undefined,
  })
  abortController.abort()
  await assert.rejects(aborted, (error: unknown) => error instanceof SecretAbortedError)

  const timingOut = new PendingStore()
  timingOut.add(makeRequest('r4'), 4)
  const timed = await timingOut.wait('r4', {
    signal: new AbortController().signal,
    timeoutMs: 5,
    schedule: (_delay, callback) => {
      callback()
      return () => undefined
    },
  })
  assert.equal(timed.kind, 'timeout')
})

/** One captured `shellEnv` declaration, as the registry hands it to the context. */
interface ContributorLike {
  readonly name: string
  readonly variables: Record<string, unknown>
  readonly resolve: (execution: { agent?: unknown }) => Record<string, string>
}

/** A fake context carrying only what `EnvContributorRegistry` reads. */
function envHarness(): {
  readonly ctx: unknown
  readonly contributors: ContributorLike[]
  readonly teardowns: (() => void)[]
  readonly sessions: Map<string, FakeSession>
  readonly undeclared: string[]
} {
  const contributors: ContributorLike[] = []
  const teardowns: (() => void)[] = []
  const sessions = new Map<string, FakeSession>()
  const undeclared: string[] = []
  const ctx = {
    effect(fn: () => void | (() => void)) {
      const teardown = fn()
      if (typeof teardown === 'function') teardowns.push(teardown)
      return () => undefined
    },
    sessions: {
      get: (id: unknown) => sessions.get(String(id)),
    },
    shellEnv: {
      register(contributor: ContributorLike) {
        contributors.push(contributor)
        return () => {
          undeclared.push(contributor.name)
          const index = contributors.indexOf(contributor)
          if (index >= 0) contributors.splice(index, 1)
        }
      },
    },
  }
  return { ctx, contributors, teardowns, sessions, undeclared }
}

function grantFor(session: FakeSession, overrides: Partial<Parameters<GrantStore['put']>[0]> = {}) {
  return {
    sessionId: session.id,
    name: 'openai',
    envVar: 'DSH_SECRET_OPENAI',
    scope: 'session' as const,
    value: SECRET,
    source: 'entered' as const,
    anchorSeq: 1,
    callId: 'call-1',
    replaceGenerationAtApproval: 0,
    authorizedAt: 0,
    ...overrides,
  }
}

test('the env contributor injects a value only while the execution session still holds the grant', () => {
  const session = sessionWithCall('call-1')
  const { ctx, contributors, teardowns, sessions, undeclared } = envHarness()
  sessions.set(session.id, session)
  const grants = new GrantStore()
  const registry = new EnvContributorRegistry(ctx as never, grants)

  registry.ensure('DSH_SECRET_OPENAI')
  registry.ensure('DSH_SECRET_OPENAI')
  assert.equal(contributors.length, 1, 'one variable is declared once')
  assert.equal(registry.declared('DSH_SECRET_OPENAI'), true)
  assert.deepEqual(Object.keys(contributors[0]?.variables ?? {}), ['DSH_SECRET_OPENAI'])

  grants.put(grantFor(session))
  assert.deepEqual(contributors[0]?.resolve({ agent: { id: session.id } }), { DSH_SECRET_OPENAI: SECRET })

  // An execution with no agent, an unknown session, and a forked child get nothing.
  assert.deepEqual(contributors[0]?.resolve({}), {})
  assert.deepEqual(contributors[0]?.resolve({ agent: { id: 'session-elsewhere' } }), {})
  const child = sessionWithCall('call-1', { sessionId: 'session-child', inheritedFrom: 3 })
  sessions.set(child.id, child)
  assert.deepEqual(contributors[0]?.resolve({ agent: { id: child.id } }), {})

  // A session-scope grant whose anchor leaves the surface stops being injected,
  // and the value is not served twice.
  session.nodes = []
  assert.deepEqual(contributors[0]?.resolve({ agent: { id: session.id } }), {})
  assert.deepEqual(contributors[0]?.resolve({ agent: { id: session.id } }), {})
  assert.equal(grants.size(), 0)

  // Disposal (plugin unload) withdraws the declaration rather than serving {}.
  registry.disposeAll()
  assert.equal(registry.declared('DSH_SECRET_OPENAI'), false)
  assert.equal(contributors.length, 0)
  assert.deepEqual(undeclared, ['cordis-plugin-secret:DSH_SECRET_OPENAI'])

  // The registry also owns a teardown on the context that disposes everything.
  registry.ensure('DSH_SECRET_OPENAI')
  assert.equal(registry.declared('DSH_SECRET_OPENAI'), true)
  const teardown = teardowns[0]
  assert.notEqual(teardown, undefined)
  if (teardown !== undefined) teardown()
  assert.equal(registry.declared('DSH_SECRET_OPENAI'), false)
  assert.equal(contributors.length, 0)
})

test('agentIdOf reads the session id an agent carries, and refuses anything else', () => {
  assert.equal(agentIdOf({ id: 'session-a' }), 'session-a')
  // A nested session header wins over a bare id.
  assert.equal(agentIdOf({ session: { header: { id: 'session-b' } }, id: 'session-a' }), 'session-b')
  assert.equal(agentIdOf({ session: { header: {} }, id: 'session-a' }), 'session-a')
  assert.equal(agentIdOf({ session: { header: { id: '' } }, id: 'session-a' }), 'session-a')
  assert.equal(agentIdOf({ id: '' }), undefined)
  assert.equal(agentIdOf({}), undefined)
  assert.equal(agentIdOf('session-a'), undefined)
  assert.equal(agentIdOf(undefined), undefined)
})

test('classifyCaller separates the live root from a delegated child and a stale id', () => {
  const root = { id: 'session-root' }
  const child = { id: 'session-child' }
  const ctx = {
    agents: {
      get: (id: unknown) => (id === root.id ? root : id === child.id ? child : undefined),
      roots: () => [root],
    },
  }
  assert.equal(classifyCaller(ctx as never, root), 'live-root')
  assert.equal(classifyCaller(ctx as never, child), 'delegated')
  assert.equal(classifyCaller(ctx as never, { id: 'session-gone' }), 'not-live')
  assert.equal(classifyCaller(ctx as never, {}), 'not-live')
  assert.equal(classifyCaller(ctx as never, undefined), 'not-live')
})

test('sessionOf and anchorSessionOf read the live session from the same registry, or nothing', () => {
  const session = sessionWithCall('call-1')
  const ctx = { sessions: { get: (id: unknown) => (String(id) === session.id ? session : undefined) } }
  assert.equal(sessionOf(ctx as never, { id: session.id }), session)
  assert.equal(anchorSessionOf(ctx as never, { id: session.id }), session)
  assert.equal(sessionOf(ctx as never, {}), undefined)
  assert.equal(anchorSessionOf(ctx as never, undefined), undefined)
})

test('credentialsPort maps the credential service and never returns a value it was not asked for', async () => {
  const store = new Map<string, string>()
  const written: string[] = []
  const records: { key: string; record: unknown }[] = []
  const ctx = {
    credentials: {
      describe: async (ref: string) =>
        store.has(ref)
          ? { configured: true, source: 'provider', writable: true }
          : { configured: false, writable: true },
      resolve: async (ref: string) => {
        const value = store.get(ref)
        return value === undefined ? undefined : { value, source: 'provider' }
      },
      set: async (ref: string, value: string) => {
        written.push(ref)
        store.set(ref, value)
      },
      modifyRecord: async (key: string, update: (previous: unknown) => Promise<unknown>) => {
        records.push({ key, record: await update(undefined) })
      },
    },
  }
  const port = credentialsPort(ctx as never)
  assert.deepEqual(await port.describe('DSH_SECRET_OPENAI'), { configured: false, writable: true })
  assert.equal(await port.resolve('DSH_SECRET_OPENAI'), undefined)

  await port.set('DSH_SECRET_OPENAI', SECRET)
  assert.deepEqual(written, ['DSH_SECRET_OPENAI'])
  assert.deepEqual(await port.describe('DSH_SECRET_OPENAI'), { configured: true, source: 'provider', writable: true })
  assert.deepEqual(await port.resolve('DSH_SECRET_OPENAI'), { value: SECRET, source: 'provider' })

  await port.commitRecord('cordis-plugin-secret/openai', { version: 1, envVar: 'DSH_SECRET_OPENAI' })
  assert.deepEqual(records, [
    {
      key: 'cordis-plugin-secret/openai',
      record: { kind: 'grant', payload: { version: 1, envVar: 'DSH_SECRET_OPENAI' } },
    },
  ])
})
