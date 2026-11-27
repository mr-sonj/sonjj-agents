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
  classifyPaths,
  collectMessagePaths,
  describeContextFile,
  describeFolder,
  describeRoute,
  findNamedCandidates,
  normalizeFolderListLines,
  parseFolderList,
  resolveWorkingDirectoryOrigin,
  routeWorkingDirectory,
  type CwdRouterDeps,
} from './cwd-router'

type Answers = Record<string, unknown>

/** A decision client whose model answers `answers` (or what `answer(body)` returns), keeping each request body. */
function jev(answer: Answers | ((body: { state: Record<string, unknown>; questions: Record<string, { criteria?: Record<string, unknown> }> }) => Answers)) {
  const bodies: Array<{ state: Record<string, unknown>; questions: Record<string, { type: string; criteria?: Record<string, unknown> }> }> = []
  const resolveClient = async (): Promise<DecisionClientResolution> => {
    const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'openrouter', features: { autoWorkingDirectory: true } })
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
const noul = (value: number) => ({ type: 'noul', noul: value })
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
  const route = (message: string, from = '', extra: Partial<CwdRouterDeps> = {}, attachments?: { path?: string; name: string; type?: string }[], folders = FOLDERS) =>
    routeWorkingDirectory({ root, workingDirectory: at(from), message, attachments, sessionId: 's1', folders }, deps(extra))
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

    it('stays for a path in the current folder, routes for a path in another, ignores paths that disagree', () => {
      const W = at('projects/acme')
      expect(classifyPaths([at('projects/acme/src/x.ts')], W, candidates())).toEqual({ kind: 'here' })
      expect(classifyPaths([at('projects/garden/x')], W, candidates())).toMatchObject({ kind: 'target', candidate: { key: 'projects/garden' } })
      expect(classifyPaths([at('content/drafts/x')], at(''), candidates())).toMatchObject({ kind: 'target', candidate: { key: 'content/drafts' } })
      expect(classifyPaths([at('projects/garden/x'), at('content/x')], W, candidates())).toBeNull()
      expect(classifyPaths([at('projects/garden/x'), at('projects/acme/y')], W, candidates())).toBeNull()
      expect(classifyPaths(['/somewhere/else'], W, candidates())).toBeNull()
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

    it('routes on a path without asking the model', async () => {
      const model = jev({ target: pick('stay', 0.9) })
      expect(await route(`fix ${at('projects/garden/plan.md')}`, '', { resolveClient: model.resolveClient })).toMatchObject({ action: 'route', reason: 'path', target: at('projects/garden'), from: '(root)', to: 'projects/garden' })
      expect(await route('fix it', 'projects/acme', { resolveClient: model.resolveClient }, [{ path: at('projects/garden/a.png'), name: 'a.png' }])).toMatchObject({ action: 'route', reason: 'path', to: 'projects/garden' })
      expect(await route(`fix ${at('projects/acme/src/x.ts')}`, 'projects/acme', { resolveClient: model.resolveClient })).toMatchObject({ action: 'stay', reason: 'path', rule: 'here' })
      expect(model.bodies).toHaveLength(0)
    })

    it('routes from the root on the one folder named, without asking the model', async () => {
      const model = jev({ target: pick('stay', 0.9) })
      expect(await route('plan the garden for spring', '', { resolveClient: model.resolveClient })).toMatchObject({ action: 'route', reason: 'name', to: 'projects/garden' })
      expect(model.bodies).toHaveLength(0)
    })

    it('only knows listed folders: a path elsewhere keeps the session put, other names are no signal', async () => {
      const model = jev({ target: pick('stay', 0.9) })
      // A path in the current folder outside every listed one
      expect(await route(`look at ${at('projects/notes/todo.md')}`, '', { resolveClient: model.resolveClient })).toMatchObject({ action: 'stay', reason: 'path', rule: 'here' })
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
    it('sends relative paths only, the clipped message and attachment names; asks belongs_here only away from the root', async () => {
      const model = jev(body => ({ ...(body.questions.belongs_here ? { belongs_here: noul(0.9) } : {}), target: pick('stay', 0.9) }))
      await route(`${'x'.repeat(MESSAGE_MAX_CHARS + 10)}`, '', { resolveClient: model.resolveClient }, [{ name: 'shot.png', type: 'image' }])
      await route('continue', 'projects/acme/tasks/rework', { resolveClient: model.resolveClient })
      const [fromRoot, fromTask] = model.bodies
      expect(fromRoot!.questions.belongs_here).toBeUndefined()
      expect((fromRoot!.state.message as string).length).toBe(MESSAGE_MAX_CHARS + 1)
      expect(fromRoot!.state.attachments).toEqual(['shot.png (image)'])
      expect(fromRoot!.state.current).toEqual({ path: '(root)', description: 'Workspace — Everything lives here.' })
      expect(fromTask!.questions.belongs_here?.type).toBe('noul')
      expect(fromTask!.state.current).toEqual({ path: 'projects/acme/tasks/rework', description: 'Rework pricing — Move the pricing endpoint to v2.' })
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

    it('stays when the message belongs where the session is (a name does not override it)', async () => {
      const answers = { belongs_here: noul(0.5), target: pick('projects/garden', 0.95) }
      expect(await route('check the garden notes', 'projects/acme', { resolveClient: jev(answers).resolveClient })).toMatchObject({ action: 'stay', rule: 'belongs_here' })
    })

    it('moves sideways only on a name and 0.85', async () => {
      const lateral = (confidence: number) => jev({ belongs_here: noul(0.1), target: pick('projects/garden', confidence) }).resolveClient
      expect(await route('look at the garden watering table', 'projects/acme/tasks/rework', { resolveClient: lateral(0.9) })).toMatchObject({ action: 'route', reason: 'name', to: 'projects/garden', from: 'projects/acme/tasks/rework', confidence: 0.9 })
      expect(await route('look at the garden watering table', 'projects/acme/tasks/rework', { resolveClient: lateral(0.8) })).toMatchObject({ action: 'stay', rule: 'below_threshold' })
      expect(await route('look at the watering table', 'projects/acme/tasks/rework', { resolveClient: lateral(0.97) })).toMatchObject({ action: 'stay', rule: 'no_hard_signal' })
    })

    it('never moves within a branch: task to its project, project to its child, task to a sibling', async () => {
      // A task folder and its project (a path to the project's AGENTS.md)
      expect(await route(`edit ${at('projects/acme/AGENTS.md')}`, 'projects/acme/tasks/rework')).toMatchObject({ action: 'stay', reason: 'path', rule: 'same_branch', to: 'projects/acme' })
      // A project and a folder inside it
      const child = jev({ belongs_here: noul(0.1), target: pick('content/drafts', 0.95) }).resolveClient
      expect(await route('move it to drafts', 'content', { resolveClient: child })).toMatchObject({ action: 'stay', rule: 'same_branch' })
      // A task below a project and another listed folder inside that project
      mkdirSync(join(root, 'content/post-a'), { recursive: true })
      expect(await route('move it to drafts', 'content/post-a', { resolveClient: child })).toMatchObject({ action: 'stay', rule: 'same_branch' })
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

  it('builds the request with the reserved options last', () => {
    const request = buildCwdRouterRequest({ message: 'm', current: { path: '(root)', description: '' }, options: [{ key: 'a/b', path: '/r/a/b', description: '' }], askBelongsHere: false })
    expect(request.questions.target).toMatchObject({ type: 'choice', criteria: { 'a/b': null, stay: expect.any(String), unclear: 'Cannot tell' } })
  })

  it('describes a route in one line', () => {
    expect(describeRoute({ action: 'route', reason: 'model', confidence: 0.912, from: '(root)', to: 'projects/acme' })).toBe('Auto working directory: (root) → projects/acme (model, 0.91)')
    expect(describeRoute({ action: 'route', reason: 'path', from: 'a', to: 'b' })).toBe('Auto working directory: a → b (path)')
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
