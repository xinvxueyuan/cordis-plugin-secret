#!/usr/bin/env node
/**
 * Wrap the emitted client artifact so that a second evaluation in the same realm
 * cannot collide with the first one's top-level lexical declarations.
 *
 * Why this exists
 * ---------------
 * `lib/client/entry.js` is a *classic script* that the Harness web module system
 * loads with `<script src=...>` (dsh-client-modules: one fresh script element per
 * load, `atRevision` only rewrites the `rev=` query). Evaluating the same flat
 * script twice in one realm is therefore not a hypothetical: the second copy
 * throws `SyntaxError: Identifier '...' has already been declared` while parsing,
 * so that copy registers nothing at all — the update is silently lost and the
 * page keeps running the old factory until a hard reload.
 *
 * Putting the same bytes inside a function scope removes every top-level lexical
 * declaration, so a second evaluation parses and runs. This script is that shell:
 * it is a pure byte-level concatenation, it never edits the emitted content, and
 * it is idempotent (a second run on an already wrapped file is a no-op).
 *
 * What it does NOT change
 * -----------------------
 * Only the *parse-time* failure is addressed. The host's own guard against
 * registering the same module id twice without invalidating it first still throws
 * `duplicate factory registration` — that is host contract, and a client artifact
 * cannot lift it (see README's client-loading notes and the r10 report).
 *
 * Usage
 * -----
 *   node scripts/wrap-client.mjs              # wraps lib/client/entry.js
 *   node scripts/wrap-client.mjs <file>       # wraps an explicit file
 *
 * The emitted file stays a classic script: this script refuses to wrap anything
 * that contains a top-level `import`/`export` statement, because the wrapper's
 * function scope would be the wrong place for one.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Idempotency marker; also the first thing in the wrapped file. */
export const MARKER = '/*__secret_iife_wrapper__*/'

/**
 * The exact shell. `HEAD + <emitted bytes> + TAIL` is the wrapped file, byte for
 * byte, and unwrap() is the exact inverse. `"use strict";` is repeated on purpose:
 * as the first statement of the function body it is a directive prologue, so the
 * wrapped code stays in strict mode whatever the emitted file starts with.
 */
export const WRAP_HEAD = `${MARKER}\n;(function () {\n"use strict";\n`
export const WRAP_TAIL = `\n})();\n`

const HEAD_BYTES = Buffer.from(WRAP_HEAD, 'utf8')
const TAIL_BYTES = Buffer.from(WRAP_TAIL, 'utf8')
const MARKER_BYTES = Buffer.from(MARKER, 'utf8')

/** True when this file already carries the wrapper marker. */
export function isWrapped(buffer) {
  return buffer.includes(MARKER_BYTES)
}

/** Add the shell unless it is already there (idempotent). */
export function wrapBytes(buffer) {
  if (isWrapped(buffer)) return buffer
  return Buffer.concat([HEAD_BYTES, buffer, TAIL_BYTES])
}

/**
 * Remove the shell. Throws (rather than guessing) when the bytes are not exactly
 * one HEAD + payload + TAIL envelope, so a half-written wrapper can never pass as
 * "unwrapped".
 */
export function unwrapBytes(buffer) {
  if (buffer.length < HEAD_BYTES.length + TAIL_BYTES.length) {
    throw new Error('wrap-client: file is shorter than the wrapper envelope')
  }
  if (!buffer.subarray(0, HEAD_BYTES.length).equals(HEAD_BYTES)) {
    throw new Error('wrap-client: file does not start with the wrapper head')
  }
  if (!buffer.subarray(buffer.length - TAIL_BYTES.length).equals(TAIL_BYTES)) {
    throw new Error('wrap-client: file does not end with the wrapper tail')
  }
  return buffer.subarray(HEAD_BYTES.length, buffer.length - TAIL_BYTES.length)
}

/** Wrap `target` in place. Returns a small report; never writes when unnecessary. */
export function wrapFile(target) {
  const before = readFileSync(target)
  if (isWrapped(before)) {
    return { target, changed: false, bytesBefore: before.length, bytesAfter: before.length }
  }
  const text = before.toString('utf8')
  if (/^\s*(?:import|export)\s/m.test(text)) {
    throw new Error(
      `wrap-client: ${target} contains a top-level import/export statement, so it is not a classic script; refusing to wrap it`,
    )
  }
  const after = wrapBytes(before)
  writeFileSync(target, after)
  return { target, changed: true, bytesBefore: before.length, bytesAfter: after.length }
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const target = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(here, '..', 'lib', 'client', 'entry.js')
  const report = wrapFile(target)
  const rel = path.relative(path.join(here, '..'), target).replace(/\\/g, '/')
  if (!report.changed) {
    console.log(`wrap-client: ${rel} already carries ${MARKER} — left untouched (${report.bytesBefore} bytes)`)
    return
  }
  console.log(
    `wrap-client: wrapped ${rel} ${report.bytesBefore} -> ${report.bytesAfter} bytes (+${report.bytesAfter - report.bytesBefore}); top-level declarations are now inside a function scope`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
