import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession as createStoredSession, listSessions, loadSession, saveSession } from '../../../shared/src/sessions/storage.ts'
import * as cwdRouter from '../decisions/cwd-router.ts'
import * as decisionPoint from '../decisions/decision-point.ts'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// Auto working directory (workspace switch `autoWorkingDirectory`): the first message of a session
// still in the workspace's default folder may move it to the project it is about, before the agent
// exists. It needs no decision model: without one the connection's small model picks.
describe('auto working directory', () => {
  let wsRoot: string
  let projectRoot: string
  let sm: SessionManager
  let events: Array<{ type: string; [key: string]: unknown }>
  let agentCreatedIn: Array<{ workingDirectory?: string; sdkCwd?: string }>
  let configBefore: string

  function writeConfig(folders?: string[], { enabled = true }: { enabled?: boolean } = {}) {
    writeFileSync(join(wsRoot, 'config.json'), JSON.stringify({
      id: 'ws-test', name: 'Test', slug: 'test', defaults: { workingDirectory: projectRoot },
      ...(enabled ? { autoWorkingDirectory: true } : {}),
      ...(folders ? { autoWorkingDirectoryFolders: folders } : {}),
    }))
  }

  /** A throwaway agent for the small model, answering `reply`. */
  function smallModel(reply: () => Promise<string | null>, auth: { authInjected: boolean; authWarning?: string } = { authInjected: true }) {
    const agent = { postInit: mock(async () => auth), runMiniCompletion: mock((_prompt: string) => reply()), destroy: mock(() => {}) }
    const create = mock((_workspace: unknown, _options: { id: string; llmConnection?: string }) => agent)
    ;(sm as any).createUtilityAgent = create
    return { agent, create }
  }

  function write(rel: string, content: string) {
    const file = join(projectRoot, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content)
  }

  beforeEach(() => {
    wsRoot = mkdtempSync(join(tmpdir(), 'sm-auto-cwd-ws-'))
    projectRoot = mkdtempSync(join(tmpdir(), 'sm-auto-cwd-root-'))
    write('AGENTS.md', '# Root')
    write('projects/acme/AGENTS.md', '# Acme\n\nStorefront API.')
    write('projects/garden/CLAUDE.md', '# Garden\n\nPlanting calendar.')
    writeConfig(['projects/acme: storefront API', 'projects/garden: planting and watering'])
    configBefore = readFileSync(join(wsRoot, 'config.json'), 'utf-8')

    sm = new SessionManager()
    events = []
    agentCreatedIn = []
    // No decision model anywhere: the feature must run without one
    ;(sm as any).decisionFeatureActive = () => false
    spyOn(decisionPoint, 'openDecisionPoint').mockResolvedValue(null)
    ;(sm as any).startPreTurnDecisions = () => null
    // Title generation runs in the background and would write after the test's cleanup
    ;(sm as any).generateTitleUnlessSmallTalk = async () => {}
    const sendEvent = (sm as any).sendEvent.bind(sm)
    ;(sm as any).sendEvent = (event: { type: string }, workspaceId?: string) => {
      events.push(event as { type: string })
      sendEvent(event, workspaceId)
    }
    const agent = {
      getModel: () => 'claude-sonnet-4-6',
      setAllSources: () => {},
      getSessionId: () => 'sdk-session',
      chat: async function* () { yield { type: 'complete' } },
    }
    ;(sm as any).getOrCreateAgent = async (managed: { workingDirectory?: string; sdkCwd?: string }) => {
      agentCreatedIn.push({ workingDirectory: managed.workingDirectory, sdkCwd: managed.sdkCwd })
      return agent
    }
    sm.setEventSink(() => {})
  })

  afterEach(async () => {
    mock.restore()
    // Debounced session writes must land before their folder goes
    for (const id of (sm as unknown as { sessions: Map<string, unknown> }).sessions.keys()) await sm.flushSession(id)
    rmSync(wsRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  async function session(id: string, fields: Record<string, unknown> = {}) {
    const workspace = { id: 'ws-test', name: 'Test Workspace', rootPath: wsRoot, createdAt: Date.now() }
    const managed = createManagedSession(
      { id, name: 'auto cwd test', workingDirectory: projectRoot, sdkCwd: projectRoot, workingDirectoryOrigin: 'default', ...fields },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    await saveSession({ id, workspaceRootPath: wsRoot, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as any)
    return managed
  }

  it('moves the first message to the project it names, before the agent is created', async () => {
    const managed = await session('route')
    await sm.sendMessage(managed.id, 'plan the garden for spring')
    const garden = join(projectRoot, 'projects/garden')
    expect(managed.workingDirectory).toBe(garden)
    expect(managed.sdkCwd).toBe(garden)
    expect(managed.workingDirectoryOrigin).toBe('auto')
    expect(agentCreatedIn).toEqual([{ workingDirectory: garden, sdkCwd: garden }])
    expect(events.find(e => e.type === 'working_directory_changed')).toMatchObject({ sessionId: 'route', workingDirectory: garden })
    expect(events.find(e => e.type === 'info')).toMatchObject({ message: 'Auto working directory: (root) → projects/garden (name)' })
    expect(managed.messages[1]).toMatchObject({ role: 'info', content: 'Auto working directory: (root) → projects/garden (name)' })
    // Never remembered as the folder for the next sessions
    expect(readFileSync(join(wsRoot, 'config.json'), 'utf-8')).toBe(configBefore)

    // Persisted with the session, and read back from the header
    await sm.flushSession(managed.id)
    expect(loadSession(wsRoot, managed.id)).toMatchObject({ workingDirectory: garden, sdkCwd: garden, workingDirectoryOrigin: 'auto' })
    expect(listSessions(wsRoot).find(s => s.id === managed.id)?.workingDirectoryOrigin).toBe('auto')
  })

  it('keeps the folder when the router stays', async () => {
    const managed = await session('stay')
    const router = spyOn(cwdRouter, 'routeWorkingDirectory').mockResolvedValue({ action: 'stay', reason: 'model', rule: 'stay_or_unclear', from: '(root)' })
    await sm.sendMessage(managed.id, 'hi')
    expect(router).toHaveBeenCalledTimes(1)
    expect(router.mock.calls[0]![0]).toMatchObject({ root: projectRoot, workingDirectory: projectRoot, message: 'hi', sessionId: 'stay' })
    expect(managed.workingDirectory).toBe(projectRoot)
    expect(managed.workingDirectoryOrigin).toBe('default')
    expect(events.some(e => e.type === 'working_directory_changed')).toBe(false)
  })

  it('asks on the first user message only', async () => {
    const managed = await session('second')
    const router = spyOn(cwdRouter, 'routeWorkingDirectory').mockResolvedValue(null)
    await sm.sendMessage(managed.id, 'hello there')
    await sm.sendMessage(managed.id, 'now plan the garden beds')
    expect(router).toHaveBeenCalledTimes(1)
    expect(managed.workingDirectory).toBe(projectRoot)
  })

  it('also asks for a folder remembered from an earlier session', async () => {
    const acme = join(projectRoot, 'projects/acme')
    const managed = await session('inherited', { workingDirectory: acme, sdkCwd: acme, workingDirectoryOrigin: 'inherited' })
    const router = spyOn(cwdRouter, 'routeWorkingDirectory').mockResolvedValue(null)
    await sm.sendMessage(managed.id, 'continue')
    expect(router.mock.calls[0]![0]).toMatchObject({ root: projectRoot, workingDirectory: acme })
  })

  const notAsked: Array<[string, Record<string, unknown>, string?, Record<string, unknown>?]> = [
    ['the user picked the folder', { workingDirectoryOrigin: 'user' }],
    ['the caller named the folder', { workingDirectoryOrigin: 'explicit' }],
    ['the router already moved it', { workingDirectoryOrigin: 'auto' }],
    ['the session predates the field', { workingDirectoryOrigin: undefined }],
    ['the session is hidden', { hidden: true }],
    ['the message is hidden', {}, undefined, { hidden: true }],
    ['it is a task session', { taskSlug: 'ship-it' }],
    ['it is a task run child', { taskRunId: 'run-1' }],
    ['it is a subtask', { parentSessionId: 'parent' }],
    ['an automation created it', { triggeredBy: { automationName: 'nightly' } }],
    ['it is unattended', { unattended: true }],
    ['it is a branch', { branchFromMessageId: 'm1', branchFromSdkSessionId: 'sdk-parent' }],
    // Already done: a finished mini session moves itself to done, which writes after the cleanup
    ['it is a mini agent', { systemPromptPreset: 'mini', sessionStatus: 'done' }],
    ['the message is a slash command', {}, '/compact'],
  ]
  for (const [why, fields, message, options] of notAsked) {
    it(`does not ask when ${why}`, async () => {
      const managed = await session(`skip-${why.replace(/\W+/g, '-')}`, fields)
      const router = spyOn(cwdRouter, 'routeWorkingDirectory')
      await sm.sendMessage(managed.id, message ?? 'plan the garden for spring', undefined, undefined, options as never)
      expect(router).not.toHaveBeenCalled()
    })
  }

  it('does not ask when the workspace lists no folders', async () => {
    writeConfig()
    const managed = await session('no-list')
    const router = spyOn(cwdRouter, 'routeWorkingDirectory')
    await sm.sendMessage(managed.id, 'plan the garden for spring')
    expect(router).not.toHaveBeenCalled()
    expect(managed.workingDirectory).toBe(projectRoot)
  })

  it('passes the folder list to the router', async () => {
    const managed = await session('list')
    const router = spyOn(cwdRouter, 'routeWorkingDirectory').mockResolvedValue(null)
    await sm.sendMessage(managed.id, 'hello')
    expect(router.mock.calls[0]![0].folders).toEqual(['projects/acme: storefront API', 'projects/garden: planting and watering'])
  })

  it('does not ask while the workspace switch is off', async () => {
    writeConfig(['projects/acme: storefront API', 'projects/garden: planting and watering'], { enabled: false })
    const managed = await session('switch-off')
    const router = spyOn(cwdRouter, 'routeWorkingDirectory')
    await sm.sendMessage(managed.id, 'plan the garden for spring')
    expect(router).not.toHaveBeenCalled()
    expect(managed.workingDirectory).toBe(projectRoot)
  })

  it('runs the turn in the old folder when the router throws', async () => {
    const managed = await session('throws')
    spyOn(cwdRouter, 'routeWorkingDirectory').mockRejectedValue(new Error('boom'))
    await sm.sendMessage(managed.id, 'plan the garden for spring')
    expect(agentCreatedIn).toEqual([{ workingDirectory: projectRoot, sdkCwd: projectRoot }])
    expect(managed.workingDirectory).toBe(projectRoot)
  })

  it('leaves a folder the user picked while the router ran', async () => {
    const managed = await session('picked-meanwhile')
    const acme = join(projectRoot, 'projects/acme')
    spyOn(cwdRouter, 'routeWorkingDirectory').mockImplementation(async () => {
      sm.updateWorkingDirectory(managed.id, acme)
      return { action: 'route', target: join(projectRoot, 'projects/garden'), reason: 'name', from: '(root)', to: 'projects/garden' }
    })
    await sm.sendMessage(managed.id, 'plan the garden for spring')
    expect(managed.workingDirectory).toBe(acme)
    expect(managed.workingDirectoryOrigin).toBe('user')
  })

  it('asks the small model of the session\'s connection when no folder is named', async () => {
    const managed = await session('small-model', { llmConnection: 'conn-a' })
    const { agent, create } = smallModel(async () => 'projects/acme')
    await sm.sendMessage(managed.id, 'check the storefront prices')
    const acme = join(projectRoot, 'projects/acme')
    expect(create.mock.calls[0]![1]).toMatchObject({ id: 'small-model-auto-working-directory', llmConnection: 'conn-a' })
    expect(agent.runMiniCompletion.mock.calls[0]![0]).toContain('- projects/acme: storefront API')
    expect(agent.destroy).toHaveBeenCalledTimes(1)
    expect(managed.workingDirectory).toBe(acme)
    expect(agentCreatedIn).toEqual([{ workingDirectory: acme, sdkCwd: acme }])
    expect(managed.messages[1]).toMatchObject({ role: 'info', content: 'Auto working directory: (root) → projects/acme (model)' })
  })

  it('stays when the connection has no credentials for the small model', async () => {
    const managed = await session('no-credentials')
    const { agent } = smallModel(async () => 'projects/acme', { authInjected: false, authWarning: 'no key' })
    await sm.sendMessage(managed.id, 'check the storefront prices')
    expect(agent.runMiniCompletion).not.toHaveBeenCalled()
    expect(agent.destroy).toHaveBeenCalledTimes(1)
    expect(managed.workingDirectory).toBe(projectRoot)
  })

  it('keeps a folder the user picked while the small model ran', async () => {
    const managed = await session('picked-during-small-model')
    const garden = join(projectRoot, 'projects/garden')
    smallModel(async () => {
      sm.updateWorkingDirectory(managed.id, garden)
      return 'projects/acme'
    })
    await sm.sendMessage(managed.id, 'check the storefront prices')
    expect(managed.workingDirectory).toBe(garden)
    expect(managed.workingDirectoryOrigin).toBe('user')
  })

  it('destroys the small model\'s agent as soon as the router stops waiting', async () => {
    const managed = await session('abandoned')
    const { agent } = smallModel(() => new Promise<string | null>(() => {}))
    const controller = new AbortController()
    void (sm as any).askAutoWorkingDirectoryModel(managed, 'prompt', controller.signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(agent.runMiniCompletion).toHaveBeenCalledTimes(1)
    expect(agent.destroy).not.toHaveBeenCalled()
    controller.abort()
    expect(agent.destroy).toHaveBeenCalledTimes(1)
  })

  it('never moves a session that already has an agent', async () => {
    const managed = await session('has-agent')
    managed.sdkSessionId = 'sdk-1'
    const router = spyOn(cwdRouter, 'routeWorkingDirectory')
    await sm.sendMessage(managed.id, 'plan the garden for spring')
    expect(router).not.toHaveBeenCalled()
  })

  it('marks a folder picked in the chat as the user\'s', async () => {
    const managed = await session('pick')
    sm.updateWorkingDirectory(managed.id, join(projectRoot, 'projects/acme'))
    expect(managed.workingDirectoryOrigin).toBe('user')
  })

  it('stores the origin a new session starts with', async () => {
    const stored = await createStoredSession(wsRoot, { workingDirectory: projectRoot, workingDirectoryOrigin: 'default' })
    expect(loadSession(wsRoot, stored.id)?.workingDirectoryOrigin).toBe('default')
    expect(listSessions(wsRoot).find(s => s.id === stored.id)?.workingDirectoryOrigin).toBe('default')
    const legacy = await createStoredSession(wsRoot, { workingDirectory: projectRoot })
    expect(listSessions(wsRoot).find(s => s.id === legacy.id)?.workingDirectoryOrigin).toBeUndefined()
  })
})
