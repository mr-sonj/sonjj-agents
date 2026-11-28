import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SystemOneClient,
  normalizeDecisionLayerSettings,
  resolveDecisionEndpoint,
  type DecisionClientResolution,
  type DecisionOutcome,
  type DecisionRecorder,
} from '@craft-agent/shared/decisions'
import {
  MAX_CANDIDATES,
  MESSAGE_MAX_CHARS,
  buildCwdRouterRequest,
  buildMiniModelPrompt,
  classifyPaths,
  collectMessagePaths,
  describeContextFile,
  describeFolder,
  describeRoute,
  findNamedCandidates,
  findTaskFolder,
  anchorRelativeMentions,
  isPlainChatRequest,
  normalizeFolderListLines,
  parseFolderList,
  parseMiniModelAnswer,
  pickLastWorkingDirectory,
  readFolderListLines,
  resolveWorkingDirectoryOrigin,
  routeWorkingDirectory,
  type CwdRouterDeps,
} from './cwd-router'

import type { CreateSessionOptions } from '@craft-agent/shared/protocol'

type Answers = Record<string, unknown>

/** A decision client whose model answers `answers` (or what `answer(body)` returns), keeping each request body. */
function jev(answer: Answers | ((body: { state: Record<string, unknown>; questions: Record<string, { criteria?: Record<string, unknown> }> }) => Answers)) {
  const bodies: Array<{ state: Record<string, unknown>; questions: Record<string, { type: string; criteria?: Record<string, unknown> }> }> = []
  const resolveClient = async (): Promise<DecisionClientResolution> => {
    const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'openrouter' })
    const endpoint = resolveDecisionEndpoint(settings)
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body)
      bodies.push(body)
      const answers = typeof answer === 'function' ? answer(body) : answer
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 })
    }) as unknown as typeof fetch
    const client = new SystemOneClient({ baseUrl: endpoint.baseUrl, apiKey: 'k', model: endpoint.model, fetch: fetchImpl })
    return { ok: true, value: { client, settings, provider: 'openrouter', endpoint, keySource: 'provider' } }
  }
  return { resolveClient, bodies }
}

const pick = (choice: string, confidence: number) => ({ type: 'choice', choice, confidence, probabilities: { [choice]: confidence } })
const off = async (): Promise<DecisionClientResolution> => ({ ok: false, failure: { kind: 'disabled', message: 'off' } })

/** The workspace's folder list in these tests (`projects/notes` and `deep/a/b` exist but are not listed). */
const FOLDERS = [
  '# Projects the first message may move to',
  'projects/acme: storefront API, prices and endpoints',
  'projects/garden: planting calendar and watering',
  '',
  'content: blog posts and newsletters',
  'content/drafts: articles waiting for review',
]

describe('cwd router', () => {
  let root: string
  let outside: string
  let outcomes: DecisionOutcome[]
  let logs: string[]

  function write(rel: string, content: string) {
    const file = join(root, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content)
  }

  function deps(extra: Partial<CwdRouterDeps> = {}): CwdRouterDeps {
    const recorder = {
      append: async () => {},
      record: async () => ({}),
      recordOutcome: async (_record: unknown, outcome: DecisionOutcome) => { outcomes.push(outcome) },
      recordFollowUp: async () => {},
    } as unknown as DecisionRecorder
    return { recorder, log: line => logs.push(line), homeDir: join(root, '..'), ...extra }
  }

  const at = (rel = '') => (rel ? join(root, rel) : root)
  const route = (message: string, from = '', extra: Partial<CwdRouterDeps> = {}, attachments?: { path?: string; name: string; type?: string }[], folders = FOLDERS, lastWorkingDirectory?: string) =>
    routeWorkingDirectory({ root, workingDirectory: at(from), message, attachments, sessionId: 's1', folders, lastWorkingDirectory }, deps(extra))
  const listed = (lines = FOLDERS) => parseFolderList(lines, root).candidates

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cwd-router-'))
    outside = mkdtempSync(join(tmpdir(), 'cwd-router-outside-'))
    outcomes = []
    logs = []
    write('AGENTS.md', '# Workspace\n\nEverything lives here.')
    write('projects/acme/AGENTS.md', '---\nproject_role: "Acme storefront API: pricing, endpoints"\ndescription: ignored\n---\n# Acme\n')
    write('projects/acme/tasks/rework/AGENTS.md', '# Rework pricing\n\nMove the pricing endpoint to v2.')
    write('projects/garden/CLAUDE.md', '# Garden plans\n\nPlanting calendar, watering and\nseed orders.\n')
    write('projects/notes/readme.md', 'no context file here')
    write('content/AGENTS.md', '---\ntitle: Content studio\n---\n')
    write('content/drafts/AGENTS.md', '---\ndescription: >\n  Draft articles\n  waiting for review\n---\n')
    write('deep/a/b/AGENTS.md', '# Deep')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  describe('the folder list', () => {
    it('keeps the listed folders in order, each described by its note and then its context file', () => {
      expect(listed().map(c => [c.key, c.description])).toEqual([
        ['projects/acme', 'storefront API, prices and endpoints (Acme storefront API: pricing, endpoints)'],
        ['projects/garden', 'planting calendar and watering (Garden plans — Planting calendar, watering and seed orders.)'],
        ['content', 'blog posts and newsletters (Content studio)'],
        ['content/drafts', 'articles waiting for review (Draft articles waiting for review)'],
      ])
      expect(listed().map(c => c.path)).toEqual([at('projects/acme'), at('projects/garden'), at('content'), at('content/drafts')])
      // Without a note, the context file alone; without a context file, the note alone
      expect(listed(['projects/garden', 'projects/notes: my notes']).map(c => c.description)).toEqual(['Garden plans — Planting calendar, watering and seed orders.', 'my notes'])
      expect(parseFolderList(FOLDERS, root, { describe: false }).candidates[0]!.description).toBe('storefront API, prices and endpoints')
    })

    it('reports lines that name no folder inside the root, and skips them', () => {
      const { candidates, issues } = parseFolderList([
        '/somewhere/else: absolute',
        '../escape: outside',
        '.: the root itself',
        ': no folder',
        'missing/folder: not there',
        'projects/acme: first',
        'projects/acme/: again',
        './projects/garden/: written loosely',
        '# a comment: not a folder',
      ], root)
      expect(candidates.map(c => c.key)).toEqual(['projects/acme', 'projects/garden'])
      expect(issues).toEqual([
        { line: 1, path: '/somewhere/else', kind: 'outside_root' },
        { line: 2, path: '../escape', kind: 'outside_root' },
        { line: 3, path: '.', kind: 'outside_root' },
        { line: 4, path: '', kind: 'no_path' },
        { line: 5, path: 'missing/folder', kind: 'missing' },
        { line: 7, path: 'projects/acme/', kind: 'duplicate' },
      ])
    })

    it('reads aliases in parentheses before the colon', () => {
      const [garden] = parseFolderList(['projects/garden (Vườn rau, watering , vườn rau,): planting'], root).candidates
      expect(garden).toMatchObject({ key: 'projects/garden', path: at('projects/garden'), aliases: ['Vườn rau', 'watering'] })
      expect(garden!.description).toBe('planting (aliases: Vườn rau, watering) (Garden plans — Planting calendar, watering and seed orders.)')
      expect(listed(['projects/garden (veggies)']).map(c => c.description)).toEqual(['(aliases: veggies) (Garden plans — Planting calendar, watering and seed orders.)'])
      expect(listed(['projects/acme: x']).map(c => c.aliases)).toEqual([[]])
      // A wrong path is reported without its aliases
      expect(parseFolderList(['projects/nope (a, b): x'], root).issues).toEqual([{ line: 1, path: 'projects/nope', kind: 'missing' }])
    })

    it('uses at most the first MAX_CANDIDATES folders', () => {
      const lines: string[] = []
      for (let i = 0; i <= MAX_CANDIDATES; i++) {
        mkdirSync(join(root, `many/p${i}`), { recursive: true })
        lines.push(`many/p${i}: project ${i}`)
      }
      const { candidates, issues } = parseFolderList(lines, root, { describe: false })
      expect(candidates).toHaveLength(MAX_CANDIDATES)
      expect(issues).toEqual([{ line: MAX_CANDIDATES + 1, path: `many/p${MAX_CANDIDATES}`, kind: 'too_many' }])
    })

    it('reads a hand-edited list without throwing: a string, or entries that are not strings', () => {
      expect(readFolderListLines('projects/acme: x\nprojects/garden: y')).toEqual(['projects/acme: x', 'projects/garden: y'])
      expect(readFolderListLines(['projects/acme: x', { path: 'projects/garden' }, 3])).toEqual(['projects/acme: x', '{"path":"projects/garden"}', '3'])
      expect(readFolderListLines({ path: 'projects/garden' })).toEqual(['{"path":"projects/garden"}'])
      expect(readFolderListLines(undefined)).toEqual([])
      // The odd entry shows up as a line naming no folder
      expect(parseFolderList(readFolderListLines(['projects/acme: x', { path: 'projects/garden' }]), root, { describe: false }).issues).toEqual([{ line: 2, path: '{"path"', kind: 'missing' }])
    })

    it('is stored as lines without trailing spaces or blank lines', () => {
      expect(normalizeFolderListLines('a: x  \r\nb: y\n\n\n')).toEqual(['a: x', 'b: y'])
      expect(normalizeFolderListLines(['a: x', 'b: y\nc: z', '', ''])).toEqual(['a: x', 'b: y', 'c: z'])
      expect(normalizeFolderListLines(null)).toEqual([])
      expect(() => normalizeFolderListLines([1, 2])).toThrow()
    })

    it('describes context files by project_role, description or title, else their H1 and first paragraph', () => {
      expect(describeContextFile(`# T\n\n${'word '.repeat(100)}`).length).toBeLessThanOrEqual(200)
      expect(describeContextFile('No heading, just text\nover two lines.\n\nSecond paragraph.')).toBe('No heading, just text over two lines.')
    })

    it('describes the working directory from the nearest context file above it', () => {
      mkdirSync(join(root, 'projects/acme/tasks/rework/notes'), { recursive: true })
      mkdirSync(join(root, 'projects/notes/deeper'), { recursive: true })
      expect(describeFolder(at('projects/acme/tasks/rework/notes'), root)).toBe('Rework pricing — Move the pricing endpoint to v2.')
      expect(describeFolder(at('projects/notes/deeper'), root)).toBe('Workspace — Everything lives here.')
    })

    it('does not run without a usable folder in the list', async () => {
      const model = jev({ target: pick('stay', 0.9) })
      expect(await route('plan the garden', '', { resolveClient: model.resolveClient }, undefined, [])).toBeNull()
      expect(await route('plan the garden', '', { resolveClient: model.resolveClient }, undefined, ['missing: x', '# only a comment'])).toBeNull()
      expect(model.bodies).toHaveLength(0)
      expect(logs.some(line => line.includes('1 (missing)'))).toBe(true)
    })
  })

  describe('hard signals', () => {
    const candidates = () => listed()

    it('collects mentioned, @-mentioned, absolute and attached paths', () => {
      const paths = collectMessagePaths(
        `look at [file:src/a.ts] and [Mentioned file: b.md (at ${at('content/b.md')})], @projects/acme/AGENTS.md, ${at('projects/garden/x.txt')}. Also @someone and https://example.com/a/b`,
        [{ path: at('content/drafts/c.png') }],
        { workingDirectory: at('projects/acme'), root },
      )
      expect(paths.sort()).toEqual([
        at('content/b.md'),
        at('content/drafts/c.png'),
        at('projects/acme/AGENTS.md'),
        at('projects/acme/src/a.ts'),
        at('projects/garden/x.txt'),
      ].sort())
    })

    it('points at the deepest listed folder holding the paths, or at the root, and ignores paths that disagree', () => {
      expect(classifyPaths([at('projects/notes/x.md')], root, candidates())).toEqual({ kind: 'root' })
      expect(classifyPaths([at('projects/garden/x')], root, candidates())).toMatchObject({ kind: 'target', candidate: { key: 'projects/garden' } })
      expect(classifyPaths([at('content/drafts/x')], root, candidates())).toMatchObject({ kind: 'target', candidate: { key: 'content/drafts' } })
      expect(classifyPaths([at('projects/garden/x'), at('content/x')], root, candidates())).toBeNull()
      expect(classifyPaths([at('projects/garden/x'), at('projects/notes/y')], root, candidates())).toBeNull()
      expect(classifyPaths(['/somewhere/else'], root, candidates())).toBeNull()
    })

    it('matches folder names as whole tokens, any case, at least four characters', () => {
      write('projects/api/AGENTS.md', '# API')
      write('projects/acme-api/AGENTS.md', '# Acme API')
      const candidates = listed(['projects/acme', 'projects/acme-api', 'projects/api', 'projects/garden'])
      const keys = (message: string) => findNamedCandidates(message, candidates).map(c => c.key)
      expect(keys('check the ACME pricing')).toEqual(['projects/acme'])
      expect(keys('check acme-api and the garden.')).toEqual(['projects/acme-api', 'projects/garden'])
      expect(keys('the api is down')).toEqual([])
      expect(keys('acmeish gardens')).toEqual([])
    })

    it('matches a folder name written decomposed (NFD) against a message in NFC', () => {
      const nfd = 'projects/vườn-nhà'.normalize('NFD')
      mkdirSync(join(root, nfd), { recursive: true })
      expect(findNamedCandidates('tưới vườn-nhà sáng nay', listed([`${nfd}: garden`])).map(c => c.key)).toEqual([nfd])
    })

    it('matches aliases like folder names, with their accents, any case', () => {
      const candidates = listed(['projects/garden (vườn rau, veg): planting', 'projects/acme (cửa hàng): storefront'])
      const keys = (message: string) => findNamedCandidates(message, candidates).map(c => c.key)
      expect(keys('tưới VƯỜN RAU sáng nay')).toEqual(['projects/garden'])
      expect(keys('tuoi vuon rau sang nay')).toEqual([])
      expect(keys('mở cửa hàng và vườn rau')).toEqual(['projects/garden', 'projects/acme'])
      // Shorter than four characters: sent to the model, never matched
      expect(keys('buy veg')).toEqual([])
      // NFD input matches an NFC alias
      expect(keys('vườn rau'.normalize('NFD'))).toEqual(['projects/garden'])
    })

    it('routes on an alias without asking the model, as on a folder name', async () => {
      const model = jev({ target: pick('stay', 0.9) })
      const lines = ['projects/garden (vườn rau): planting', 'projects/acme: storefront']
      expect(await route('tưới vườn rau sáng nay', '', { resolveClient: model.resolveClient }, undefined, lines)).toMatchObject({ action: 'route', reason: 'alias', target: at('projects/garden') })
      expect(model.bodies).toHaveLength(0)
      // A name and an alias pointing at different folders: the model picks between them
      const both = jev({ target: pick('projects/acme', 0.6) })
      expect(await route('acme hay vườn rau?', '', { resolveClient: both.resolveClient }, undefined, lines)).toMatchObject({ action: 'route', reason: 'name', to: 'projects/acme' })
      expect(Object.keys(both.bodies[0]!.questions.target!.criteria!)).toEqual(['projects/garden', 'projects/acme', 'stay', 'unclear'])
    })

    it('routes on a path without asking the model', async () => {
      const model = jev({ target: pick('stay', 0.9) })
      expect(await route(`fix ${at('projects/garden/plan.md')}`, '', { resolveClient: model.resolveClient })).toMatchObject({ action: 'route', reason: 'path', target: at('projects/garden'), from: '(root)', to: 'projects/garden' })
      expect(await route('fix it', 'projects/acme', { resolveClient: model.resolveClient }, [{ path: at('projects/garden/a.png'), name: 'a.png' }])).toMatchObject({ action: 'route', reason: 'path', to: 'projects/garden' })
      expect(await route(`fix ${at('projects/acme/src/x.ts')}`, 'projects/acme', { resolveClient: model.resolveClient })).toMatchObject({ action: 'stay', reason: 'path', rule: 'already_there', to: 'projects/acme' })
      expect(model.bodies).toHaveLength(0)
    })

    it('routes from the root on the one folder named, without asking the model', async () => {
      const model = jev({ target: pick('stay', 0.9) })
      expect(await route('plan the garden for spring', '', { resolveClient: model.resolveClient })).toMatchObject({ action: 'route', reason: 'name', to: 'projects/garden' })
      expect(model.bodies).toHaveLength(0)
    })

    it('only knows listed folders: a path elsewhere keeps the session put, other names are no signal', async () => {
      const model = jev({ target: pick('stay', 0.9) })
      // A path in the root outside every listed folder
      expect(await route(`look at ${at('projects/notes/todo.md')}`, '', { resolveClient: model.resolveClient })).toMatchObject({ action: 'stay', reason: 'path', rule: 'in_root' })
      expect(model.bodies).toHaveLength(0)
      // `notes` is a folder, but not listed: the model is asked, and never offered it
      expect(await route('clean up my notes', '', { resolveClient: model.resolveClient })).toMatchObject({ action: 'stay', reason: 'model' })
      expect(Object.keys(model.bodies[0]!.questions.target!.criteria!)).toEqual(['projects/acme', 'projects/garden', 'content', 'content/drafts', 'stay', 'unclear'])
    })

    it('never takes a word from a note for a hard signal', async () => {
      const model = jev({ target: pick('projects/garden', 0.6) })
      // "watering" is only in the garden note: the model is asked, and 0.6 is below the root threshold
      expect(await route('make a watering schedule', '', { resolveClient: model.resolveClient })).toMatchObject({ action: 'stay', reason: 'model', rule: 'below_threshold' })
      expect(model.bodies).toHaveLength(1)
    })

    it('narrows the options to the folders named when several are', async () => {
      const model = jev({ target: pick('projects/garden', 0.6) })
      expect(await route('acme or garden?', '', { resolveClient: model.resolveClient })).toMatchObject({ action: 'route', reason: 'name', to: 'projects/garden', confidence: 0.6 })
      expect(Object.keys(model.bodies[0]!.questions.target!.criteria!)).toEqual(['projects/acme', 'projects/garden', 'stay', 'unclear'])
    })
  })

  describe('the model', () => {
    it('sends relative paths only, the clipped message and attachment names, always from the root', async () => {
      const model = jev({ target: pick('stay', 0.9) })
      await route(`${'x'.repeat(MESSAGE_MAX_CHARS + 10)}`, '', { resolveClient: model.resolveClient }, [{ name: 'shot.png', type: 'image' }])
      await route('continue', 'projects/acme/tasks/rework', { resolveClient: model.resolveClient })
      const [fromRoot] = model.bodies
      expect((fromRoot!.state.message as string).length).toBe(MESSAGE_MAX_CHARS + 1)
      expect(fromRoot!.state.attachments).toEqual(['shot.png (image)'])
      for (const body of model.bodies) {
        expect(body.questions.belongs_here).toBeUndefined()
        expect(body.state.current).toEqual({ path: '(root)', description: 'Workspace — Everything lives here.' })
      }
      expect(JSON.stringify(model.bodies)).not.toContain(root)
    })

    it('stays on stay, unclear, low confidence or no answer', async () => {
      expect(await route('hi', '', { resolveClient: jev({ target: pick('stay', 0.95) }).resolveClient })).toMatchObject({ action: 'stay', rule: 'stay_or_unclear' })
      expect(await route('hi', '', { resolveClient: jev({ target: pick('unclear', 0.95) }).resolveClient })).toMatchObject({ action: 'stay', rule: 'stay_or_unclear' })
      expect(await route('hmm', '', { resolveClient: jev({ target: pick('projects/garden', 0.45) }).resolveClient })).toMatchObject({ action: 'stay', rule: 'low_confidence', to: 'projects/garden' })
      expect(await route('hmm', '', { resolveClient: off })).toMatchObject({ action: 'stay', rule: 'no_answer' })
    })

    it('from the root, routes on the model alone at 0.7', async () => {
      expect(await route('when should we plant tomatoes?', '', { resolveClient: jev({ target: pick('projects/garden', 0.72) }).resolveClient })).toMatchObject({ action: 'route', reason: 'model', to: 'projects/garden', confidence: 0.72 })
      expect(await route('when should we plant tomatoes?', '', { resolveClient: jev({ target: pick('projects/garden', 0.65) }).resolveClient })).toMatchObject({ action: 'stay', rule: 'below_threshold' })
    })

    it('routes from the root even when the session sits in a remembered folder', async () => {
      const result = await route('plan the garden for spring', 'projects/acme')
      expect(result).toMatchObject({ action: 'route', target: at('projects/garden'), from: 'projects/acme', to: 'projects/garden', reason: 'name' })
      // Into the project of the task folder it sits in, when a path says so
      expect(await route(`edit ${at('projects/acme/AGENTS.md')}`, 'projects/acme/tasks/rework')).toMatchObject({ action: 'route', reason: 'path', target: at('projects/acme') })
    })

    it('moves a session in a remembered folder back to the root when nothing is picked', async () => {
      const result = await route('hello', 'projects/acme', { resolveClient: jev({ target: pick('stay', 0.9) }).resolveClient })
      expect(result).toMatchObject({ action: 'route', target: root, from: 'projects/acme', to: '(root)', reason: 'model', rule: 'stay_or_unclear' })
      expect(await route(`look at ${at('projects/notes/todo.md')}`, 'projects/acme')).toMatchObject({ action: 'route', target: root, to: '(root)', reason: 'path', rule: 'in_root' })
    })

    it('stays in the root when nothing is picked there', async () => {
      expect(await route('hello', '', { resolveClient: jev({ target: pick('stay', 0.9) }).resolveClient })).toMatchObject({ action: 'stay', from: '(root)', rule: 'stay_or_unclear' })
    })

    it('stays when the target is not a usable folder', async () => {
      expect(await route('plan the garden for spring', '', { isValidDirectory: () => false })).toMatchObject({ action: 'stay', rule: 'invalid_target' })
    })

    it('records what it did with every answer', async () => {
      await route('when do we plant?', '', { resolveClient: jev({ target: pick('projects/garden', 0.8) }).resolveClient })
      await route('hi', '', { resolveClient: jev({ target: pick('stay', 0.9) }).resolveClient })
      expect(outcomes).toEqual([
        { action: 'route', changed: true, detail: { reason: 'model', rule: undefined, from: '(root)', to: 'projects/garden', confidence: 0.8 } },
        { action: 'stay', changed: false, detail: { reason: 'model', rule: 'stay_or_unclear', from: '(root)', to: undefined, confidence: 0.9 } },
      ])
    })

    it('does not run outside the root', async () => {
      expect(await routeWorkingDirectory({ root, workingDirectory: outside, message: 'x', folders: FOLDERS }, deps())).toBeNull()
    })
  })

  describe('the last chat\'s folder', () => {
    const rework = () => at('projects/acme/tasks/rework')
    const last = (message: string, extra: Partial<CwdRouterDeps> = {}, folder = rework(), from = '') => route(message, from, extra, undefined, FOLDERS, folder)
    const keysOf = (body: { questions: Record<string, { criteria?: Record<string, unknown> }> }) => Object.keys(body.questions.target!.criteria!)

    it('is the folder of the latest chat inside the root, skipping the root and outside folders', () => {
      expect(pickLastWorkingDirectory([
        { workingDirectory: at('projects/acme'), lastActivityAt: 1 },
        { workingDirectory: root, lastActivityAt: 3 },
        { workingDirectory: outside, lastActivityAt: 4 },
        { workingDirectory: undefined, lastActivityAt: 5 },
        { workingDirectory: rework(), lastActivityAt: 2 },
      ], root)).toBe(rework())
      expect(pickLastWorkingDirectory([{ workingDirectory: root, lastActivityAt: 1 }], root)).toBeUndefined()
      expect(pickLastWorkingDirectory([], root)).toBeUndefined()
    })

    it('is offered for a follow-up, by its relative path only', async () => {
      const model = jev({ target: pick('last', 0.8) })
      expect(await last('continue', { resolveClient: model.resolveClient })).toMatchObject({ action: 'route', target: rework(), to: 'projects/acme/tasks/rework', last: true, reason: 'model', via: 'jev' })
      const criteria = model.bodies[0]!.questions.target!.criteria!
      expect(keysOf(model.bodies[0]!)).toEqual(['projects/acme', 'projects/garden', 'content', 'content/drafts', 'last', 'stay', 'unclear'])
      expect(criteria.last).toContain('projects/acme/tasks/rework — the folder the previous chat worked in')
      expect(criteria.last).toContain('Rework pricing — Move the pricing endpoint to v2.')
      expect(JSON.stringify(model.bodies)).not.toContain(root)
    })

    it('needs 0.7 from the decision model', async () => {
      expect(await last('continue', { resolveClient: jev({ target: pick('last', 0.6) }).resolveClient })).toMatchObject({ action: 'stay', rule: 'below_threshold', to: 'projects/acme/tasks/rework' })
    })

    it('is taken when the small model picks it', async () => {
      const prompts: string[] = []
      const askMiniModel = async (prompt: string) => { prompts.push(prompt); return 'last' }
      expect(await last('continue', { resolveClient: off, askMiniModel })).toMatchObject({ action: 'route', target: rework(), last: true, via: 'mini_model' })
      expect(prompts[0]).toContain('- last: projects/acme/tasks/rework — the folder the previous chat worked in')
    })

    it('is where a path inside it points', async () => {
      expect(await last(`fix ${join(rework(), 'notes.md')}`)).toMatchObject({ action: 'route', reason: 'path', target: rework(), last: true })
    })

    it('keeps a session that sits in it there', async () => {
      expect(await last('continue', { resolveClient: jev({ target: pick('last', 0.9) }).resolveClient }, rework(), 'projects/acme/tasks/rework')).toMatchObject({ action: 'stay', rule: 'already_there' })
    })

    it('is not offered at the root, outside it, missing or unusable', async () => {
      for (const [folder, extra] of [[root, {}], [outside, {}], [at('projects/missing'), {}], [rework(), { isValidDirectory: (path: string) => path !== rework() }]] as const) {
        const model = jev({ target: pick('stay', 0.9) })
        await last('continue', { resolveClient: model.resolveClient, ...extra }, folder)
        expect(keysOf(model.bodies[0]!)).not.toContain('last')
      }
    })

    it('is folded into the listed folder it is', async () => {
      const model = jev({ target: pick('stay', 0.9) })
      await last('continue', { resolveClient: model.resolveClient }, at('projects/garden'))
      expect(keysOf(model.bodies[0]!)).not.toContain('last')
      expect(model.bodies[0]!.questions.target!.criteria!['projects/garden']).toContain('Also the folder the previous chat worked in')
    })

    it('is not offered when the message names folders, and never matched by name', async () => {
      const model = jev({ target: pick('projects/garden', 0.6) })
      await last('acme or garden?', { resolveClient: model.resolveClient })
      expect(keysOf(model.bodies[0]!)).toEqual(['projects/acme', 'projects/garden', 'stay', 'unclear'])
      expect(await last('the rework again', { resolveClient: jev({ target: pick('stay', 0.9) }).resolveClient })).toMatchObject({ action: 'stay', reason: 'model' })
    })

    it('leaves out a listed folder named by the reserved word', async () => {
      mkdirSync(join(root, 'last'), { recursive: true })
      const model = jev({ target: pick('stay', 0.9) })
      await route('continue', '', { resolveClient: model.resolveClient }, undefined, [...FOLDERS, 'last: a folder named last'])
      expect(keysOf(model.bodies[0]!)).toEqual(['projects/acme', 'projects/garden', 'content', 'content/drafts', 'stay', 'unclear'])
    })
  })

  describe('task folders', () => {
    const TASKS = ['241101-acme-build-lan-dashboard', '241102-acme_shop-forecast-tide', '241103-acme_shop-forecast-tide-north', '_archive/241001-acme-build-lan-dashboard', '.cache/lan-dashboard-build']
    const tasks = () => { for (const rel of TASKS) mkdirSync(join(root, 'projects/acme', rel), { recursive: true }) }
    const acme = () => listed().find(candidate => candidate.key === 'projects/acme')!
    const lan = 'projects/acme/241101-acme-build-lan-dashboard'

    it('goes into the task folder the message names by two words', async () => {
      tasks()
      expect(await route('tiếp task lan dashboard cho acme')).toMatchObject({ action: 'route', reason: 'name', target: at(lan), to: lan, task: lan })
      expect(await route('acme')).toMatchObject({ action: 'route', target: at('projects/acme'), to: 'projects/acme' })
    })

    it('stays in the project on one word, a tie, or only words of the project name', () => {
      tasks()
      expect(findTaskFolder(acme(), 'the dashboard', listed())).toBeNull()
      expect(findTaskFolder(acme(), 'forecast tide', listed())).toBeNull()
      expect(findTaskFolder(acme(), 'acme build', listed())).toBeNull()
      expect(findTaskFolder(acme(), 'acme shop forecast', listed())).toBeNull()
      expect(findTaskFolder(acme(), 'forecast tide north', listed())).toBe(at('projects/acme/241103-acme_shop-forecast-tide-north'))
      expect(findTaskFolder(acme(), 'Lan DASHBOARD', listed())).toBe(at(lan))
    })

    it('skips folders starting with _ or ., and listed folders', () => {
      for (const rel of ['_spring-campaign', '.spring-campaign', 'spring-campaign']) mkdirSync(join(root, 'content', rel), { recursive: true })
      const content = (lines: string[]) => listed(lines).find(candidate => candidate.key === 'content')!
      expect(findTaskFolder(content(FOLDERS), 'the spring campaign', listed())).toBe(at('content/spring-campaign'))
      const withCampaign = [...FOLDERS, 'content/spring-campaign: campaign']
      expect(findTaskFolder(content(withCampaign), 'the spring campaign', listed(withCampaign))).toBeNull()
    })

    it('never refines the last folder', async () => {
      mkdirSync(join(root, 'projects/notes/241101-notes-build-lan-dashboard'), { recursive: true })
      const model = jev({ target: pick('last', 0.9) })
      expect(await route('continue the lan dashboard', '', { resolveClient: model.resolveClient }, undefined, FOLDERS, at('projects/notes'))).toMatchObject({ action: 'route', target: at('projects/notes'), last: true })
    })

    it('also refines a route that a path or an attachment chose', async () => {
      tasks()
      expect(await route(`fix ${at(`${lan}/plan.md`)}`)).toMatchObject({ action: 'route', reason: 'path', target: at(lan), task: lan })
      expect(await route('fix this', '', {}, [{ path: at(`${lan}/shot.png`), name: 'shot.png' }])).toMatchObject({ target: at(lan), task: lan })
    })

    it('breaks a tie with the folder a path is in', async () => {
      tasks()
      const tide = 'projects/acme/241102-acme_shop-forecast-tide'
      expect(await route(`check [file:${tide}/plan.md]`)).toMatchObject({ action: 'route', reason: 'path', target: at(tide), task: tide })
      expect(findTaskFolder(acme(), 'forecast tide', listed(), [at(`${tide}/plan.md`)])).toBe(at(tide))
      // A path into a folder that is not among the best keeps the tie
      expect(findTaskFolder(acme(), 'forecast tide', listed(), [at(`${lan}/x.md`)])).toBeNull()
    })

    it('never counts words of the folders above the project', async () => {
      tasks()
      // The test root is named cwd-router-…: "router" comes from the path, "notes" from the file name
      mkdirSync(join(root, 'projects/acme/241104-acme-router-notes'), { recursive: true })
      expect(findTaskFolder(acme(), `fix ${at('projects/acme/notes.md')}`, listed())).toBeNull()
      // The cost: a word of a folder above the project never counts, even when the user means it
      expect(findTaskFolder(acme(), 'router notes', listed())).toBeNull()
      expect(findTaskFolder(acme(), 'build the lan dashboard', listed())).toBe(at(lan))
    })

    it('leaves out the words of a project name written with _ or .', () => {
      for (const rel of ['260623-shop_com-content-strategy', '260721-shop_com-strategy-keywords']) mkdirSync(join(root, 'projects/shop.com', rel), { recursive: true })
      const lines = ['projects/shop.com: the shop']
      const shop = listed(lines)[0]!
      expect(findTaskFolder(shop, 'shop com strategy', listed(lines))).toBeNull()
      expect(findTaskFolder(shop, 'shop com content', listed(lines))).toBeNull()
      expect(findTaskFolder(shop, 'the strategy keywords', listed(lines))).toBe(at('projects/shop.com/260721-shop_com-strategy-keywords'))
    })

    it('stays in the project when the task folder is not usable', async () => {
      tasks()
      const result = await route('tiếp task lan dashboard cho acme', '', { isValidDirectory: path => path !== at(lan) })
      expect(result).toMatchObject({ action: 'route', target: at('projects/acme'), to: 'projects/acme' })
      expect(result?.task).toBeUndefined()
    })
  })

  describe('without the decision model', () => {
    /** A small model replying `reply` (or what `reply(prompt)` returns), keeping each prompt. */
    function mini(reply: string | null | ((prompt: string) => string | null)) {
      const prompts: string[] = []
      const askMiniModel = async (prompt: string) => {
        prompts.push(prompt)
        return typeof reply === 'function' ? reply(prompt) : reply
      }
      return { askMiniModel, prompts }
    }
    const withMini = (reply: Parameters<typeof mini>[0]) => ({ resolveClient: off, askMiniModel: mini(reply).askMiniModel })

    it('routes from the root on the small model\'s pick', async () => {
      const model = mini('projects/garden')
      expect(await route('when should we plant tomatoes?', '', { resolveClient: off, askMiniModel: model.askMiniModel })).toMatchObject({ action: 'route', reason: 'model', via: 'mini_model', target: at('projects/garden'), from: '(root)', to: 'projects/garden' })
      expect(model.prompts).toHaveLength(1)
    })

    it('accepts a pick wrapped in quotes, backticks or a final period, nothing longer', async () => {
      expect(await route('when should we plant tomatoes?', '', withMini('`projects/garden`.'))).toMatchObject({ action: 'route', to: 'projects/garden' })
      expect(await route('when should we plant tomatoes?', '', withMini(' "Projects/Garden" '))).toMatchObject({ action: 'route', to: 'projects/garden' })
      expect(await route('when should we plant tomatoes?', '', withMini('I would pick projects/garden'))).toMatchObject({ action: 'stay', rule: 'no_answer', via: 'mini_model' })
      const options = parseFolderList(FOLDERS, root, { describe: false }).candidates
      expect(parseMiniModelAnswer('STAY', options)).toBe('stay')
      expect(parseMiniModelAnswer('content/drafts\n', options)).toBe('content/drafts')
      expect(parseMiniModelAnswer('projects/notes', options)).toBeNull()
      expect(parseMiniModelAnswer('', options)).toBeNull()
    })

    it('stays on stay, unclear, an unknown key, no reply or an error', async () => {
      expect(await route('hi', '', withMini('stay'))).toMatchObject({ action: 'stay', rule: 'stay_or_unclear', via: 'mini_model' })
      expect(await route('hi', '', withMini('unclear'))).toMatchObject({ action: 'stay', rule: 'stay_or_unclear' })
      expect(await route('hi', '', withMini('projects/notes'))).toMatchObject({ action: 'stay', rule: 'no_answer' })
      expect(await route('hi', '', withMini(null))).toMatchObject({ action: 'stay', rule: 'no_answer' })
      expect(await route('hi', '', { resolveClient: off, askMiniModel: async () => { throw new Error('boom') } })).toMatchObject({ action: 'stay', rule: 'no_answer' })
      expect(logs.some(line => line.includes('small model failed: boom'))).toBe(true)
    })

    it('routes a session in a remembered folder on the small model\'s pick, with no name needed', async () => {
      expect(await route('when should we plant tomatoes?', 'projects/acme', withMini('projects/garden'))).toMatchObject({ action: 'route', reason: 'model', via: 'mini_model', from: 'projects/acme', to: 'projects/garden' })
      expect(await route('continue', 'projects/acme', withMini('stay'))).toMatchObject({ action: 'route', target: root, to: '(root)', rule: 'stay_or_unclear' })
    })

    it('stays when the small model does not answer in time, and aborts it', async () => {
      let signal: AbortSignal | undefined
      const hang = (_prompt: string, s: AbortSignal) => { signal = s; return new Promise<string | null>(() => {}) }
      expect(await route('when should we plant tomatoes?', '', { resolveClient: off, askMiniModel: hang, miniModelDeadlineMs: 20 })).toMatchObject({ action: 'stay', rule: 'no_answer' })
      expect(signal?.aborted).toBe(true)
      expect(logs.some(line => line.includes('no answer within 20 ms'))).toBe(true)
    })

    it('does not ask the small model when the decision model opened but gave no answer', async () => {
      const model = mini('projects/garden')
      const failing = async (): Promise<DecisionClientResolution> => {
        const resolution = await jev({}).resolveClient()
        if (!resolution.ok) return resolution
        const client = new SystemOneClient({ baseUrl: resolution.value.endpoint.baseUrl, apiKey: 'k', model: resolution.value.endpoint.model, fetch: (async () => new Response('down', { status: 500 })) as unknown as typeof fetch })
        return { ok: true, value: { ...resolution.value, client } }
      }
      expect(await route('when should we plant tomatoes?', '', { resolveClient: failing, askMiniModel: model.askMiniModel })).toMatchObject({ action: 'stay', rule: 'no_answer', via: 'jev' })
      expect(model.prompts).toHaveLength(0)
    })

    it('stays without a small model', async () => {
      expect(await route('when should we plant tomatoes?', '', { resolveClient: off })).toMatchObject({ action: 'stay', rule: 'no_answer' })
    })

    it('sends relative paths only, the notes, the root as the current folder and the reserved keys', async () => {
      const model = mini('stay')
      await route('check the watering schedule', 'projects/acme/tasks/rework', { resolveClient: off, askMiniModel: model.askMiniModel }, [{ name: 'shot.png', type: 'image' }])
      const [prompt] = model.prompts
      expect(prompt).toContain('- projects/garden: planting calendar and watering (Garden plans — Planting calendar, watering and seed orders.)')
      expect(prompt).toContain('Current folder: (root) — Workspace — Everything lives here.')
      expect(prompt).toContain('Attachments: shot.png (image)')
      expect(prompt).not.toContain('counts as stay')
      expect(prompt).toContain('- unclear: Cannot tell')
      expect(prompt).toContain('<message>\ncheck the watering schedule\n</message>')
      expect(prompt).not.toContain(root)
      const bare = buildMiniModelPrompt({ message: 'x', current: { path: '(root)', description: '' }, options: [] })
      expect(bare).toContain('Current folder: (root)')
    })

    it('records nothing in the decision log', async () => {
      await route('when should we plant tomatoes?', '', withMini('projects/garden'))
      expect(outcomes).toEqual([])
    })

    it('ignores a decision toggle stored by an earlier version', () => {
      const settings = normalizeDecisionLayerSettings({ enabled: true, features: { autoWorkingDirectory: true } as never })
      expect(Object.keys(settings.features)).not.toContain('autoWorkingDirectory')
    })
  })

  it('builds the request with the reserved options last', () => {
    const request = buildCwdRouterRequest({ message: 'm', current: { path: '(root)', description: '' }, options: [{ key: 'a/b', path: '/r/a/b', description: '', aliases: [] }] })
    expect(request.questions.target).toMatchObject({ type: 'choice', criteria: { 'a/b': null, stay: expect.any(String), unclear: 'Cannot tell' } })
  })

  it('describes a route in one line', () => {
    expect(describeRoute({ action: 'route', reason: 'model', confidence: 0.912, from: '(root)', to: 'projects/acme' })).toBe('Auto working directory: (root) → projects/acme (model, 0.91)')
    expect(describeRoute({ action: 'route', reason: 'path', from: 'a', to: 'b' })).toBe('Auto working directory: a → b (path)')
    expect(describeRoute({ action: 'route', reason: 'model', from: 'projects/acme', to: '(root)', rule: 'stay_or_unclear' })).toBe('Auto working directory: projects/acme → (root) (model)')
    expect(describeRoute({ action: 'route', reason: 'name', from: '(root)', to: 'projects/acme/t-1', task: 'projects/acme/t-1' })).toBe('Auto working directory: (root) → projects/acme/t-1 (name, task name)')
    expect(describeRoute({ action: 'route', reason: 'model', confidence: 0.8, from: '(root)', to: 'projects/acme/t-1', last: true })).toBe('Auto working directory: (root) → projects/acme/t-1 (model, 0.80, last)')
  })
})

describe('anchorRelativeMentions', () => {
  it('makes relative file and folder mentions absolute in the folder they were written in', () => {
    expect(anchorRelativeMentions('see [file:projects/acme/plan.md] and [folder:docs]', '/w/root'))
      .toBe('see [file:/w/root/projects/acme/plan.md] and [folder:/w/root/docs]')
    expect(anchorRelativeMentions('[file:/abs/a.md] [file:~/b.md] [skill:x] plain', '/w/root')).toBe('[file:/abs/a.md] [file:~/b.md] [skill:x] plain')
  })
})

describe('isPlainChatRequest', () => {
  it('is a chat opened without a folder, a task, a parent, a branch or a project', () => {
    expect(isPlainChatRequest(undefined)).toBe(true)
    expect(isPlainChatRequest({})).toBe(true)
    expect(isPlainChatRequest({ labels: ['bug'], permissionMode: 'ask', model: 'm', sessionStatus: 'todo', systemPromptPreset: 'default' })).toBe(true)
    expect(isPlainChatRequest({ workingDirectory: 'user_default' })).toBe(true)
  })

  it('is not a hidden, unattended, mini, task, subtask, branch or project session, nor one given a folder', () => {
    const others: CreateSessionOptions[] = [
      { hidden: true }, { unattended: true }, { systemPromptPreset: 'mini' },
      { taskSlug: 't' }, { taskRunId: 'r' }, { taskNodeId: 'n' }, { taskDraft: true }, { applyTaskLabel: true },
      { parentSessionId: 'p' }, { branchFromSessionId: 's' }, { branchFromMessageId: 'm' }, { projectId: 'p' },
      { workingDirectory: '/x' }, { workingDirectory: 'none' },
    ]
    for (const options of others) expect([options, isPlainChatRequest(options)]).toEqual([options, false])
  })
})

describe('resolveWorkingDirectoryOrigin', () => {
  const base = { requested: undefined, resolved: '/w/root', configuredDefault: '/w/root', boundElsewhere: false }
  it('tells the default folder from one remembered from an earlier session', () => {
    expect(resolveWorkingDirectoryOrigin(base)).toBe('default')
    expect(resolveWorkingDirectoryOrigin({ ...base, requested: 'user_default', resolved: '/w/root/' })).toBe('default')
    expect(resolveWorkingDirectoryOrigin({ ...base, resolved: '/w/root/projects/acme' })).toBe('inherited')
  })
  it('treats a named folder, no folder, a project, a parent or a branch as explicit', () => {
    expect(resolveWorkingDirectoryOrigin({ ...base, requested: '/w/root' })).toBe('explicit')
    expect(resolveWorkingDirectoryOrigin({ ...base, requested: 'none', resolved: undefined })).toBe('explicit')
    expect(resolveWorkingDirectoryOrigin({ ...base, boundElsewhere: true })).toBe('explicit')
  })
})
