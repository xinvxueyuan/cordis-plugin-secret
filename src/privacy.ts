/**
 * Mechanical privacy classification for text a human pasted into a **secret
 * value** field (round 7, R3).
 *
 * The whole job is one question: "does this pasted text look like secret
 * material, or like ordinary text nobody should attach a credential for?" The
 * answer has to be mechanical (no model, no network, no I/O), enumerable (a test
 * can list the rules and pin each one), and **conservative**.
 *
 * ## The asymmetry, and why it decides every threshold here
 *
 * A false positive is visible and bad: it turns a harmless paste — a URL, a
 * sentence, a filename — into a registered credential the human did not ask for.
 * A false negative is quiet and recoverable: the text simply stays in the field
 * and the human attaches it by hand, which is exactly what they did before this
 * feature existed. So every rule below is tuned to *miss rather than mislabel*:
 *
 * - a vendor prefix must be followed by at least {@link PRIVACY_THRESHOLDS.minVendorPayload}
 *   characters of token alphabet — `sk-` alone, or `sk-` in prose, is not a key;
 * - both statistical rules demand **at least one digit and one letter**, which
 *   removes ordinary words and slugs (`openai`, `production`, `verylongword…`);
 * - the short-token rule demands {@link PRIVACY_THRESHOLDS.minBitsPerChar} bits
 *   per character over at least {@link PRIVACY_THRESHOLDS.entropyTokenMinLength}
 *   characters, and a minimum number of *distinct* characters, so repetition
 *   (`aaaa…`, `ababab…`) never qualifies;
 * - the long-token rule additionally demands {@link PRIVACY_THRESHOLDS.longTokenMinDistinct}
 *   distinct characters over at least {@link PRIVACY_THRESHOLDS.longTokenMinLength};
 * - and a list of explicit exclusions (URL, filesystem path, e-mail, bare
 *   domain, identifier/key name, CJK prose, anything multi-line or containing
 *   whitespace) runs **before** the statistical rules, so a long harmless string
 *   is never rescued into a match by entropy alone.
 *
 * ## Reference text is never secret material
 *
 * A paste that is already a reference to a secret this plugin manages —
 * `@DSH_SECRET_*`, the `[secret DSH_SECRET_*]` note form, or one of our
 * `dsh-resource://` viewer addresses — must **not** be classified as secret
 * material: it carries a variable *name*, and registering it again would turn a
 * name into a credential. This check runs first, before every other rule.
 *
 * ## Value safety
 *
 * The verdict is value-free by construction: it carries a rule/exclusion id and
 * nothing else, so no caller can leak the paste through diagnostics, and a test
 * can assert that the returned object never contains the input.
 *
 * ## This file is the reference implementation, not the runtime one
 *
 * The runtime consumer is the **mirror** inside `src/client/entry.ts` (the client
 * artifact is a classic script that cannot import this module — see the mirror's
 * own header for why). This file is the specification a reader checks the mirror
 * against, and it is the side that `test/client-attach.test.ts` → "the client
 * mirror and the reference implementation agree" holds the mirror to: rule ids,
 * exclusion ids, every threshold constant, and a shared corpus case by case.
 * Nothing in `src/` calls this module at runtime, and nothing here pretends to.
 *
 * ## Why the client half carries a mirror of this file
 *
 * `src/client/entry.ts` is compiled to a **classic script** (`tsconfig.client.json`
 * emits a file with zero `import`/`export`, and the harness loads exactly that one
 * file), so it cannot import this module. The client half therefore mirrors these
 * rules locally — the same arrangement the client already uses for `deriveVariable`
 * / `markerOf` — and that test runs **both implementations over one shared corpus**
 * and asserts identical verdicts, so the two can never drift apart.
 */

/** The rule that fired for a match. Enumerable on purpose: a test lists them. */
export type PrivacyRuleId =
  /** `-----BEGIN …-----`: a PEM block header. */
  | 'pem'
  /** `eyJ…`.`…`.`…`: the three-part JWT shape. */
  | 'jwt'
  /** A publicly documented credential prefix (`sk-`, `ghp_`, `xoxb-`, `AKIA`, …). */
  | 'vendor-prefix'
  /** One long, whitespace-free run over a token alphabet, mixed digits and letters. */
  | 'long-concentrated'
  /** A shorter run that still carries enough per-character entropy. */
  | 'high-entropy'

/** Why a paste was **not** treated as secret material. Enumerable, for tests. */
export type PrivacyExclusionId =
  | 'empty'
  /** A reference to a managed secret (`@DSH_SECRET_*`, `[secret …]`, `dsh-resource://…`). */
  | 'reference'
  | 'url'
  | 'path'
  | 'email'
  | 'domain'
  | 'cjk'
  | 'multi-line'
  | 'whitespace'
  | 'identifier'

/** Every rule, in the order `classifyPastedText` applies them. */
export const PRIVACY_RULES: readonly PrivacyRuleId[] = [
  'pem',
  'jwt',
  'vendor-prefix',
  'long-concentrated',
  'high-entropy',
]

/** Every exclusion, in the order `classifyPastedText` applies them. */
export const PRIVACY_EXCLUSIONS: readonly PrivacyExclusionId[] = [
  'empty',
  'reference',
  'url',
  'path',
  'email',
  'domain',
  'cjk',
  'multi-line',
  'whitespace',
  'identifier',
]

/**
 * The numbers behind the statistical rules, exported so a test pins them and a
 * reader can see the trade-off instead of guessing it.
 */
export const PRIVACY_THRESHOLDS = {
  /** A vendor prefix needs at least this much token alphabet after it. */
  minVendorPayload: 8,
  /** `long-concentrated` needs at least this many characters. */
  longTokenMinLength: 32,
  /** `long-concentrated` needs at least this many distinct characters. */
  longTokenMinDistinct: 12,
  /** `high-entropy` needs at least this many characters. */
  entropyTokenMinLength: 20,
  /** `high-entropy` needs at least this many bits per character. */
  minBitsPerChar: 3.5,
  /** `high-entropy` needs at least this many distinct characters. */
  minDistinctChars: 10,
  /** The longest thing still recognisable as an identifier/key name. */
  identifierMaxLength: 40,
  /** The most `-`/`_`/`.` separated segments an identifier may have. */
  identifierMaxSegments: 4,
} as const

/** One match/no-match decision. Never carries the text it was made about. */
export interface PrivacyVerdict {
  readonly secret: boolean
  /** Present exactly when `secret` is true. */
  readonly rule?: PrivacyRuleId
  /** Present exactly when `secret` is false. */
  readonly exclusion?: PrivacyExclusionId
}

/**
 * Publicly documented credential prefixes, each with the vendor that documents it.
 *
 * A prefix is only half the evidence: the rule also insists on a token-alphabet
 * payload and on {@link PRIVACY_THRESHOLDS.minVendorPayload} characters, which is
 * what keeps prose like "sk- the short form" out.
 */
const VENDOR_PREFIXES: readonly { readonly prefix: string; readonly vendor: string }[] = [
  // OpenAI / Anthropic / Stripe secret keys, plus the `.`-joined Mapbox form.
  { prefix: 'sk-', vendor: 'OpenAI, Anthropic, Stripe (secret key)' },
  { prefix: 'sk.', vendor: 'Mapbox' },
  { prefix: 'sk_live_', vendor: 'Stripe' },
  { prefix: 'sk_test_', vendor: 'Stripe' },
  { prefix: 'rk_live_', vendor: 'Stripe (restricted key)' },
  { prefix: 'rk_test_', vendor: 'Stripe (restricted key)' },
  // GitHub tokens: classic, OAuth, user-to-server, server-to-server, refresh, fine-grained.
  { prefix: 'ghp_', vendor: 'GitHub' },
  { prefix: 'gho_', vendor: 'GitHub' },
  { prefix: 'ghu_', vendor: 'GitHub' },
  { prefix: 'ghs_', vendor: 'GitHub' },
  { prefix: 'ghr_', vendor: 'GitHub' },
  { prefix: 'github_pat_', vendor: 'GitHub (fine-grained)' },
  // Slack.
  { prefix: 'xoxb-', vendor: 'Slack (bot)' },
  { prefix: 'xoxp-', vendor: 'Slack (user)' },
  { prefix: 'xoxa-', vendor: 'Slack (app)' },
  { prefix: 'xoxr-', vendor: 'Slack (refresh)' },
  { prefix: 'xoxs-', vendor: 'Slack (app-level)' },
  // AWS access key ids.
  { prefix: 'AKIA', vendor: 'AWS (access key id)' },
  { prefix: 'ASIA', vendor: 'AWS (temporary access key id)' },
  // Google.
  { prefix: 'AIza', vendor: 'Google API key' },
  { prefix: 'ya29.', vendor: 'Google OAuth access token' },
  // Others with a documented, unambiguous prefix.
  { prefix: 'SG.', vendor: 'SendGrid' },
  { prefix: 'npm_', vendor: 'npm' },
  { prefix: 'pypi-', vendor: 'PyPI' },
  { prefix: 'dop_v1_', vendor: 'DigitalOcean' },
  { prefix: 'glpat-', vendor: 'GitLab' },
  { prefix: 'hf_', vendor: 'Hugging Face' },
  { prefix: 'shpat_', vendor: 'Shopify (admin)' },
  { prefix: 'shpss_', vendor: 'Shopify (shared secret)' },
  { prefix: 'shpca_', vendor: 'Shopify (custom app)' },
  { prefix: 'sq0atp-', vendor: 'Square (access token)' },
  { prefix: 'sq0csp-', vendor: 'Square (application secret)' },
  { prefix: 'dapi', vendor: 'Databricks' },
]

/** The alphabet real secrets are made of (base64, base64url, hex, dotted, padded). */
const TOKEN_ALPHABET = /^[A-Za-z0-9+/=_.-]+$/
/** CJK ideographs and CJK/full-width punctuation: prose, never material. */
const CJK = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/
/** A three-segment JWT, base64url alphabet. */
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/
/** A PEM header line (`-----BEGIN OPENSSH PRIVATE KEY-----` and friends). */
const PEM_HEADER = /^-----BEGIN [A-Z0-9 ]{1,40}-----$/
/** `scheme://…` and the bare `www.` form. */
const URL_SHAPE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
/** Windows drive, UNC, POSIX absolute, `./`, `../`, `~/` — a filesystem path. */
const PATH_SHAPES: readonly RegExp[] = [
  /^[A-Za-z]:[\\/]/,
  /^\\\\/,
  /^\//,
  /^\.{1,2}[\\/]/,
  /^~\//,
]
/** A single e-mail address. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/
/** A bare hostname (`example.com`, `api.example.co.uk`). */
const DOMAIN_SHAPE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/
/** Lowercase or uppercase word-separated names: `openai-key`, `DSH_SECRET_OPENAI`. */
const IDENTIFIER_SHAPE = /^[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+$/

/** The trimmed text, or `''` for anything that is not a string. */
function normalize(raw: string): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

/** Distinct characters in `text`. */
export function distinctCharCount(text: string): number {
  return new Set(text).size
}

/**
 * Shannon entropy of `text` in bits **per character**.
 *
 * This is the statistic the short-token rule compares against
 * {@link PRIVACY_THRESHOLDS.minBitsPerChar}; per character, not total, so the
 * threshold does not have to move when the length does.
 */
export function entropyBitsPerChar(text: string): number {
  if (text.length === 0) return 0
  const counts = new Map<string, number>()
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const probability = count / text.length
    bits -= probability * Math.log2(probability)
  }
  return bits
}

/**
 * Whether the text already refers to a secret this plugin manages.
 *
 * `@DSH_SECRET_*` is the `@`-menu form, `[secret DSH_SECRET_*]` is the note the
 * plugin writes into the model's view, and `dsh-resource://…` is the viewer
 * address the transcript capsule opens. All three are names, not material.
 */
export function isReferenceText(text: string): boolean {
  return text.includes('@DSH_SECRET_')
    || text.includes('[secret ')
    || text.includes('dsh-resource://')
}

/** Whether the text contains CJK ideographs or CJK/full-width punctuation. */
export function hasCjk(text: string): boolean {
  return CJK.test(text)
}

/** A word-separated lowercase/uppercase name, short and without digit runs. */
function isIdentifierLike(text: string): boolean {
  if (text.length > PRIVACY_THRESHOLDS.identifierMaxLength) return false
  if (!IDENTIFIER_SHAPE.test(text)) return false
  if (text.split(/[-_.]/).length > PRIVACY_THRESHOLDS.identifierMaxSegments) return false
  if (/\d{4,}/.test(text)) return false
  // Mixed case inside a word-separated string is not how humans name things,
  // and it is how random material looks, so it is left to the statistical rules.
  return text === text.toLowerCase() || text === text.toUpperCase()
}

/** A count of digits and letters, so the statistical rules can demand both. */
function letterAndDigitCounts(text: string): { letters: number; digits: number } {
  let letters = 0
  let digits = 0
  for (const character of text) {
    if (character >= '0' && character <= '9') digits += 1
    else if ((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')) letters += 1
  }
  return { letters, digits }
}

/** The three precise rules, in order. Returns the firing rule, or undefined. */
function preciseRule(text: string): PrivacyRuleId | undefined {
  if (PEM_HEADER.test(text.split(/\r?\n/, 1)[0] ?? '')) return 'pem'
  if (JWT_SHAPE.test(text)) return 'jwt'
  for (const entry of VENDOR_PREFIXES) {
    if (!text.startsWith(entry.prefix)) continue
    const payload = text.slice(entry.prefix.length)
    if (payload.length < PRIVACY_THRESHOLDS.minVendorPayload) continue
    if (!TOKEN_ALPHABET.test(text)) continue
    return 'vendor-prefix'
  }
  return undefined
}

/** The explicit exclusions that run before the statistical rules. */
function exclusionFor(text: string): PrivacyExclusionId | undefined {
  if (text.length === 0) return 'empty'
  if (isReferenceText(text)) return 'reference'
  if (URL_SHAPE.test(text) || /^www\./i.test(text)) return 'url'
  if (PATH_SHAPES.some((shape) => shape.test(text))) return 'path'
  if (EMAIL_SHAPE.test(text)) return 'email'
  if (DOMAIN_SHAPE.test(text)) return 'domain'
  if (hasCjk(text)) return 'cjk'
  if (text.includes('\n') || text.includes('\r')) return 'multi-line'
  if (/\s/.test(text)) return 'whitespace'
  if (isIdentifierLike(text)) return 'identifier'
  return undefined
}

/** The two statistical rules, in order. Returns the firing rule, or undefined. */
function statisticalRule(text: string): PrivacyRuleId | undefined {
  if (!TOKEN_ALPHABET.test(text)) return undefined
  const { letters, digits } = letterAndDigitCounts(text)
  if (letters === 0 || digits === 0) return undefined
  const distinct = distinctCharCount(text)
  if (
    text.length >= PRIVACY_THRESHOLDS.longTokenMinLength
    && distinct >= PRIVACY_THRESHOLDS.longTokenMinDistinct
  ) {
    return 'long-concentrated'
  }
  if (
    text.length >= PRIVACY_THRESHOLDS.entropyTokenMinLength
    && distinct >= PRIVACY_THRESHOLDS.minDistinctChars
    && entropyBitsPerChar(text) >= PRIVACY_THRESHOLDS.minBitsPerChar
  ) {
    return 'high-entropy'
  }
  return undefined
}

/**
 * Classify one pasted string.
 *
 * Total and pure: it never throws, never touches the network or the DOM, and
 * returns the same answer for the same input. The returned object carries ids
 * only — never the text — so it is safe to log, show or hand to a test.
 *
 * @param raw - the pasted text, exactly as it came out of the clipboard.
 */
export function classifyPastedText(raw: string): PrivacyVerdict {
  const text = normalize(raw)
  const precise = preciseRule(text)
  if (precise !== undefined) return { secret: true, rule: precise }
  const exclusion = exclusionFor(text)
  if (exclusion !== undefined) return { secret: false, exclusion }
  const statistical = statisticalRule(text)
  if (statistical !== undefined) return { secret: true, rule: statistical }
  return { secret: false }
}
