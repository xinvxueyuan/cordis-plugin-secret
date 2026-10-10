/**
 * Gate for the wrapped client artifact (`t47`).
 *
 * The client artifact is loaded by the Harness web module system as a classic
 * `<script>`; every load — including every reload — creates a *fresh* script
 * element in the same realm, so the same bytes are evaluated more than once. A
 * flat script cannot survive that: the second copy dies at parse time with
 * `SyntaxError: Identifier '...' has already been declared` and registers
 * nothing, which is how a plugin update silently kept running the old client
 * until a hard reload.
 *
 * `npm run build` therefore ends with `node scripts/wrap-client.mjs`, which puts
 * the emitted bytes inside a function scope. This test pins the resulting
 * contract:
 *   - the artifact is a classic script (no import/export) with zero *script-level*
 *     lexical declarations (counted with the TypeScript parser, not by text
 *     column: after wrapping the emitted lines are still at column 0, they are
 *     simply not at script level any more);
 *   - the shell is exactly `WRAP_HEAD + emitted bytes + WRAP_TAIL`, so unwrapping
 *     recovers the flat script byte for byte;
 *   - evaluating the artifact twice in one realm is safe (two registrations);
 *   - the positive control still fails: the *unwrapped* text throws on a second
 *     evaluation;
 *   - the legitimate HMR path (invalidate, then evaluate) replaces the factory.
 *
 * Prerequisite: `npm run build` must have run (this test says so explicitly when
 * the artifact is missing). Every evaluation happens in its own `vm` context; the
 * test process's own globals are never used as a sandbox (asserted at the end).
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import type * as TypeScript from 'typescript'

const require_ = createRequire(import.meta.url)
const ts = require_('typescript') as typeof TypeScript

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const ARTIFACT = path.join(REPO, 'lib', 'client', 'entry.js')
const WRAPPER_SCRIPT = path.join(REPO, 'scripts', 'wrap-client.mjs')

const MARKER = '/*__secret_iife_wrapper__*/'
/**
 * These literals mirror `scripts/wrap-client.mjs`. One test below reads that file
 * back, so if the wrapper's format changes and these copies are not updated, the
 * gate fails loudly instead of drifting.
 */
const WRAP_HEAD = `${MARKER}\n;(function () {\n"use strict";\n`
const WRAP_TAIL = `\n})();\n`
const HEAD_BYTES = Buffer.from(WRAP_HEAD, 'utf8')
const TAIL_BYTES = Buffer.from(WRAP_TAIL, 'utf8')

/** The test process must not gain loader globals; remember how it started. */
const PROCESS_HAD_LOADER = '__ModuleLoader__' in globalThis

const artifactBytes = (): Buffer => {
  assert.ok(
    existsSync(ARTIFACT),
    `missing ${ARTIFACT} — run \`npm run build\` first: its last step (node scripts/wrap-client.mjs) is what wraps the client artifact`,
  )
  return readFileSync(ARTIFACT)
}

/** Exact inverse of the wrapper envelope; refuses half-written shells. */
const unwrap = (buffer: Buffer): Buffer => {
  assert.ok(buffer.length > HEAD_BYTES.length + TAIL_BYTES.length, 'artifact is shorter than the wrapper envelope')
  assert.ok(buffer.subarray(0, HEAD_BYTES.length).equals(HEAD_BYTES), 'artifact does not start with the wrapper head')
  assert.ok(buffer.subarray(buffer.length - TAIL_BYTES.length).equals(TAIL_BYTES), 'artifact does not end with the wrapper tail')
  return buffer.subarray(HEAD_BYTES.length, buffer.length - TAIL_BYTES.length)
}

/** Script-level lexical declarations (and ESM statements), via the TS parser. */
const parseCensus = (text: string): { lexical: number; esm: number } => {
  const file = ts.createSourceFile('entry.js', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  // `parseDiagnostics` exists on the parser's SourceFile but is not part of the
  // public type; read it defensively so a clean parse is still asserted.
  const parseDiagnostics = (file as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? []
  assert.equal(parseDiagnostics.length, 0, 'the artifact must parse cleanly')
  let lexical = 0
  let esm = 0
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0) lexical += 1
    else if (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) lexical += 1
    else if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) esm += 1
  }
  return { lexical, esm }
}

/** Evaluate `source` in an isolated context with a loader that just records. */
const evaluate = (context: vm.Context, source: string, filename: string): unknown => {
  try {
    vm.runInContext(source, context, { filename })
    return undefined
  } catch (error) {
    return error
  }
}

const lenientContext = (): { context: vm.Context; loads: unknown[] } => {
  const loads: unknown[] = []
  const context = vm.createContext({ __ModuleLoader__: { load: (registration: unknown) => loads.push(registration) } })
  return { context, loads }
}

test('the client artifact exists, carries the wrapper marker and a complete shell', () => {
  const bytes = artifactBytes()
  const text = bytes.toString('utf8')
  assert.ok(text.includes(MARKER), 'the wrapper marker must be present')
  assert.ok(text.startsWith(WRAP_HEAD), 'the artifact must start with the wrapper head')
  assert.ok(text.endsWith(WRAP_TAIL), `the artifact must end with the wrapper tail (${JSON.stringify(WRAP_TAIL)})`)
  assert.ok(text.endsWith('})();\n'), 'the shell must close with })();')
})

test('the wrapper is a pure shell: zero script-level declarations, and unwrapping restores the flat script', () => {
  const bytes = artifactBytes()
  const wrapped = parseCensus(bytes.toString('utf8'))
  assert.equal(wrapped.lexical, 0, 'no lexical declaration may remain at script level')
  assert.equal(wrapped.esm, 0, 'the artifact must stay a classic script (no import/export)')

  const inner = unwrap(bytes).toString('utf8')
  const flat = parseCensus(inner)
  assert.ok(flat.lexical > 100, `the unwrapped text must still be the flat emitted script (saw ${flat.lexical} declarations)`)
  assert.equal(flat.esm, 0, 'the emitted script has no import/export')
  assert.ok(inner.startsWith('"use strict";'), 'the emitted script starts with the strict-mode directive')
})

test('the wrapper literals in this gate mirror scripts/wrap-client.mjs', () => {
  assert.ok(existsSync(WRAPPER_SCRIPT), `missing ${WRAPPER_SCRIPT}`)
  const source = readFileSync(WRAPPER_SCRIPT, 'utf8')
  for (const fragment of [MARKER, ';(function () {', '})();', `"use strict";`]) {
    assert.ok(source.includes(fragment), `scripts/wrap-client.mjs no longer contains ${JSON.stringify(fragment)}`)
  }
})

test('one evaluation in a fresh realm registers exactly one factory', () => {
  const bytes = artifactBytes().toString('utf8')
  const { context, loads } = lenientContext()
  const error = evaluate(context, bytes, 'artifact-first.js')
  assert.equal(error, undefined, `first evaluation must succeed, got ${String(error)}`)
  assert.equal(loads.length, 1, 'the artifact registers exactly once per evaluation')
})

test('a second evaluation in the SAME realm parses and registers again', () => {
  const bytes = artifactBytes().toString('utf8')
  const { context, loads } = lenientContext()
  assert.equal(evaluate(context, bytes, 'artifact-1.js'), undefined)
  const second = evaluate(context, bytes, 'artifact-2.js')
  assert.equal(second, undefined, `second evaluation must not throw, got ${String(second)}`)
  assert.equal(loads.length, 2, 'both evaluations must have registered')
})

test('positive control: the unwrapped flat text throws on a second evaluation', () => {
  const flat = unwrap(artifactBytes()).toString('utf8')
  const { context, loads } = lenientContext()
  assert.equal(evaluate(context, flat, 'flat-1.js'), undefined, 'the flat script evaluates once')
  const second = evaluate(context, flat, 'flat-2.js')
  // Cross-realm: the SyntaxError is constructed inside the vm context, so
  // `instanceof SyntaxError` cannot be used here — check its shape instead.
  const failure = second as { name?: unknown; message?: unknown }
  assert.equal(failure?.name, 'SyntaxError', `expected SyntaxError on the flat second evaluation, got ${String(second)}`)
  assert.match(String(failure?.message), /already been declared/)
  assert.equal(loads.length, 1, 'the failed copy registers nothing')
})

test('the HMR path (invalidate, then evaluate) replaces the factory', () => {
  const bytes = artifactBytes().toString('utf8')
  const registry = new Map<unknown, { factory?: unknown }>()
  const context = vm.createContext({
    __ModuleLoader__: {
      load: (registration: { id: unknown; factory?: unknown }) => {
        if (registry.has(registration.id)) throw new Error('duplicate factory registration')
        registry.set(registration.id, registration)
      },
    },
  })
  assert.equal(evaluate(context, bytes, 'hmr-1.js'), undefined, 'first load registers')
  const firstFactory = [...registry.values()][0]?.factory
  for (const id of [...registry.keys()]) registry.delete(id) // host invalidate(id)
  assert.equal(evaluate(context, bytes, 'hmr-2.js'), undefined, 'the reloaded copy must register after invalidate')
  const secondFactory = [...registry.values()][0]?.factory
  assert.equal(registry.size, 1)
  assert.equal(typeof firstFactory, 'function')
  assert.equal(typeof secondFactory, 'function')
  assert.notEqual(firstFactory, secondFactory, 'the reloaded copy must replace the factory')
})

test('strict mode survives the wrapper', () => {
  // Mechanism: a "use strict" directive prologue at the top of a function body
  // puts that whole function in strict mode. Checked behaviourally in a scratch
  // realm, then structurally on our own artifact.
  const mechanism = vm.runInContext(
    '(function () { "use strict"; try { undeclaredProbeInStrictMode = 1; return "sloppy" } catch { return "strict" } })()',
    vm.createContext({}),
  )
  assert.equal(mechanism, 'strict', 'a directive prologue inside a function body must enable strict mode')

  const inner = unwrap(artifactBytes()).toString('utf8')
  assert.ok(inner.startsWith('"use strict";'), 'the wrapped body begins with the emitted directive, so the function stays strict')
})

test('evaluating the artifact never touched this process\'s own globals', () => {
  assert.equal('__ModuleLoader__' in globalThis, PROCESS_HAD_LOADER, 'the gate must not install a loader on the test process')
})
