/**
 * The one test file that mounts the plugin on the **real** Connection service.
 *
 * Every other wiring test in this repository drives the plugin through
 * `test/register.test.ts`'s fake context, whose `connection.fetch` registry is a
 * local object. That fake is where the 0.4.0 release blocker hid: it accepted two
 * registrations for one exact path, the real registry does not, and the whole
 * plugin entry therefore failed to activate in the field
 * (``dsh: warning: 1 entry did not activate``,
 * ``connection: exact Fetch route "/api/secret.manage" is already registered``).
 * A later round closed the gap by *replicating* the real rule in that fake; this
 * file closes it for good by mounting on the real
 * `@deepseek-ai/dsh-client-connection` `HostConnectionService` inside a real
 * cordis `Context`, so the registry under test is the package the Host runs.
 *
 * Nothing here starts a server, reads a credential or dispatches a request: the
 * services the plugin injects are the smallest in-memory stubs that satisfy the
 * ports `apply` touches, and only the routing table and the tool registry are
 * inspected afterwards.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { Config, apply, inject, name } from '../src/index.ts'
import {
  ADOPT_PATH,
  ANSWER_PATH,
  ATTACHED_PATH,
  ATTACH_PATH,
  AVAILABLE_PATH,
  HISTORY_PATH,
  MANAGE_PATH,
  PENDING_PATH,
  RELEASE_PATH,
} from '../src/routes.ts'

/**
 * Lifecycle states of one plugin fiber (`@deepseek-ai/cordis/lib/types/fiber.d.ts:67-74`).
 *
 * They are declared as a `const enum`, which has no runtime representation, so
 * the values are spelled out here; `FAILED` is the state the field saw when the
 * duplicate registration threw during activation.
 */
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3

/** One tool as the plugin handed it to the real `tools` service. */
interface CapturedTool {
  readonly name: string
  readonly parameters?: { readonly properties?: Record<string, unknown> }
}

/** One registration as the real registry stores it. */
interface RegisteredRoute {
  readonly methods: Set<string>
  readonly requestBody: string
}

interface RealAssembly {
  readonly ctx: Context
  readonly connection: HostConnectionService
  readonly tools: CapturedTool[]
  /** The real registry's own table (declared private at the type level). */
  readonly routes: Map<string, RegisteredRoute>
}

/** The full routing table this plugin must mount, one registration per path. */
const EXPECTED_TABLE = [
  `${PENDING_PATH} GET`,
  `${ATTACHED_PATH} GET`,
  `${HISTORY_PATH} GET`,
  `${AVAILABLE_PATH} GET`,
  `${ATTACH_PATH} POST`,
  `${RELEASE_PATH} POST`,
  `${ANSWER_PATH} POST`,
  `${ADOPT_PATH} POST`,
  `${MANAGE_PATH} GET+POST`,
].sort()

/**
 * Build a real `Context`, give it a real Connection service, and stub only the
 * six other services the plugin injects. The stubs are recorded so the test can
 * prove which tools were registered.
 */
function assemble(): RealAssembly {
  const ctx = new Context()
  // Route registration never consults the browser-authentication half of the
  // service, and a live Host supplies the real one; only the registry matters
  // here, so the constructor's third slot gets a documented placeholder.
  const browserAuth = {} as unknown as ConstructorParameters<typeof HostConnectionService>[2]
  const connection = new HostConnectionService(ctx, [], browserAuth)
  const tools: CapturedTool[] = []
  const provide = (service: string, value: unknown): void => {
    ctx.reflect.provide(service, value)
  }
  provide('tools', {
    register: (tool: CapturedTool) => {
      tools.push(tool)
      return () => undefined
    },
  })
  provide('shellEnv', { register: () => () => undefined })
  provide('authorization', {
    registerFlow: () => () => undefined,
    begin: async () => ({ status: 'authorized' }),
  })
  provide('credentials', {
    describe: async () => ({ configured: false, writable: true }),
    resolve: async () => undefined,
    set: async () => undefined,
  })
  provide('sessions', { get: () => undefined })
  provide('agents', { get: () => undefined, roots: () => [] })
  const routes = (connection as unknown as { fetchRoutes: Map<string, RegisteredRoute> }).fetchRoutes
  return { ctx, connection, tools, routes }
}

/** Mount the plugin the way the Host does: the module's own entry object. */
function mount(ctx: Context): ReturnType<Context['plugin']> {
  return ctx.plugin({ name, inject, Config, apply }, {})
}

test('the plugin mounts on the real Connection service, one registration per exact path', async () => {
  const { ctx, tools, routes } = assemble()
  const fiber = mount(ctx)

  // `await` settles the fiber; a failure would reject here with the activation
  // error, which is exactly how the field lost the whole entry in 0.4.0.
  await fiber.await()
  assert.equal(
    fiber.state as number,
    FIBER_ACTIVE,
    `the entry must activate (FAILED would be ${String(FIBER_FAILED)})`,
  )

  // The real registry's own table: nine exact paths, each registered once.
  assert.deepEqual([...routes.keys()].sort(), [
    ADOPT_PATH,
    ANSWER_PATH,
    ATTACHED_PATH,
    ATTACH_PATH,
    AVAILABLE_PATH,
    HISTORY_PATH,
    MANAGE_PATH,
    PENDING_PATH,
    RELEASE_PATH,
  ].sort(), 'every exact path exactly once')

  // The whole table, path × methods — the shape the fake registry could not
  // check, and the evidence the field failure was about.
  assert.deepEqual(
    [...routes.entries()].map(([path, route]) => `${path} ${[...route.methods].join('+')}`).sort(),
    EXPECTED_TABLE,
  )
  const manage = routes.get(MANAGE_PATH)
  assert.equal(manage?.methods.size, 2, 'one registration, both methods')
  assert.equal(manage?.requestBody, 'buffered')

  // Both tools reached the tool registry, each with its parameter schema.
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['secret_manage', 'secret_request'])
  for (const tool of tools) {
    assert.equal(typeof tool.parameters?.properties, 'object', `${tool.name} must carry its schema`)
  }
  const manageTool = tools.find((tool) => tool.name === 'secret_manage')
  assert.deepEqual(Object.keys(manageTool?.parameters?.properties ?? {}).sort(), [
    'action',
    'reason',
    'target',
    'to',
    'variable',
  ], 'the management tool still has no value parameter')

  // Leave no fiber behind: the plugin's own disposers run here.
  await fiber.dispose()
})

test('the real registry refuses a duplicate exact path, as the field reported', async () => {
  const { ctx, routes } = assemble()
  const fiber = mount(ctx)
  await fiber.await()
  assert.equal(fiber.state as number, FIBER_ACTIVE)

  // The pre-0.4.1 shape, reproduced against the real service: the same exact
  // path again, this time declaring only POST. `methods` play no part in the
  // rule — the table is keyed by pathname alone.
  assert.throws(
    () => {
      ctx.connection.fetch.register({
        path: MANAGE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: () => Promise.resolve(new Response('x')),
      })
    },
    (error: unknown) => {
      assert.equal(
        (error as Error).message,
        'connection: exact Fetch route "/api/secret.manage" is already registered',
      )
      // …and it comes from the real package, not from any fake of ours.
      assert.equal(String((error as Error).stack).includes('dsh-client-connection'), true)
      return true
    },
  )

  // The other two rules `assertFetchRoute` enforces are live here as well.
  assert.throws(
    () => {
      ctx.connection.fetch.register({
        path: '/api/secret.probe',
        methods: ['GET', 'GET'],
        requestBody: 'buffered',
        fetch: () => Promise.resolve(new Response('x')),
      })
    },
    /repeats a method/u,
  )
  assert.throws(
    () => {
      ctx.connection.fetch.register({
        path: '/api/secret.probe',
        methods: [],
        requestBody: 'buffered',
        fetch: () => Promise.resolve(new Response('x')),
      })
    },
    /declares no methods/u,
  )

  // The failed registrations left the mounted table exactly as it was.
  assert.deepEqual(
    [...routes.entries()].map(([path, route]) => `${path} ${[...route.methods].join('+')}`).sort(),
    EXPECTED_TABLE,
  )
  await fiber.dispose()
})
