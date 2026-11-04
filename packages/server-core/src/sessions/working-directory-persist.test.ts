import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager } from './SessionManager.ts'

/**
 * The write half of "remember the folder for the next session", over a real workspace
 * config.json. What a user sees:
 *   pick a folder in any chat  → it is remembered for the next new chat
 *   press Reset                → the session returns to the project folder, memory dropped
 *
 * The read half — new sessions actually starting there — is
 * `resolveNewSessionWorkingDirectory` in working-directory.test.ts. This side lives in
 * config I/O, so a temp workspace on disk is cheaper than mocking the storage layer.
 */

const tmpDirs: string[] = []

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

/** A workspace root with a config.json, a project folder, and a subfolder to pick. */
function seedWorkspace(opts?: { withProjectFolder?: boolean }) {
  const base = mkdtempSync(join(tmpdir(), 'craft-wd-'))
  tmpDirs.push(base)

  const rootPath = join(base, 'workspace')
  const projectRoot = join(base, 'project')
  const subFolder = join(projectRoot, 'inbox')
  mkdirSync(rootPath, { recursive: true })
  mkdirSync(subFolder, { recursive: true })

  writeFileSync(
    join(rootPath, 'config.json'),
    JSON.stringify({
      id: 'ws_test',
      name: 'Test',
      slug: 'test',
      defaults: opts?.withProjectFolder === false ? {} : { workingDirectory: projectRoot },
    }),
  )

  return { rootPath, projectRoot, subFolder }
}

/** Pre-seed the "remembered for new sessions" folder, as an earlier pick would have. */
function remember(rootPath: string, path: string) {
  const configPath = join(rootPath, 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf-8'))
  config.defaults.lastSessionWorkingDirectory = path
  writeFileSync(configPath, JSON.stringify(config))
}

function readDefaults(rootPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(rootPath, 'config.json'), 'utf-8')).defaults
}

/** SessionManager with one loaded session and the persistence/event seams stubbed. */
function harness(rootPath: string, workingDirectory: string) {
  const sm = new SessionManager()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const any = sm as any
  const events: Array<{ type: string; workingDirectory?: string; error?: string }> = []
  any.sendEvent = (e: { type: string }) => events.push(e)
  any.persistSession = () => {}
  any.sessions.set('s', {
    id: 's',
    messages: [],
    workingDirectory,
    workspace: { id: 'ws_test', rootPath },
  })
  return { sm, events, session: () => any.sessions.get('s') }
}

describe('updateWorkingDirectory — reset target', () => {
  it("sends '' back to the project folder, not the workspace storage folder", () => {
    const { rootPath, projectRoot, subFolder } = seedWorkspace()
    const { sm, events, session } = harness(rootPath, subFolder)

    // '' is what the renderer's Reset sends — the server owns the target.
    sm.updateWorkingDirectory('s', '')

    expect(session().workingDirectory).toBe(projectRoot)
    expect(session().workingDirectory).not.toBe(rootPath)
    expect(events.at(-1)).toMatchObject({
      type: 'working_directory_changed',
      workingDirectory: projectRoot,
    })
  })

  it('refuses the reset when the workspace has no project folder configured', () => {
    const { rootPath, subFolder } = seedWorkspace({ withProjectFolder: false })
    const { sm, events, session } = harness(rootPath, subFolder)

    sm.updateWorkingDirectory('s', '')

    // Unchanged, and told why — rather than silently moved into ~/.craft-agent/workspaces.
    expect(session().workingDirectory).toBe(subFolder)
    expect(events.at(-1)?.type).toBe('working_directory_error')
  })
})

describe('updateWorkingDirectory — remembering the folder for new sessions', () => {
  it('remembers a user-picked subfolder without touching the project folder', () => {
    const { rootPath, projectRoot, subFolder } = seedWorkspace()
    const { sm, events } = harness(rootPath, projectRoot)

    sm.updateWorkingDirectory('s', subFolder)

    const defaults = readDefaults(rootPath)
    expect(defaults.lastSessionWorkingDirectory).toBe(subFolder)
    // The workspace's own project-folder setting is the user's, not ours to rewrite.
    expect(defaults.workingDirectory).toBe(projectRoot)
    expect(events.at(-1)).toMatchObject({
      type: 'working_directory_changed',
      workingDirectory: subFolder,
    })
  })

  it('drops the memory on reset', () => {
    const { rootPath, subFolder } = seedWorkspace()
    remember(rootPath, subFolder)
    const { sm } = harness(rootPath, subFolder)

    sm.updateWorkingDirectory('s', '')

    expect('lastSessionWorkingDirectory' in readDefaults(rootPath)).toBe(false)
  })

  it('remembers nothing for callers that opt out', () => {
    const { rootPath, projectRoot, subFolder } = seedWorkspace()
    const { sm } = harness(rootPath, projectRoot)

    // Task-draft adoption reconciles a session's cwd; that must not repoint future sessions.
    sm.updateWorkingDirectory('s', subFolder, { persistAsDefault: false })

    expect('lastSessionWorkingDirectory' in readDefaults(rootPath)).toBe(false)
  })

  it('leaves the memory alone when the target fails validation', () => {
    const { rootPath, projectRoot, subFolder } = seedWorkspace()
    remember(rootPath, subFolder)
    const { sm, events } = harness(rootPath, subFolder)

    sm.updateWorkingDirectory('s', join(projectRoot, 'does-not-exist'))

    expect(events.at(-1)?.type).toBe('working_directory_error')
    expect(readDefaults(rootPath).lastSessionWorkingDirectory).toBe(subFolder)
  })
})
