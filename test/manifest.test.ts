/**
 * Manifest gate for the shipped bundle surface.
 *
 * The Loader activates this plugin from `cordis.patch.yml` (exported through
 * `dsh.bundle.patch`), while the plugin itself only applies when every service
 * in `export const inject` is present. Those are two separate declarations of
 * the same dependency set: if they drift, a row can activate and then never
 * `apply`, or a service the plugin needs is missing from the Loader's wait set.
 * This test pins the two lists to each other instead of hard-coding either, and
 * pins the display resources (locale metadata and icon) that the Plugin Manager
 * and Settings read without activating the plugin.
 *
 * Read-only by design: it parses `package.json`, `cordis.patch.yml`,
 * `src/index.ts`, `locale/*.json` and `icon.svg` as text/JSON. It must stay
 * independent of `lib/` so it can run (and fail) the same way before and after
 * `npm run build`.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

interface PackageManifest {
  name: string
  icon?: string
  exports: Record<string, string | Record<string, string>>
  files: string[]
  scripts: Record<string, string>
  dsh: {
    bundle: { patch: string }
    client: { platform: string; inject: string[] }
  }
}

interface LocaleDocument {
  meta?: { title?: unknown; description?: unknown }
}

const readText = (relative: string): string => readFileSync(path.join(repoRoot, relative), 'utf8')

const manifest = JSON.parse(readText('package.json')) as PackageManifest
const patchText = readText('cordis.patch.yml')
const sourceText = readText('src/index.ts')

/** The row-level `inject: [...]` list in the patch (flow style, inside `insert`). */
function patchInject(): string[] {
  const match = /^\s+inject:\s*\[([^\]]*)\]\s*$/m.exec(patchText)
  assert.ok(match, 'cordis.patch.yml declares a row-level `inject: [...]` list')
  return match[1].split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

/** The string literals of `export const inject = [...]` in the plugin source. */
function sourceInject(): string[] {
  const match = /export\s+const\s+inject\s*=\s*\[([\s\S]*?)\]/.exec(sourceText)
  assert.ok(match, 'src/index.ts exports a literal `export const inject = [...]` list')
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1])
}

const asSet = (list: readonly string[]): string[] => [...new Set(list)].sort()

test('dsh.bundle.patch names the patch file that ships with the package', () => {
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(
    existsSync(path.join(repoRoot, manifest.dsh.bundle.patch)),
    `the declared patch file ${manifest.dsh.bundle.patch} must exist`,
  )
})

test('dsh.client still declares the web half', () => {
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(Array.isArray(manifest.dsh.client.inject), 'dsh.client.inject must be an array')
  assert.ok(manifest.dsh.client.inject.length > 0, 'dsh.client.inject must not be empty')
  for (const entry of manifest.dsh.client.inject) {
    assert.equal(typeof entry, 'string')
    assert.ok(entry.length > 0, 'dsh.client.inject entries must be non-empty package names')
  }
})

test('the patch inserts exactly one Loader row, `secret`, mounting this package', () => {
  const ids = [...patchText.matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)].map((match) => match[1])
  assert.deepEqual(ids, ['secret'], 'the patch must insert a single row whose id is `secret`')
  const name = /^\s+name:\s*'([^']+)'\s*$/m.exec(patchText)
  assert.ok(name, 'the inserted row declares a quoted `name`')
  assert.equal(name[1], manifest.name, 'the inserted row must name this package')
})

test('the patch keeps both Config defaults verbatim', () => {
  assert.match(patchText, /^\s+config:\s*$/m)
  assert.match(patchText, /^\s+requestTimeoutMs:\s*300000\s*$/m)
  assert.match(patchText, /^\s+maxPendingRequests:\s*4\s*$/m)
})

test('the patch inject list equals the exported inject list', () => {
  const fromPatch = patchInject()
  const fromSource = sourceInject()
  assert.ok(fromPatch.length > 0, 'the patch inject list must not be empty')
  assert.equal(new Set(fromPatch).size, fromPatch.length, 'the patch inject list must not repeat a service')
  assert.deepEqual(asSet(fromPatch), asSet(fromSource), 'patch `inject` and `export const inject` must match as sets')
})

test('the patch declares inject between name and config', () => {
  const nameAt = patchText.search(/^\s+name:/m)
  const injectAt = patchText.search(/^\s+inject:/m)
  const configAt = patchText.search(/^\s+config:/m)
  assert.ok(nameAt >= 0 && injectAt >= 0 && configAt >= 0, 'name, inject and config must all be declared')
  assert.ok(nameAt < injectAt, '`inject` must follow `name`')
  assert.ok(injectAt < configAt, '`inject` must precede `config`')
})

for (const locale of ['en', 'zh']) {
  test(`locale/${locale}.json carries display metadata`, () => {
    const document = JSON.parse(readText(`locale/${locale}.json`)) as LocaleDocument
    const meta = document.meta
    assert.ok(meta, `locale/${locale}.json needs a meta object`)
    const { title, description } = meta
    assert.equal(typeof title, 'string', `locale/${locale}.json needs meta.title`)
    assert.equal(typeof description, 'string', `locale/${locale}.json needs meta.description`)
    assert.ok((title as string).trim().length > 0, `locale/${locale}.json meta.title must not be blank`)
    assert.ok((description as string).trim().length > 0, `locale/${locale}.json meta.description must not be blank`)
  })
}

test('icon.svg is a self-contained inline SVG inside the size limit', () => {
  const iconPath = path.join(repoRoot, 'icon.svg')
  assert.ok(existsSync(iconPath), 'icon.svg must exist at the package root')
  const bytes = statSync(iconPath).size
  assert.ok(bytes > 0, 'icon.svg must not be empty')
  assert.ok(bytes <= 256 * 1024, `icon.svg is ${bytes} bytes; the icon limit is 256 KiB`)
  const svg = readText('icon.svg')
  assert.match(svg, /<svg\b/)
  assert.match(svg, /viewBox="0 0 32 32"/)
  assert.doesNotMatch(svg, /<text\b|<script\b/i, 'the icon must stay shapes only')
  assert.doesNotMatch(svg, /\b(?:xlink:)?href\s*=|<\s*(?:image|use|style)\b/i, 'the icon must not reference external resources')
  // The Host ships icons as a data URI (dsh-app-boot), so `currentColor` resolves to
  // the initial colour instead of following the page theme: pin fixed colours.
  assert.doesNotMatch(svg, /currentColor/i, 'the icon must use fixed colours, not currentColor')
  assert.doesNotMatch(svg, /url\(\s*['"]?(?:https?:|\/\/|data:)/i, 'the icon must not load external resources through url()')
})

test('exports expose the locale directory and the icon, keeping runtime entries', () => {
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  assert.equal(manifest.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(manifest.exports['./package.json'], './package.json')
  assert.ok(manifest.exports['.'] !== undefined, 'the package keeps its root export')
  assert.ok(manifest.exports['./client'] !== undefined, 'the package keeps its client export')
})

test('files ships the patch, the locales and the icon', () => {
  for (const entry of ['lib', 'cordis.patch.yml', 'locale', 'icon.svg']) {
    assert.ok(manifest.files.includes(entry), `package.json files must include ${entry}`)
  }
})

test('npm test runs this manifest gate', () => {
  assert.match(manifest.scripts.test, /test\/manifest\.test\.ts/)
})

test('the manifest declares the top-level icon field the Host reads first', () => {
  // dsh-app-boot resolves `package.json#icon` before falling back to `<pkg>/icon`.
  assert.equal(manifest.icon, 'icon.svg', 'package.json must declare icon: "icon.svg"')
  assert.ok(existsSync(path.join(repoRoot, 'icon.svg')), 'the icon field target must exist')
})
