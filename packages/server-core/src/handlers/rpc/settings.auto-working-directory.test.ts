import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sharedConfig from '@craft-agent/shared/config'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RpcServer } from '../../transport/types'
import { registerSettingsHandlers } from './settings'

// The auto working directory switch (`autoWorkingDirectory`) and folder list
// (`autoWorkingDirectoryFolders`) through the workspace settings RPC: the list saved as typed,
// read back with the lines that name no usable folder.
describe('workspace settings: auto working directory folders', () => {
  let wsRoot: string
  let projectRoot: string
  let handlers: Map<string, HandlerFn>
  const ctx = {} as never

  const config = () => JSON.parse(readFileSync(join(wsRoot, 'config.json'), 'utf-8'))
  const update = (value: unknown, key = 'autoWorkingDirectoryFolders') => handlers.get(RPC_CHANNELS.workspace.SETTINGS_UPDATE)!(ctx, 'ws', key, value)
  const get = () => handlers.get(RPC_CHANNELS.workspace.SETTINGS_GET)!(ctx, 'ws') as Promise<Record<string, unknown>>

  beforeEach(() => {
    wsRoot = mkdtempSync(join(tmpdir(), 'settings-auto-cwd-ws-'))
    projectRoot = mkdtempSync(join(tmpdir(), 'settings-auto-cwd-root-'))
    mkdirSync(join(projectRoot, 'projects/acme'), { recursive: true })
    writeFileSync(join(wsRoot, 'config.json'), JSON.stringify({ id: 'ws', name: 'WS', slug: 'ws', defaults: { workingDirectory: projectRoot }, createdAt: 1, updatedAt: 1 }))
    spyOn(sharedConfig, 'getWorkspaceByNameOrId').mockReturnValue({ id: 'ws', name: 'WS', rootPath: wsRoot, createdAt: 1 } as never)
    handlers = new Map()
    const server: RpcServer = {
      handle(channel, handler) { handlers.set(channel, handler) },
      push() {},
      async invokeClient() { return undefined },
      hasClientCapability() { return false },
      findClientsWithCapability() { return [] },
    }
    registerSettingsHandlers(server, { platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } } } as never)
  })

  afterEach(() => {
    mock.restore()
    rmSync(wsRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('saves the lines as typed and reads them back with the lines naming no folder', async () => {
    await update(['# projects', 'projects/acme: storefront API  ', 'missing: not there', '', ''])
    expect(config().autoWorkingDirectoryFolders).toEqual(['# projects', 'projects/acme: storefront API', 'missing: not there'])
    expect(config().defaults).toEqual({ workingDirectory: projectRoot })
    const settings = await get()
    expect(settings.autoWorkingDirectoryFolders).toEqual(['# projects', 'projects/acme: storefront API', 'missing: not there'])
    expect(settings.autoWorkingDirectoryIssues).toEqual([{ line: 3, path: 'missing', kind: 'missing' }])
  })

  it('takes the text of the box as well, and removes the field when it is emptied', async () => {
    await update('projects/acme: storefront API\r\nprojects/acme: again\n')
    expect(config().autoWorkingDirectoryFolders).toEqual(['projects/acme: storefront API', 'projects/acme: again'])
    expect((await get()).autoWorkingDirectoryIssues).toEqual([{ line: 2, path: 'projects/acme', kind: 'duplicate' }])
    await update('')
    expect('autoWorkingDirectoryFolders' in config()).toBe(false)
    expect(await get()).toMatchObject({ autoWorkingDirectoryFolders: [], autoWorkingDirectoryIssues: [] })
  })

  it('rejects a value that is not lines', async () => {
    await expect(update({ folders: 1 })).rejects.toThrow()
    expect('autoWorkingDirectoryFolders' in config()).toBe(false)
  })

  it('still loads the page when the list was edited by hand into another shape', async () => {
    const write = (folders: unknown) => writeFileSync(join(wsRoot, 'config.json'), JSON.stringify({ ...config(), autoWorkingDirectoryFolders: folders }))
    write('projects/acme: storefront API\nmissing: x')
    expect(await get()).toMatchObject({
      name: 'WS',
      autoWorkingDirectoryFolders: ['projects/acme: storefront API', 'missing: x'],
      autoWorkingDirectoryIssues: [{ line: 2, path: 'missing', kind: 'missing' }],
    })
    write(['projects/acme: storefront API', { path: 'projects/acme' }])
    expect(await get()).toMatchObject({
      autoWorkingDirectoryFolders: ['projects/acme: storefront API', '{"path":"projects/acme"}'],
      autoWorkingDirectoryIssues: [{ line: 2, path: '{"path"', kind: 'missing' }],
    })
  })

  it('saves the switch as true and removes it when turned off', async () => {
    expect((await get()).autoWorkingDirectory).toBe(false)
    await update(true, 'autoWorkingDirectory')
    expect(config().autoWorkingDirectory).toBe(true)
    expect((await get()).autoWorkingDirectory).toBe(true)
    await update(false, 'autoWorkingDirectory')
    expect('autoWorkingDirectory' in config()).toBe(false)
    expect((await get()).autoWorkingDirectory).toBe(false)
  })

  it('rejects a switch value that is not a boolean, and reads only true as on', async () => {
    await expect(update('true', 'autoWorkingDirectory')).rejects.toThrow()
    expect('autoWorkingDirectory' in config()).toBe(false)
    // Written by hand (or by an agent) as a string: not on
    writeFileSync(join(wsRoot, 'config.json'), JSON.stringify({ ...config(), autoWorkingDirectory: 'true' }))
    expect((await get()).autoWorkingDirectory).toBe(false)
  })
})
