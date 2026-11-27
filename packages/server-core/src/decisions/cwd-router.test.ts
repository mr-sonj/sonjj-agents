import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
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
  discoverCandidates,
  findNamedCandidates,
  invalidateCwdCandidateCache,
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
  const route = (message: string, from = '', extra: Partial<CwdRouterDeps> = {}, attachments?: { path?: string; name: string; type?: string }[]) =>
    routeWorkingDirectory({ root, workingDirectory: at(from), message, attachments, sessionId: 's1' }, deps(extra))

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cwd-router-'))
    outside = mkdtempSync(join(tmpdir(), 'cwd-router-outside-'))
    outcomes = []
    logs = []
    invalidateCwdCandidateCache()
    write('AGENTS.md', '# Workspace\n\nEverything lives here.')
    write('projects/acme/AGENTS.md', '---\nproject_role: "Acme storefront API: pricing, endpoints"\ndescription: ignored\n---\n# Acme\n')
    write('projects/acme/tasks/rework/AGENTS.md', '# Rework pricing\n\nMove the pricing endpoint to v2.')
    write('projects/garden/CLAUDE.md', '# Garden plans\n\nPlanting calendar, watering and\nseed orders.\n')
    write('projects/notes/readme.md', 'no context file here')
    write('content/AGENTS.md', '---\ntitle: Content studio\n---\n')
    write('content/drafts/AGENTS.md', '---\ndescription: >\n  Draft articles\n  waiting for review\n---\n')
    write('_archive/old/AGENTS.md', '# Old')
    write('.hidden/secret/AGENTS.md', '# Hidden')
    write('node_modules/pkg/AGENTS.md', '# Package')
    write('dist/AGENTS.md', '# Build output')
    write('deep/a/b/AGENTS.md', '# Too deep')
    writeFileSync(join(outside, 'AGENTS.md'), '# Outside')
    symlinkSync(outside, join(root, 'link-out'))
    symlinkSync(join(root, 'projects', 'garden'), join(root, 'link-in'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  describe('discovery', () => {
    it('lists folders with a context file up to two levels down, skipping hidden, archived, build and outside folders', () => {
      expect(discoverCandidates(root).map(c => c.key)).toEqual(['content', 'content/drafts', 'projects/acme', 'projects/garden'])
    })

    it('goes as deep as asked', () => {
      expect(discoverCandidates(root, { maxDepth: 3 }).map(c => c.key)).toContain('deep/a/b')
      // A symlink inside the root counts when the folder it points to is not listed itself
      expect(discoverCandidates(root, { maxDepth: 1 }).map(c => c.key)).toEqual(['content', 'link-in'])
    })

    it('describes a folder by project_role, description or title, else its H1 and first paragraph', () => {
      const byKey = Object.fromEntries(discoverCandidates(root).map(c => [c.key, c.description]))
      expect(byKey['projects/acme']).toBe('Acme storefront API: pricing, endpoints')
      expect(byKey['content']).toBe('Content studio')
      expect(byKey['content/drafts']).toBe('Draft articles waiting for review')
      expect(byKey['projects/garden']).toBe('Garden plans — Planting calendar, watering and seed orders.')
      expect(describeContextFile(`# T\n\n${'word '.repeat(100)}`).length).toBeLessThanOrEqual(200)
      expect(describeContextFile('No heading, just text\nover two lines.\n\nSecond paragraph.')).toBe('No heading, just text over two lines.')
    })

    it('describes the working directory from the nearest context file above it', () => {
      mkdirSync(join(root, 'projects/acme/tasks/rework/notes'), { recursive: true })
      mkdirSync(join(root, 'projects/notes/deeper'), { recursive: true })
      expect(describeFolder(at('projects/acme/tasks/rework/notes'), root)).toBe('Rework pricing — Move the pricing endpoint to v2.')
      expect(describeFolder(at('projects/notes/deeper'), root)).toBe('Workspace — Everything lives here.')
    })

    it('caches per root until a context file changes', () => {
      const first = discoverCandidates(root)
      expect(discoverCandidates(root)).toBe(first)
      write('projects/garden/CLAUDE.md', '# Garden\n\nNow about compost.')
      utimesSync(join(root, 'projects/garden/CLAUDE.md'), new Date(), new Date(Date.now() + 5_000))
      const second = discoverCandidates(root)
      expect(second).not.toBe(first)
      expect(second.find(c => c.key === 'projects/garden')?.description).toBe('Garden — Now about compost.')
    })

    it('does not run with more than the candidate limit', async () => {
      for (let i = 0; i <= MAX_CANDIDATES; i++) write(`many/p${String(i).padStart(3, '0')}/AGENTS.md`, '# P')
      const model = jev({ target: pick('stay', 0.9) })
      expect(await route('anything', '', { resolveClient: model.resolveClient })).toBeNull()
      expect(model.bodies).toHaveLength(0)
      expect(logs.some(line => line.includes('candidate folders'))).toBe(true)
    })
  })

  describe('hard signals', () => {
    const candidates = () => discoverCandidates(root)

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
      invalidateCwdCandidateCache()
      const keys = (message: string) => findNamedCandidates(message, discoverCandidates(root)).map(c => c.key)
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
      write('projects/acme/tasks/AGENTS.md', '# Tasks')  // depth 3: not a candidate
      write('content/drafts/AGENTS.md', '# Drafts')
      invalidateCwdCandidateCache()
      // A task folder and its project (a path to the project's AGENTS.md)
      expect(await route(`edit ${at('projects/acme/AGENTS.md')}`, 'projects/acme/tasks/rework')).toMatchObject({ action: 'stay', reason: 'path', rule: 'same_branch', to: 'projects/acme' })
      // A project and a folder inside it
      const child = jev({ belongs_here: noul(0.1), target: pick('content/drafts', 0.95) }).resolveClient
      expect(await route('move it to drafts', 'content', { resolveClient: child })).toMatchObject({ action: 'stay', rule: 'same_branch' })
      // A task below a project and another candidate inside that project
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

    it('does not run outside the root or without candidates', async () => {
      expect(await routeWorkingDirectory({ root, workingDirectory: outside, message: 'x' }, deps())).toBeNull()
      const empty = mkdtempSync(join(tmpdir(), 'cwd-router-empty-'))
      try {
        expect(await routeWorkingDirectory({ root: empty, workingDirectory: empty, message: 'x' }, deps())).toBeNull()
      } finally {
        rmSync(empty, { recursive: true, force: true })
      }
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
