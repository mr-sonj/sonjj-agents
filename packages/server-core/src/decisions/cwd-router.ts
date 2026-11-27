/**
 * Auto working directory via the decision model (feature toggle `autoWorkingDirectory`).
 *
 * On a session's first message, before its agent exists, pick the project folder the message is
 * about, so the system prompt's project context files and the shell start there exactly as if
 * the user had picked the folder. Staying put is the default: without a clear signal, or without
 * an answer, the session keeps its folder.
 *
 * Candidates are the folders up to `CANDIDATE_SCAN_DEPTH` below the context root (the
 * workspace's `defaults.workingDirectory`) that hold an AGENTS.md or CLAUDE.md. Hard signals are
 * checked first: a path in the message or an attachment, then a folder named in the message. The
 * model is asked (one call: does the message belong where the session is, and which folder is it
 * about) only when they do not settle it. Only paths relative to the root reach the provider.
 *
 * SessionManager decides when this runs and applies the result; apart from reading the
 * candidate folders this module has no side effects.
 */

import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DecisionRequest, DecisionResult } from '@craft-agent/shared/decisions'
import type { WorkingDirectoryOrigin } from '@craft-agent/shared/sessions'
import { isValidWorkingDirectory } from '../utils/path-validation'
import { FOREGROUND_MAX_DEADLINE_MS, openDecisionPoint, recordDecisionOutcome, type DecisionPointDeps } from './decision-point'

/** Away from a folder below the root: `belongs_here` at or above this keeps the session where it is. */
export const STAY_IF_BELONGS_AT = 0.4
/** At the root: the model's pick needs this much confidence without a hard signal. */
export const ROUTE_FROM_ROOT_AT = 0.7
/** Away from a folder below the root: the model's pick needs this much confidence, and a hard signal. */
export const ROUTE_LATERAL_AT = 0.85
/** Below this the model's pick never moves the session. */
export const MIN_TARGET_CONFIDENCE = 0.5

/** Levels below the root searched for candidate folders. */
export const CANDIDATE_SCAN_DEPTH = 2
/** More candidates than this and the router does not run. */
export const MAX_CANDIDATES = 200
/** Folder names shorter than this are not matched in the message. */
export const MIN_NAME_LENGTH = 4
/** Message characters sent to the model. */
export const MESSAGE_MAX_CHARS = 2_000
/** Characters of a folder description sent to the model. */
export const DESCRIPTION_MAX_CHARS = 200

/** Folders the candidate scan reads at most. */
const MAX_SCAN_DIRS = 2_000
/** Bytes read from a context file for its description. */
const CONTEXT_FILE_READ_BYTES = 16 * 1024
/** Context files, in priority order, matched case-insensitively. */
const CONTEXT_FILE_NAMES = ['agents.md', 'claude.md']
/** Never candidates, nor searched (hidden folders are skipped as well). */
const SKIPPED_FOLDERS = new Set(['node_modules', '_archive', 'dist', 'build'])
const DESCRIPTION_FIELDS = ['project_role', 'description', 'title']

const STAY = 'stay'
const UNCLEAR = 'unclear'
const ROOT_LABEL = '(root)'

export interface CwdCandidate {
  /** Path below the root with `/` separators, e.g. `projects/acme`: the option key sent to the model. */
  key: string
  /** Absolute path, as listed under the root (a symlinked folder keeps its link path). */
  path: string
  description: string
}

/** Why the router stayed; absent on a route. */
export type CwdStayRule =
  | 'here'            // a path in the message is in the current folder
  | 'no_answer'       // no (usable) answer from the model
  | 'stay_or_unclear' // the model picked `stay` or `unclear`
  | 'low_confidence'  // the pick is below MIN_TARGET_CONFIDENCE
  | 'belongs_here'    // the message belongs to the current folder
  | 'same_branch'     // the target contains the current folder or lies inside its project
  | 'below_threshold' // the pick is below the route threshold
  | 'no_hard_signal'  // a lateral move without a path or name pointing at the target
  | 'invalid_target'  // the target is not a usable directory

export interface CwdRoute {
  action: 'stay' | 'route'
  /** Absolute folder to switch to (routes only). */
  target?: string
  /** What decided: a path, a folder name, or the model alone. */
  reason: 'path' | 'name' | 'model'
  /** The model's confidence in its pick, when it was asked. */
  confidence?: number
  /** The current folder below the root (`(root)` for the root itself). */
  from: string
  /** The picked folder below the root, also when a rule kept the session where it is. */
  to?: string
  rule?: CwdStayRule
}

export interface CwdRouterInput {
  /** Context root: the workspace's `defaults.workingDirectory`. */
  root: string
  /** The session's folder now. */
  workingDirectory: string
  message: string
  attachments?: readonly { path?: string; name: string; type?: string }[]
  sessionId?: string
}

export interface CwdRouterDeps extends DecisionPointDeps {
  /** Checked before a move (default: `isValidWorkingDirectory`). */
  isValidDirectory?: (path: string) => boolean
  /** Expands `~` in paths (default: the user's home). */
  homeDir?: string
}

// ── Paths ───────────────────────────────────────────────────────────────

/** `child` is `parent` or below it. */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Both set and naming the same folder (trailing separators and `.` segments ignored). */
export function isSameDirectory(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && resolve(a) === resolve(b)
}

function keyOf(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * Where a new session's working directory comes from (see `WorkingDirectoryOrigin`).
 * `requested` is `CreateSessionOptions.workingDirectory`.
 */
export function resolveWorkingDirectoryOrigin(input: {
  requested: string | undefined
  resolved: string | undefined
  configuredDefault: string | undefined
  /** Bound to a project, or a subtask or branch of another session. */
  boundElsewhere: boolean
}): WorkingDirectoryOrigin {
  if (input.boundElsewhere) return 'explicit'
  if (input.requested !== undefined && input.requested !== 'user_default') return 'explicit'
  if (!input.resolved && !input.configuredDefault) return 'default'
  return isSameDirectory(input.resolved, input.configuredDefault) ? 'default' : 'inherited'
}

// ── Candidates ──────────────────────────────────────────────────────────

function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function contextFileIn(entries: readonly Dirent[]): string | null {
  for (const wanted of CONTEXT_FILE_NAMES) {
    const entry = entries.find(e => e.name.toLowerCase() === wanted && !e.isDirectory())
    if (entry) return entry.name
  }
  return null
}

interface ScanFolder {
  dir: string
  rel: string
  real: string
  /** Reached through a symlink */
  linked: boolean
}

/** Subfolders worth a look: not hidden, not skipped, symlinks only when they stay inside the root. */
function subfolders(parent: Pick<ScanFolder, 'dir' | 'rel' | 'linked'>, entries: readonly Dirent[], realRoot: string): ScanFolder[] {
  const folders: ScanFolder[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const name = entry.name
    if (name.startsWith('.') || SKIPPED_FOLDERS.has(name.toLowerCase()) || entry.isFile()) continue
    const dir = join(parent.dir, name)
    const real = safeRealpath(dir)
    if (!real || !isWithin(realRoot, real)) continue
    // A symlink, or an entry whose type the filesystem did not report
    if (!entry.isDirectory()) {
      try {
        if (!statSync(real).isDirectory()) continue
      } catch {
        continue
      }
    }
    folders.push({ dir, rel: parent.rel ? `${parent.rel}/${name}` : name, real, linked: parent.linked || entry.isSymbolicLink() })
  }
  return folders
}

interface FoundContextFile { key: string; path: string; real: string; linked: boolean; file: string; stamp: string }

/** One entry per real folder: the one reached without a symlink if there is one, else the first. */
function dedupeByRealPath(found: readonly FoundContextFile[]): FoundContextFile[] {
  const kept = new Map<string, FoundContextFile>()
  for (const item of found) {
    const previous = kept.get(item.real)
    if (!previous || (previous.linked && !item.linked)) kept.set(item.real, item)
  }
  const keep = new Set(kept.values())
  return found.filter(item => keep.has(item))
}

const candidateCache = new Map<string, { signature: string; candidates: CwdCandidate[] }>()

/** Forget cached candidates (tests; the cache also refreshes itself when a context file changes). */
export function invalidateCwdCandidateCache(): void {
  candidateCache.clear()
}

/**
 * Folders up to `maxDepth` below `root` that hold an AGENTS.md or CLAUDE.md, shallowest first
 * and by name. Skips hidden folders, `node_modules`, `_archive`, `dist`, `build` and symlinks
 * that lead outside the root. Descriptions are cached per root until a context file's mtime or
 * size changes.
 */
export function discoverCandidates(root: string, options: { maxDepth?: number } = {}): CwdCandidate[] {
  const maxDepth = options.maxDepth ?? CANDIDATE_SCAN_DEPTH
  const rootPath = resolve(root)
  const realRoot = safeRealpath(rootPath)
  if (!realRoot) return []

  const scanned: FoundContextFile[] = []
  let dirsRead = 0
  let level = subfolders({ dir: rootPath, rel: '', linked: false }, readEntries(rootPath), realRoot)
  for (let depth = 1; level.length > 0 && dirsRead < MAX_SCAN_DIRS; depth++) {
    const next: typeof level = []
    for (const folder of level) {
      if (++dirsRead > MAX_SCAN_DIRS) break
      const entries = readEntries(folder.dir)
      const file = contextFileIn(entries)
      if (file) {
        let stamp = ''
        try {
          const stat = statSync(join(folder.dir, file))
          stamp = `${stat.mtimeMs}:${stat.size}`
        } catch {
          // unreadable: described as empty below
        }
        scanned.push({ key: folder.rel, path: folder.dir, real: folder.real, linked: folder.linked, file, stamp })
      }
      // The depth bound also ends symlink cycles
      if (depth < maxDepth) next.push(...subfolders(folder, entries, realRoot))
    }
    level = next
  }
  const found = dedupeByRealPath(scanned.filter(item => item.real !== realRoot))

  const signature = found.map(f => `${f.key}\0${f.file}\0${f.stamp}`).join('\n')
  const cacheKey = `${rootPath}\0${maxDepth}`
  const cached = candidateCache.get(cacheKey)
  if (cached?.signature === signature) return cached.candidates
  // Over the limit the router does not run: no point reading the files
  const describe = found.length <= MAX_CANDIDATES
  const candidates = found.map(f => ({ key: f.key, path: f.path, description: describe ? describeContextFileAt(join(f.path, f.file)) : '' }))
  candidateCache.set(cacheKey, { signature, candidates })
  return candidates
}

/** The deepest candidate that is `path` or contains it. */
export function deepestContaining(candidates: readonly CwdCandidate[], path: string): CwdCandidate | null {
  let best: CwdCandidate | null = null
  for (const candidate of candidates) {
    if (isWithin(candidate.path, path) && (!best || candidate.path.length > best.path.length)) best = candidate
  }
  return best
}

// ── Descriptions ────────────────────────────────────────────────────────

function clip(text: string, max = DESCRIPTION_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1)
  return v
}

/** Top-level scalar fields of a leading `---` frontmatter block (block scalars folded), and the body after it. */
export function splitFrontmatter(content: string): { fields: Record<string, string>; body: string } {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { fields: {}, body: content }
  const end = lines.findIndex((line, i) => i > 0 && (line.trim() === '---' || line.trim() === '...'))
  if (end < 0) return { fields: {}, body: content }
  const fields: Record<string, string> = {}
  let i = 1
  while (i < end) {
    const match = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(lines[i]!)
    i++
    if (!match) continue
    const key = match[1]!
    let value = match[2]!.trim()
    if (value === '' || /^[>|][+-]?$/.test(value)) {
      // A block scalar or a plain scalar continued on indented lines
      const parts: string[] = []
      while (i < end && (/^\s+\S/.test(lines[i]!) || lines[i]!.trim() === '')) {
        if (!/^\s*-\s/.test(lines[i]!)) parts.push(lines[i]!.trim())
        i++
      }
      value = parts.join(' ')
    }
    fields[key] = unquote(value)
  }
  return { fields, body: lines.slice(end + 1).join('\n') }
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .trim()
}

/** The first H1 and the paragraph after it (or the first paragraph when there is no H1). */
function headingAndFirstParagraph(body: string): string {
  const lines = body.split(/\r?\n/)
  let i = 0
  let inFence = false
  let heading = ''
  const headingAt = lines.findIndex(line => /^#\s+\S/.test(line))
  if (headingAt >= 0) {
    heading = stripInlineMarkdown(lines[headingAt]!.replace(/^#\s+/, ''))
    i = headingAt + 1
  }
  const paragraph: string[] = []
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line.startsWith('```') || line.startsWith('~~~')) {
      if (paragraph.length > 0) break
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (!line || line.startsWith('#') || line.startsWith('|') || line.startsWith('<!--')) {
      if (paragraph.length > 0) break
      continue
    }
    paragraph.push(stripInlineMarkdown(line.replace(/^>\s?/, '')))
  }
  const text = paragraph.join(' ')
  return heading && text ? `${heading} — ${text}` : heading || text
}

/** One-line description of a context file's content: frontmatter `project_role` → `description` → `title`, else its H1 and first paragraph. */
export function describeContextFile(content: string): string {
  const { fields, body } = splitFrontmatter(content)
  for (const field of DESCRIPTION_FIELDS) {
    const value = fields[field]?.trim()
    if (value) return clip(value)
  }
  return clip(headingAndFirstParagraph(body))
}

function describeContextFileAt(file: string): string {
  try {
    const content = readFileSync(file, 'utf-8')
    return describeContextFile(content.length > CONTEXT_FILE_READ_BYTES ? content.slice(0, CONTEXT_FILE_READ_BYTES) : content)
  } catch {
    return ''
  }
}

/** Description of `folder` from the nearest context file on the way up to `root` (a task folder without one gets its project's). */
export function describeFolder(folder: string, root: string): string {
  let dir = resolve(folder)
  const top = resolve(root)
  for (;;) {
    const file = contextFileIn(readEntries(dir))
    if (file) return describeContextFileAt(join(dir, file))
    if (dir === top || !isWithin(top, dir)) return ''
    const parent = dirname(dir)
    if (parent === dir) return ''
    dir = parent
  }
}

// ── Hard signals ────────────────────────────────────────────────────────

const TRAILING_PUNCTUATION = /[.,;:!?'"`]+$/

/**
 * Absolute paths the message refers to: `[file:…]`/`[folder:…]` mentions (relative ones are in
 * the working directory), resolved `[Mentioned file: … (at …)]` markers, `@path` mentions
 * (relative ones must exist in the working directory or the root), absolute or `~/` paths in the
 * text, and attachment paths.
 */
export function collectMessagePaths(
  message: string,
  attachments: readonly { path?: string }[] | undefined,
  base: { workingDirectory: string; root: string; homeDir?: string; exists?: (path: string) => boolean },
): string[] {
  const home = base.homeDir ?? homedir()
  const exists = base.exists ?? ((path: string) => {
    try {
      statSync(path)
      return true
    } catch {
      return false
    }
  })
  const expand = (raw: string): string | null => {
    const path = raw.trim().replace(TRAILING_PUNCTUATION, '')
    if (!path) return null
    if (path === '~' || path.startsWith('~/')) return resolve(home, path.slice(2))
    return isAbsolute(path) ? resolve(path) : null
  }
  const paths = new Set<string>()
  const add = (path: string | null) => { if (path) paths.add(path) }

  for (const [, raw] of message.matchAll(/\[(?:file|folder):([^\]]+)\]/g)) {
    add(expand(raw!) ?? resolve(base.workingDirectory, raw!.trim()))
  }
  for (const [, raw] of message.matchAll(/\[Mentioned (?:file|folder): [^\]]*?\(at ([^)\]]+)\)\]/g)) add(expand(raw!))
  for (const [, raw] of message.matchAll(/(?:^|[\s([{"'`])@([^\s@"'`()[\]{}<>]+)/g)) {
    const token = raw!.replace(TRAILING_PUNCTUATION, '')
    const absolute = expand(token)
    if (absolute) {
      add(absolute)
      continue
    }
    // `@name` is a handle unless it looks like a path that exists
    if (!token.includes('/') && !/\.\w+$/.test(token)) continue
    const candidates = [resolve(base.workingDirectory, token), resolve(base.root, token)]
    add(candidates.find(exists) ?? null)
  }
  for (const [, raw] of message.matchAll(/(?:^|[\s([{"'`=])((?:~\/|\/)[^\s"'`<>()[\]{}]+)/g)) add(expand(raw!))
  for (const attachment of attachments ?? []) if (attachment.path) add(expand(attachment.path))
  return [...paths]
}

export type CwdPathSignal = { kind: 'here' } | { kind: 'target'; candidate: CwdCandidate }

/**
 * What the paths point at: the current folder (`here`), one other candidate (`target`, the
 * deepest containing them), or nothing when they point at different places or at none.
 */
export function classifyPaths(paths: readonly string[], workingDirectory: string, candidates: readonly CwdCandidate[]): CwdPathSignal | null {
  const buckets = new Map<string, CwdCandidate | null>()
  for (const path of paths) {
    const candidate = deepestContaining(candidates, path)
    // In the working directory and in no candidate below it
    if (isWithin(workingDirectory, path) && (!candidate || isWithin(candidate.path, workingDirectory))) buckets.set('', null)
    else if (candidate) buckets.set(candidate.key, candidate)
  }
  if (buckets.size !== 1) return null
  const [only] = buckets.values()
  return only ? { kind: 'target', candidate: only } : { kind: 'here' }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Candidates whose folder name (at least `MIN_NAME_LENGTH` characters) appears in the message as a whole token, any case. */
export function findNamedCandidates(message: string, candidates: readonly CwdCandidate[]): CwdCandidate[] {
  return candidates.filter(candidate => {
    const name = basename(candidate.path)
    if (name.length < MIN_NAME_LENGTH) return false
    return new RegExp(`(?<![\\p{L}\\p{N}_.-])${escapeRegExp(name)}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, 'iu').test(message)
  })
}

// ── Model ───────────────────────────────────────────────────────────────

export function buildCwdRouterRequest(input: {
  message: string
  attachments?: readonly string[]
  current: { path: string; description: string }
  options: readonly CwdCandidate[]
  askBelongsHere: boolean
}): DecisionRequest {
  const message = input.message.length > MESSAGE_MAX_CHARS ? `${input.message.slice(0, MESSAGE_MAX_CHARS)}…` : input.message
  const criteria: Record<string, string | null> = {}
  for (const option of input.options) criteria[option.key] = option.description || null
  criteria[STAY] = 'Not clearly about any listed folder, or about the current one'
  criteria[UNCLEAR] = 'Cannot tell'
  return {
    state: {
      message,
      attachments: [...(input.attachments ?? [])],
      current: input.current,
    },
    questions: {
      ...(input.askBelongsHere
        ? { belongs_here: { type: 'noul' as const, instructions: 'Is this message about the work described in `current`? A short follow-up like "continue", "check that again" counts as yes.' } }
        : {}),
      target: { type: 'choice', instructions: 'Which project folder is this message about?', criteria },
    },
  }
}

export interface CwdRouteContext {
  workingDirectory: string
  atRoot: boolean
  /** The deepest candidate containing the working directory, if any. */
  current: CwdCandidate | null
  from: string
  isValid: (path: string) => boolean
}

/** The target contains the working directory, lies below it, or lies inside the current project. */
function sameBranch(ctx: CwdRouteContext, target: CwdCandidate): boolean {
  return isWithin(target.path, ctx.workingDirectory)
    || isWithin(ctx.workingDirectory, target.path)
    || (ctx.current !== null && isWithin(ctx.current.path, target.path))
}

function stay(ctx: CwdRouteContext, reason: CwdRoute['reason'], rule: CwdStayRule, extra: Partial<CwdRoute> = {}): CwdRoute {
  return { action: 'stay', reason, from: ctx.from, rule, ...extra }
}

/** A path or a folder name pointing at `target`, without the model. */
export function judgeHardSignal(ctx: CwdRouteContext, target: CwdCandidate, reason: 'path' | 'name'): CwdRoute {
  if (!ctx.atRoot && sameBranch(ctx, target)) return stay(ctx, reason, 'same_branch', { to: target.key })
  if (!ctx.isValid(target.path)) return stay(ctx, reason, 'invalid_target', { to: target.key })
  return { action: 'route', target: target.path, reason, from: ctx.from, to: target.key }
}

/** Apply the route rules to the model's answer. `named`: candidates named in the message. */
export function judgeModelAnswer(
  ctx: CwdRouteContext,
  result: DecisionResult | null,
  options: readonly CwdCandidate[],
  named: readonly CwdCandidate[],
): CwdRoute {
  const answer = result?.answers.target
  if (!answer || answer.type !== 'choice') return stay(ctx, 'model', 'no_answer')
  const confidence = answer.confidence
  if (answer.choice === STAY || answer.choice === UNCLEAR) return stay(ctx, 'model', 'stay_or_unclear', { confidence })
  const target = options.find(option => option.key === answer.choice)
  if (!target) return stay(ctx, 'model', 'no_answer')
  const nameHit = named.some(candidate => candidate.key === target.key)
  const reason = nameHit ? 'name' : 'model'
  const picked = { confidence, to: target.key }
  if (confidence < MIN_TARGET_CONFIDENCE) return stay(ctx, reason, 'low_confidence', picked)
  if (ctx.atRoot) {
    if (!nameHit && confidence < ROUTE_FROM_ROOT_AT) return stay(ctx, reason, 'below_threshold', picked)
  } else {
    const belongs = result?.answers.belongs_here
    if (!belongs || belongs.type !== 'noul') return stay(ctx, reason, 'no_answer', picked)
    if (belongs.noul >= STAY_IF_BELONGS_AT) return stay(ctx, reason, 'belongs_here', picked)
    if (sameBranch(ctx, target)) return stay(ctx, reason, 'same_branch', picked)
    if (confidence < ROUTE_LATERAL_AT) return stay(ctx, reason, 'below_threshold', picked)
    if (!nameHit) return stay(ctx, reason, 'no_hard_signal', picked)
  }
  if (!ctx.isValid(target.path)) return stay(ctx, reason, 'invalid_target', picked)
  return { action: 'route', target: target.path, reason, from: ctx.from, ...picked }
}

/**
 * Where the session's first message says it should work. `null` when the router does not apply
 * (the folder is outside the root, no or too many candidates). Never throws on a model failure;
 * a filesystem error may throw, so callers wrap it.
 */
export async function routeWorkingDirectory(input: CwdRouterInput, deps: CwdRouterDeps = {}): Promise<CwdRoute | null> {
  const tag = '[decision:auto_working_directory]'
  const root = resolve(input.root)
  const workingDirectory = resolve(input.workingDirectory)
  if (!isWithin(root, workingDirectory)) {
    deps.log?.(`${tag} skipped: the working directory is outside the context root`)
    return null
  }
  const candidates = discoverCandidates(root)
  if (candidates.length === 0) return null
  if (candidates.length > MAX_CANDIDATES) {
    deps.log?.(`${tag} skipped: ${candidates.length} candidate folders (more than ${MAX_CANDIDATES})`)
    return null
  }

  const atRoot = workingDirectory === root
  const ctx: CwdRouteContext = {
    workingDirectory,
    atRoot,
    current: atRoot ? null : deepestContaining(candidates, workingDirectory),
    from: atRoot ? ROOT_LABEL : keyOf(root, workingDirectory),
    isValid: deps.isValidDirectory ?? (path => isValidWorkingDirectory(path).valid),
  }

  const paths = collectMessagePaths(input.message, input.attachments, { workingDirectory, root, homeDir: deps.homeDir })
  const pathSignal = classifyPaths(paths, workingDirectory, candidates)
  if (pathSignal?.kind === 'here') return stay(ctx, 'path', 'here')
  if (pathSignal?.kind === 'target') return judgeHardSignal(ctx, pathSignal.candidate, 'path')

  const named = findNamedCandidates(input.message, candidates)
  if (atRoot && named.length === 1) return judgeHardSignal(ctx, named[0]!, 'name')

  // Several folders named: the model picks among them. `stay`/`unclear` are reserved option keys.
  const options = (named.length > 1 ? named : candidates).filter(option => option.key !== STAY && option.key !== UNCLEAR)
  if (options.length === 0) return null
  // The turn start waits for this answer.
  const decide = await openDecisionPoint({ ...deps, feature: 'autoWorkingDirectory', record: 'auto_working_directory', maxDeadlineMs: FOREGROUND_MAX_DEADLINE_MS, sessionId: input.sessionId })
  if (!decide) return stay(ctx, 'model', 'no_answer')
  const request = buildCwdRouterRequest({
    message: input.message,
    attachments: input.attachments?.map(attachment => (attachment.type ? `${attachment.name} (${attachment.type})` : attachment.name)),
    current: { path: ctx.from, description: describeFolder(workingDirectory, root) },
    options,
    askBelongsHere: !atRoot,
  })
  const result = await decide(request, { candidates: options.length, narrowed: named.length > 1, atRoot })
  const route = judgeModelAnswer(ctx, result, options, named)
  recordDecisionOutcome(result, {
    action: route.action,
    changed: route.action === 'route',
    detail: { reason: route.reason, rule: route.rule, from: route.from, to: route.to, confidence: route.confidence },
  })
  return route
}

/** One line for the transcript and the log, e.g. `Auto working directory: (root) → projects/acme (name)`. */
export function describeRoute(route: CwdRoute): string {
  const why = route.confidence !== undefined ? `${route.reason}, ${route.confidence.toFixed(2)}` : route.reason
  return `Auto working directory: ${route.from} → ${route.to ?? '?'} (${why})`
}
