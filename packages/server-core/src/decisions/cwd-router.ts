/**
 * Auto working directory (the workspace switch `autoWorkingDirectory` in its config.json).
 *
 * On a session's first message, before its agent exists, pick the project folder the message is
 * about, so the system prompt's project context files and the shell start there exactly as if
 * the user had picked the folder. It always picks from the root, wherever the session sits (a
 * folder remembered from an earlier session is not a default), and the root is the default:
 * without a clear signal, or without an answer, the session works in the root.
 *
 * The only folders it may move to are those the workspace lists (`autoWorkingDirectoryFolders`,
 * paths relative to the context root, the workspace's `defaults.workingDirectory`), each with a
 * note on when to pick it; a listed folder's AGENTS.md/CLAUDE.md adds to that note. Hard signals
 * are checked first: a path in the message or an attachment, then a listed folder's name in the
 * message (words in the notes are never hard signals). A model is asked only when they do not
 * settle it: the decision model (Jev) when the decision layer is on (which folder is the message
 * about), else the session connection's small model (`askMiniModel`), which answers with one
 * folder key and no confidence. Only paths relative to the root reach either provider.
 *
 * SessionManager decides when this runs and applies the result; apart from reading the listed
 * folders this module has no side effects.
 */

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DecisionRequest, DecisionResult } from '@craft-agent/shared/decisions'
import type { AutoWorkingDirectoryIssue } from '@craft-agent/shared/protocol'
import type { WorkingDirectoryOrigin } from '@craft-agent/shared/sessions'
import { isValidWorkingDirectory } from '../utils/path-validation'
import { FOREGROUND_MAX_DEADLINE_MS, openDecisionPoint, recordDecisionOutcome, type DecisionPointDeps } from './decision-point'

/** The decision model's pick needs this much confidence without a hard signal. */
export const ROUTE_FROM_ROOT_AT = 0.7
/** Below this the model's pick never moves the session. */
export const MIN_TARGET_CONFIDENCE = 0.5

/** Folders of the list used at most (the model takes up to 255 options). */
export const MAX_CANDIDATES = 200
/** Folder names shorter than this are not matched in the message. */
export const MIN_NAME_LENGTH = 4
/** Message characters sent to the model. */
export const MESSAGE_MAX_CHARS = 2_000
/** Characters of a folder's context-file description sent to the model. */
export const DESCRIPTION_MAX_CHARS = 200
/** Characters of a folder's note in the list sent to the model. */
export const NOTE_MAX_CHARS = 400
/** The longest wait for the small model's pick (a Claude connection starts a CLI process per call). */
export const MINI_MODEL_DEADLINE_MS = 8_000

/** Bytes read from a context file for its description. */
const CONTEXT_FILE_READ_BYTES = 16 * 1024
/** Context files, in priority order, matched case-insensitively. */
const CONTEXT_FILE_NAMES = ['agents.md', 'claude.md']
const DESCRIPTION_FIELDS = ['project_role', 'description', 'title']

const STAY = 'stay'
const UNCLEAR = 'unclear'
const ROOT_LABEL = '(root)'

const TARGET_INSTRUCTIONS = 'Which project folder is this message about?'
const STAY_CRITERION = 'Not clearly about any listed folder, or about the current one'
const UNCLEAR_CRITERION = 'Cannot tell'

export interface CwdCandidate {
  /** Path below the root with `/` separators, e.g. `projects/acme`: the option key sent to the model. */
  key: string
  /** Absolute path below the root. */
  path: string
  description: string
}

/** Why no listed folder was picked (the session works in the root), or why it stays where it is. */
export type CwdStayRule =
  | 'in_root'         // the paths in the message are in the root, outside every listed folder
  | 'no_answer'       // no (usable) answer from the model
  | 'stay_or_unclear' // the model picked `stay` or `unclear`
  | 'low_confidence'  // the pick is below MIN_TARGET_CONFIDENCE
  | 'below_threshold' // the pick is below ROUTE_FROM_ROOT_AT
  | 'invalid_target'  // the target is not a usable directory
  | 'already_there'   // the session is in the picked folder already

export interface CwdRoute {
  /**
   * `route`: move the session to `target`, a folder other than the one it is in. That is the root
   * when nothing is picked for a session sitting in a remembered folder (`rule` says why).
   */
  action: 'stay' | 'route'
  /** Absolute folder to switch to (routes only). */
  target?: string
  /** What decided: a path, a folder name, or the model alone. */
  reason: 'path' | 'name' | 'model'
  /** The model's confidence in its pick, when it was asked. */
  confidence?: number
  /** The session's folder below the root (`(root)` for the root itself). */
  from: string
  /** The picked folder below the root (`(root)` when moving back to it), also when a rule kept the session where it is. */
  to?: string
  rule?: CwdStayRule
  /** Which model was asked: the decision model or the connection's small model. */
  via?: 'jev' | 'mini_model'
}

export interface CwdRouterInput {
  /** Context root: the workspace's `defaults.workingDirectory`. */
  root: string
  /** The session's folder now: the root, or a folder remembered from an earlier session (never a default). */
  workingDirectory: string
  message: string
  attachments?: readonly { path?: string; name: string; type?: string }[]
  sessionId?: string
  /** The workspace's folder list (`autoWorkingDirectoryFolders`, see `parseFolderList`). */
  folders: readonly string[] | undefined
}

export interface CwdRouterDeps extends DecisionPointDeps {
  /** Checked before a move (default: `isValidWorkingDirectory`). */
  isValidDirectory?: (path: string) => boolean
  /** Expands `~` in paths (default: the user's home). */
  homeDir?: string
  /**
   * The session connection's small model, asked when the decision model is off or unavailable:
   * the prompt in, its reply out (`null` for none). Without it the router stays put then.
   * `signal` aborts when the router stops waiting.
   */
  askMiniModel?: (prompt: string, signal: AbortSignal) => Promise<string | null>
  /** How long to wait for `askMiniModel` (default `MINI_MODEL_DEADLINE_MS`). */
  miniModelDeadlineMs?: number
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** A line of the folder list that is not used, and why. */
export type FolderListIssue = AutoWorkingDirectoryIssue

/**
 * The folder list as stored: a string (split into lines) or an array of strings, without
 * trailing spaces or trailing blank lines. Throws on anything else.
 */
export function normalizeFolderListLines(value: unknown): string[] {
  if (value === undefined || value === null) return []
  const lines = typeof value === 'string' ? value.split(/\r?\n/) : value
  if (!Array.isArray(lines) || !lines.every(line => typeof line === 'string')) {
    throw new Error('autoWorkingDirectoryFolders must be a list of lines')
  }
  const trimmed = (lines as string[]).flatMap(line => line.split(/\r?\n/)).map(line => line.trimEnd())
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop()
  return trimmed
}

/**
 * The folder list as found in config.json, never throwing: like `normalizeFolderListLines`, but an
 * entry that is not a string (a hand edit such as `{ "path": … }`) becomes its JSON text, so it is
 * reported as a line naming no folder instead of breaking the settings page or the router.
 */
export function readFolderListLines(value: unknown): string[] {
  const asLine = (entry: unknown) => (typeof entry === 'string' ? entry : JSON.stringify(entry) ?? String(entry))
  if (value === undefined || value === null) return []
  return normalizeFolderListLines(Array.isArray(value) ? value.map(asLine) : typeof value === 'string' ? value : [asLine(value)])
}

/** A listed folder's note followed by what its AGENTS.md/CLAUDE.md says, when it has one. */
function describeListedFolder(path: string, note: string): string {
  const file = contextFileIn(readEntries(path))
  const fromFile = file ? describeContextFileAt(join(path, file)) : ''
  const clipped = clip(note, NOTE_MAX_CHARS)
  return clipped && fromFile ? `${clipped} (${fromFile})` : clipped || fromFile
}

/**
 * The workspace's folder list (`autoWorkingDirectoryFolders`): the only folders the router may
 * move a session to. One line per folder, `<path relative to the root>: <when to pick it>`;
 * blank lines and lines starting with `#` are skipped, and a folder name may not contain `:`.
 * Lines naming no folder below the root are reported as issues and skipped. `describe: false`
 * only checks the lines (no context files are read).
 */
export function parseFolderList(
  lines: readonly string[] | undefined,
  root: string,
  options: { describe?: boolean } = {},
): { candidates: CwdCandidate[]; issues: FolderListIssue[] } {
  const rootPath = resolve(root)
  const candidates: CwdCandidate[] = []
  const issues: FolderListIssue[] = []
  const seen = new Set<string>()
  ;(lines ?? []).forEach((raw, index) => {
    const text = raw.trim()
    if (!text || text.startsWith('#')) return
    const colon = text.indexOf(':')
    const written = (colon >= 0 ? text.slice(0, colon) : text).trim()
    const note = colon >= 0 ? text.slice(colon + 1).trim() : ''
    const rel = written.replace(/^\.[\\/]+/, '').replace(/[\\/]+$/, '')
    const line = index + 1
    if (!rel) return void issues.push({ line, path: written, kind: 'no_path' })
    const path = resolve(rootPath, rel)
    if (isAbsolute(rel) || rel.startsWith('~') || path === rootPath || !isWithin(rootPath, path)) {
      return void issues.push({ line, path: written, kind: 'outside_root' })
    }
    const key = keyOf(rootPath, path)
    if (seen.has(key)) return void issues.push({ line, path: written, kind: 'duplicate' })
    seen.add(key)
    if (!isDirectory(path)) return void issues.push({ line, path: written, kind: 'missing' })
    if (candidates.length >= MAX_CANDIDATES) return void issues.push({ line, path: written, kind: 'too_many' })
    candidates.push({ key, path, description: options.describe === false ? note : describeListedFolder(path, note) })
  })
  return { candidates, issues }
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
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
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

export type CwdPathSignal = { kind: 'root' } | { kind: 'target'; candidate: CwdCandidate }

/**
 * What the paths point at: one candidate (`target`, the deepest containing them), the root itself
 * (`root`: inside it, outside every candidate), or nothing when they point at different places or
 * outside the root.
 */
export function classifyPaths(paths: readonly string[], root: string, candidates: readonly CwdCandidate[]): CwdPathSignal | null {
  const buckets = new Map<string, CwdCandidate | null>()
  for (const path of paths) {
    const candidate = deepestContaining(candidates, path)
    if (candidate) buckets.set(candidate.key, candidate)
    else if (isWithin(root, path)) buckets.set('', null)
  }
  if (buckets.size !== 1) return null
  const [only] = buckets.values()
  return only ? { kind: 'target', candidate: only } : { kind: 'root' }
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
}): DecisionRequest {
  const message = input.message.length > MESSAGE_MAX_CHARS ? `${input.message.slice(0, MESSAGE_MAX_CHARS)}…` : input.message
  const criteria: Record<string, string | null> = {}
  for (const option of input.options) criteria[option.key] = option.description || null
  criteria[STAY] = STAY_CRITERION
  criteria[UNCLEAR] = UNCLEAR_CRITERION
  return {
    state: {
      message,
      attachments: [...(input.attachments ?? [])],
      current: input.current,
    },
    questions: {
      target: { type: 'choice', instructions: TARGET_INSTRUCTIONS, criteria },
    },
  }
}

/** The small model's prompt: the same state and options as the decision model's request, as text, asking for one option key back. */
export function buildMiniModelPrompt(input: {
  message: string
  attachments?: readonly string[]
  current: { path: string; description: string }
  options: readonly CwdCandidate[]
}): string {
  const message = input.message.length > MESSAGE_MAX_CHARS ? `${input.message.slice(0, MESSAGE_MAX_CHARS)}…` : input.message
  const current = input.current.description ? `${input.current.path} — ${input.current.description}` : input.current.path
  const options = [
    ...input.options.map(option => (option.description ? `- ${option.key}: ${option.description}` : `- ${option.key}`)),
    `- ${STAY}: ${STAY_CRITERION}`,
    `- ${UNCLEAR}: ${UNCLEAR_CRITERION}`,
  ]
  return [
    `${TARGET_INSTRUCTIONS} Pick the folder a chat message is about, from the list below.`,
    '',
    '<message>',
    message,
    '</message>',
    ...(input.attachments?.length ? [`Attachments: ${input.attachments.join(', ')}`] : []),
    `Current folder: ${current}`,
    '',
    'Folders (key: when to pick it):',
    ...options,
    '',
    'Reply with exactly one key from the list, nothing else.',
  ].join('\n')
}

/**
 * The option key the small model replied with: the whole reply, give or take surrounding quotes,
 * backticks and a final period, must be one key (`stay` and `unclear` included). `null` otherwise.
 */
export function parseMiniModelAnswer(text: string | null | undefined, options: readonly CwdCandidate[]): string | null {
  if (!text) return null
  let answer = text.trim()
  for (let previous = ''; previous !== answer;) {
    previous = answer
    answer = answer.replace(/^[`"']+|[`"']+$/g, '').replace(/\.$/, '').trim()
  }
  if (!answer) return null
  const keys = [...options.map(option => option.key), STAY, UNCLEAR]
  if (keys.includes(answer)) return answer
  const folded = keys.filter(key => key.toLowerCase() === answer.toLowerCase())
  return folded.length === 1 ? folded[0]! : null
}

/** Apply the route rules to the small model's pick. It gives no confidence: its pick is taken. `named`: candidates named in the message. */
export function judgeMiniModelAnswer(
  ctx: CwdRouteContext,
  choice: string | null,
  options: readonly CwdCandidate[],
  named: readonly CwdCandidate[],
): CwdRoute {
  const via = 'mini_model' as const
  if (choice === STAY || choice === UNCLEAR) return stay(ctx, 'model', 'stay_or_unclear', { via })
  const target = choice ? options.find(option => option.key === choice) : undefined
  if (!target) return stay(ctx, 'model', 'no_answer', { via })
  const reason = named.some(candidate => candidate.key === target.key) ? 'name' : 'model'
  const picked = { to: target.key, via }
  if (!ctx.isValid(target.path)) return stay(ctx, reason, 'invalid_target', picked)
  return { action: 'route', target: target.path, reason, from: ctx.from, ...picked }
}

/** The small model's reply, or `null` on an error or when it takes longer than `deadlineMs` (the call is then aborted). */
async function askMiniModelWithin(
  ask: NonNullable<CwdRouterDeps['askMiniModel']>,
  prompt: string,
  deadlineMs: number,
  log?: (message: string) => void,
): Promise<string | null> {
  const tag = '[auto_working_directory]'
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      log?.(`${tag} small model: no answer within ${deadlineMs} ms`)
      controller.abort()
      resolve(null)
    }, deadlineMs)
  })
  const answer = ask(prompt, controller.signal).catch((error: unknown) => {
    log?.(`${tag} small model failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  })
  try {
    return await Promise.race([answer, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export interface CwdRouteContext {
  root: string
  /** The session's folder now (the root, or a remembered folder). */
  workingDirectory: string
  /** `workingDirectory` below the root (`(root)` for the root itself). */
  from: string
  isValid: (path: string) => boolean
}

/** No folder picked: the session works in the root. */
function stay(ctx: CwdRouteContext, reason: CwdRoute['reason'], rule: CwdStayRule, extra: Partial<CwdRoute> = {}): CwdRoute {
  return { action: 'stay', reason, from: ctx.from, rule, ...extra }
}

/** A path or a folder name pointing at `target`, without the model. */
export function judgeHardSignal(ctx: CwdRouteContext, target: CwdCandidate, reason: 'path' | 'name'): CwdRoute {
  if (!ctx.isValid(target.path)) return stay(ctx, reason, 'invalid_target', { to: target.key })
  return { action: 'route', target: target.path, reason, from: ctx.from, to: target.key }
}

/** Apply the route rules to the decision model's answer. `named`: candidates named in the message. */
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
  if (!nameHit && confidence < ROUTE_FROM_ROOT_AT) return stay(ctx, reason, 'below_threshold', picked)
  if (!ctx.isValid(target.path)) return stay(ctx, reason, 'invalid_target', picked)
  return { action: 'route', target: target.path, reason, from: ctx.from, ...picked }
}

/**
 * The pick, relative to where the session is: picking the folder it is in keeps it there
 * (`already_there`), and picking nothing for a session in a remembered folder moves it to the root.
 */
function settle(ctx: CwdRouteContext, pick: CwdRoute): CwdRoute {
  if (pick.action === 'route') {
    return isSameDirectory(pick.target, ctx.workingDirectory) ? { ...pick, action: 'stay', target: undefined, rule: 'already_there' } : pick
  }
  if (isSameDirectory(ctx.workingDirectory, ctx.root)) return pick
  return { ...pick, action: 'route', target: ctx.root, to: ROOT_LABEL }
}

/**
 * Where the session's first message says it should work, picked from the root. `null` when the
 * router does not apply (the folder is outside the root, or no listed folder is usable). Never
 * throws on a model failure; a filesystem error may throw, so callers wrap it.
 */
export async function routeWorkingDirectory(input: CwdRouterInput, deps: CwdRouterDeps = {}): Promise<CwdRoute | null> {
  const tag = '[decision:auto_working_directory]'
  const root = resolve(input.root)
  const workingDirectory = resolve(input.workingDirectory)
  if (!isWithin(root, workingDirectory)) {
    deps.log?.(`${tag} skipped: the working directory is outside the context root`)
    return null
  }
  const { candidates, issues } = parseFolderList(input.folders, root)
  if (issues.length > 0) deps.log?.(`${tag} folder list lines skipped: ${issues.map(issue => `${issue.line} (${issue.kind})`).join(', ')}`)
  if (candidates.length === 0) return null

  const ctx: CwdRouteContext = {
    root,
    workingDirectory,
    from: workingDirectory === root ? ROOT_LABEL : keyOf(root, workingDirectory),
    isValid: deps.isValidDirectory ?? (path => isValidWorkingDirectory(path).valid),
  }
  const picked = await pickFromRoot(ctx, input, candidates, deps)
  const route = settle(ctx, picked.route)
  // What happened to the session, for the decision model's answers only
  recordDecisionOutcome(picked.decision, {
    action: route.action,
    changed: route.action === 'route',
    detail: { reason: route.reason, rule: route.rule, from: route.from, to: route.to, confidence: route.confidence },
  })
  return route
}

/** The pick from the root, with the decision model's answer when it was asked. */
async function pickFromRoot(
  ctx: CwdRouteContext,
  input: CwdRouterInput,
  candidates: CwdCandidate[],
  deps: CwdRouterDeps,
): Promise<{ route: CwdRoute; decision?: DecisionResult | null }> {
  const settled = (route: CwdRoute) => ({ route })
  const paths = collectMessagePaths(input.message, input.attachments, { workingDirectory: ctx.workingDirectory, root: ctx.root, homeDir: deps.homeDir })
  const pathSignal = classifyPaths(paths, ctx.root, candidates)
  if (pathSignal?.kind === 'root') return settled(stay(ctx, 'path', 'in_root'))
  if (pathSignal?.kind === 'target') return settled(judgeHardSignal(ctx, pathSignal.candidate, 'path'))

  const named = findNamedCandidates(input.message, candidates)
  if (named.length === 1) return settled(judgeHardSignal(ctx, named[0]!, 'name'))

  // Several folders named: the model picks among them. `stay`/`unclear` are reserved option keys.
  const options = (named.length > 1 ? named : candidates).filter(option => option.key !== STAY && option.key !== UNCLEAR)
  if (options.length === 0) return settled(stay(ctx, 'model', 'no_answer'))
  const attachments = input.attachments?.map(attachment => (attachment.type ? `${attachment.name} (${attachment.type})` : attachment.name))
  const current = { path: ROOT_LABEL, description: describeFolder(ctx.root, ctx.root) }
  // The turn start waits for this answer. The decision model needs only the decision layer on (no toggle).
  const decide = await openDecisionPoint({ ...deps, record: 'auto_working_directory', maxDeadlineMs: FOREGROUND_MAX_DEADLINE_MS, sessionId: input.sessionId })
  if (!decide) {
    // Off or unavailable: the connection's small model, if the host offers one. Not in decisions.jsonl.
    if (!deps.askMiniModel) return settled(stay(ctx, 'model', 'no_answer'))
    const prompt = buildMiniModelPrompt({ message: input.message, attachments, current, options })
    const reply = await askMiniModelWithin(deps.askMiniModel, prompt, deps.miniModelDeadlineMs ?? MINI_MODEL_DEADLINE_MS, deps.log)
    return settled(judgeMiniModelAnswer(ctx, parseMiniModelAnswer(reply, options), options, named))
  }
  const request = buildCwdRouterRequest({ message: input.message, attachments, current, options })
  // No answer from a decision model that opened: stay rather than wait again for the small model
  const decision = await decide(request, { candidates: options.length, narrowed: named.length > 1 })
  return { route: { ...judgeModelAnswer(ctx, decision, options, named), via: 'jev' }, decision }
}

/** One line for the transcript and the log, e.g. `Auto working directory: (root) → projects/acme (name)`. */
export function describeRoute(route: CwdRoute): string {
  const why = route.confidence !== undefined ? `${route.reason}, ${route.confidence.toFixed(2)}` : route.reason
  return `Auto working directory: ${route.from} → ${route.to ?? '?'} (${why})`
}
