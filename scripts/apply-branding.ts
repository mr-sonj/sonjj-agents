#!/usr/bin/env bun
/**
 * Apply the fork's branding (branding/brand.json, branding/assets/) to the working tree
 * before a release build: app name, bundle id, icons, logos, and no update feed.
 *
 *   bun run scripts/apply-branding.ts            # rewrite files in place
 *   bun run scripts/apply-branding.ts --dry-run  # list what would change
 *
 * Run it on a fresh checkout (CI) and do not commit the result: keeping the rename out of the
 * source keeps upstream syncs free of conflicts. Every rule must find its upstream pattern (or
 * its already-branded form), so an upstream change fails the build instead of shipping Craft
 * branding. Running it twice is a no-op.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Glob } from 'bun'

export interface Brand {
  name: string
  agentName: string
  appId: string
  artifactPrefix: string
  author: string
  homepage: string
  description: string
  copyright: string
  coAuthor: string
}

export interface BrandingPlan {
  /** Repo-relative path → new content. */
  writes: Map<string, string | Buffer>
  /** Repo-relative files or directories to remove. */
  deletes: string[]
}

/** Files whose "Craft Agent(s)" text is renamed. Tests keep upstream wording. */
const RENAME_GLOBS = [
  'apps/electron/src/**/*.{ts,tsx,html,json}',
  'apps/webui/src/**/*.{ts,tsx,html,json}',
  'packages/*/src/**/*.{ts,tsx,json}',
  'apps/electron/scripts/*.{sh,ps1,cjs,ts}',
  'scripts/build/*.ts',
  'apps/electron/electron-builder.yml',
]
const RENAME_SKIP_PATH = /(^|\/)__tests__\/|\.(test|spec|isolated)\.[jt]sx?$/

/** Lines that point at Craft's own sites keep their wording ("the Craft Agents docs live at ..."). */
const KEEP_LINE = /thecraftagents\.com|craft\.do/

/** Branding asset → app file it replaces. The target must exist, so a moved upstream icon is noticed. */
const ASSET_COPIES: Array<[string, string]> = [
  ['icon.icns', 'apps/electron/resources/icon.icns'],
  ['icon.ico', 'apps/electron/resources/icon.ico'],
  ['icon.png', 'apps/electron/resources/icon.png'],
  ['icon.svg', 'apps/electron/resources/icon.svg'],
  ['icon-1024.png', 'apps/electron/resources/source.png'],
  ['icon.svg', 'apps/webui/src/public/favicon.svg'],
  ['web/favicon.ico', 'apps/webui/src/public/favicon.ico'],
  ['web/apple-touch-icon.png', 'apps/webui/src/public/apple-touch-icon.png'],
  ['web/icon-192.png', 'apps/webui/src/public/icon-192.png'],
  ['web/icon-512.png', 'apps/webui/src/public/icon-512.png'],
]

/** Craft artwork with no replacement: the macOS 26 asset catalog (falls back to icon.icns) and logo files. */
const DELETES = [
  'apps/electron/resources/Assets.car',
  'apps/electron/resources/icon.icon',
  'apps/electron/resources/craft-logos',
]

/** In-app logo components and the SVG whose viewBox/path they take. */
const LOGO_COMPONENTS: Array<[string, string]> = [
  ['apps/electron/src/renderer/components/icons/CraftAgentsSymbol.tsx', 'symbol.svg'],
  ['apps/electron/src/renderer/components/icons/CraftAgentsLogo.tsx', 'logo.svg'],
]

export function loadBrand(root: string): Brand {
  return JSON.parse(readFileSync(join(root, 'branding/brand.json'), 'utf8'))
}

/** Rename Craft Agent(s) in text, leaving lines that reference Craft's sites alone. */
export function renameText(text: string, brand: Brand): string {
  return text
    .split('\n')
    .map(line => KEEP_LINE.test(line) ? line : line
      .replace(/Craft Agents\b/g, brand.name)
      .replace(/Craft Agent\b/g, brand.agentName)
      .replace(/Craft-Agents-/g, `${brand.artifactPrefix}-`))
    .join('\n')
}

/** Replace `pattern` in `text`; throw if it matches nothing and `done` (the branded form) is absent. */
function rule(file: string, text: string, pattern: RegExp, replacement: string, done: RegExp | string = replacement): string {
  if (pattern.test(text)) return text.replace(pattern, replacement)
  const applied = typeof done === 'string' ? text.includes(done) : done.test(text)
  if (!applied) throw new Error(`${file}: pattern ${pattern} not found — upstream changed, update scripts/apply-branding.ts`)
  return text
}

function svgParts(svg: string, asset: string): { viewBox: string; d: string } {
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1]
  const d = svg.match(/ d="([^"]+)"/)?.[1]
  if (!viewBox || !d) throw new Error(`branding/assets/${asset}: expected a viewBox and one path`)
  return { viewBox, d }
}

function brandBuilderConfig(file: string, text: string, brand: Brand): string {
  text = rule(file, text, /^appId: .+$/m, `appId: ${brand.appId}`)
  text = rule(file, text, /^productName: .+$/m, `productName: ${brand.name}`)
  text = rule(file, text, /^copyright: .+$/m, `copyright: ${brand.copyright}`)
  text = rule(file, text, /^(\s+)maintainer: .+$/m, `$1maintainer: "${brand.author}"`, `maintainer: "${brand.author}"`)
  // No update feed: the app must never download the official Craft Agents release.
  text = rule(file, text, /^publish:\n(?:[ \t]+.*\n)+/m, 'publish: null\n', /^publish: null$/m)
  // Assets.car is removed, so macOS uses icon.icns instead of looking for "AppIcon" in it.
  return text.replace(/^[ \t]*CFBundleIconName: AppIcon\n/m, '')
}

function brandPackageJson(file: string, text: string, brand: Brand): string {
  const pkg = JSON.parse(text)
  for (const key of ['author', 'homepage', 'description']) {
    if (!(key in pkg)) throw new Error(`${file}: "${key}" not found — upstream changed, update scripts/apply-branding.ts`)
  }
  pkg.author = { name: brand.author }
  pkg.homepage = brand.homepage
  pkg.description = brand.description
  return JSON.stringify(pkg, null, 2) + '\n'
}

function brandLogo(file: string, text: string, svg: { viewBox: string; d: string }): string {
  for (const attr of ['viewBox', 'd']) {
    const count = text.match(new RegExp(`\\s${attr}="[^"]*"`, 'g'))?.length ?? 0
    if (count !== 1) throw new Error(`${file}: expected one ${attr}= attribute, found ${count} — update scripts/apply-branding.ts`)
  }
  return text
    .replace(/(\s)viewBox="[^"]*"/, `$1viewBox="${svg.viewBox}"`)
    .replace(/(\s)d="[^"]*"/, `$1d="${svg.d}"`)
}

/**
 * Work out every change without touching the disk. `read` returns a repo-relative file's
 * text (or null if missing); tests pass their own to check idempotency. `scan` lists the files
 * a glob matches; tests pass Windows-style paths through it.
 */
export function planBranding(
  root: string,
  brand: Brand,
  read: (rel: string) => string | null = rel => {
    const p = join(root, rel)
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  },
  scan: (pattern: string) => Iterable<string> = pattern => new Glob(pattern).scanSync({ cwd: root }),
): BrandingPlan {
  const texts = new Map<string, string>()
  const get = (rel: string): string => {
    if (texts.has(rel)) return texts.get(rel)!
    const text = read(rel)
    if (text === null) throw new Error(`${rel} not found — upstream changed, update scripts/apply-branding.ts`)
    return text
  }
  const set = (rel: string, text: string) => texts.set(rel, text)

  for (const pattern of RENAME_GLOBS) {
    // Glob yields `\` paths on Windows; the rules below key files by `/` paths, so a file kept
    // under both would be written twice and the last write would drop the rename.
    for (const rel of [...scan(pattern)].map(path => path.replaceAll('\\', '/'))) {
      if (RENAME_SKIP_PATH.test(rel)) continue
      set(rel, renameText(get(rel), brand))
    }
  }

  const builder = 'apps/electron/electron-builder.yml'
  set(builder, brandBuilderConfig(builder, get(builder), brand))

  const pkg = 'apps/electron/package.json'
  set(pkg, brandPackageJson(pkg, get(pkg), brand))

  const prompt = 'packages/shared/src/prompts/system.ts'
  set(prompt, rule(prompt, get(prompt), /Co-Authored-By: Craft Agent <agents-noreply@craft\.do>/, `Co-Authored-By: ${brand.coAuthor}`))

  for (const [rel, asset] of LOGO_COMPONENTS) {
    const svg = svgParts(readFileSync(join(root, 'branding/assets', asset), 'utf8'), asset)
    set(rel, brandLogo(rel, get(rel), svg))
  }

  const writes = new Map<string, string | Buffer>()
  for (const [rel, text] of texts) {
    if (text !== read(rel)) writes.set(rel, text)
  }
  for (const [asset, rel] of ASSET_COPIES) {
    if (!existsSync(join(root, rel))) throw new Error(`${rel} not found — upstream moved its icons, update scripts/apply-branding.ts`)
    const data = readFileSync(join(root, 'branding/assets', asset))
    if (!data.equals(readFileSync(join(root, rel)))) writes.set(rel, data)
  }

  return { writes, deletes: DELETES.filter(rel => existsSync(join(root, rel))) }
}

export function applyPlan(root: string, plan: BrandingPlan): void {
  for (const [rel, content] of plan.writes) writeFileSync(join(root, rel), content)
  for (const rel of plan.deletes) rmSync(join(root, rel), { recursive: true, force: true })
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..')
  const dryRun = process.argv.includes('--dry-run')
  const brand = loadBrand(root)
  const plan = planBranding(root, brand)

  for (const rel of plan.writes.keys()) console.log(`  update  ${rel}`)
  for (const rel of plan.deletes) console.log(`  delete  ${rel}`)
  if (!dryRun) applyPlan(root, plan)
  console.log(`${dryRun ? 'Would apply' : 'Applied'} "${brand.name}" branding: ${plan.writes.size} files updated, ${plan.deletes.length} removed.`)
}
