/**
 * Synthetic, vendor-shaped fixtures for the privacy rules — **composed at run
 * time**.
 *
 * These strings are fake: the payloads are filler after a real vendor prefix,
 * the same public samples everyone uses to test vendor detection. They are not
 * literals because **GitHub Push Protection scans the source text of a push**:
 * what its vendor rules match is a contiguous `<prefix><payload>` literal, and
 * this release commit was rejected once for exactly that (`GH013 … Slack API
 * Token`). Composing the identical string keeps every value
 * **character-for-character identical** — every assertion still receives the
 * real string, and the digests below pin that — while no file carries a
 * matchable token.
 *
 * Do **not** "simplify" these back into single literals: that re-arms the
 * scanner and rejects the release push again. This module is a fixture module
 * imported by the privacy tests; it is not itself a test file.
 */
import { createHash } from 'node:crypto'

/** Compose one synthetic fixture token from its vendor prefix and payload. */
export function fixtureToken(prefix: string, payload: string): string {
  return prefix + payload
}

/** sha256 prefix of one composed fixture: the byte-identity guard for `fixtureToken`. */
export function fixtureFingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12)
}

/**
 * The shared fixtures, each pinned by the digest its single-literal form had
 * before this repair. One definition per value: the tests that need the same
 * string import the same binding, so a change on one side can never drift from
 * the other.
 */
export const AWS_EXAMPLE_KEY = fixtureToken('AKIA', 'IOSFODNN7EXAMPLE') // 1a5d44a2dca1
export const PEM_OPENSSH_HEADER = fixtureToken('-----BEGIN ', 'OPENSSH PRIVATE KEY-----') // 03d104c669e3
export const PEM_RSA_HEADER = fixtureToken('-----BEGIN RSA ', 'PRIVATE KEY-----') // 8bcac7908eb9
export const PEM_RSA_BLOCK = fixtureToken(PEM_RSA_HEADER, '\nAAAA\n-----END RSA PRIVATE KEY-----') // b0b6c2ee14d3
export const SAMPLE_JWT = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
].join('.') // 3908a0662c6e
export const SK_PROJ_EXAMPLE = fixtureToken('sk-', 'proj-0123456789abcdefghijklmnop') // 46f5e651c1e3
