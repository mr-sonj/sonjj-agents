import { describe, expect, it } from 'bun:test'
import {
  normalizeDirPath,
  resolveNewSessionWorkingDirectory,
  resolveWorkingDirectoryUpdate,
} from './working-directory'

const PROJECT = '/Users/alice/code/project'
const INBOX = `${PROJECT}/inbox`
const anything = () => true
const nothing = () => false

describe('normalizeDirPath', () => {
  it('drops trailing separators and surrounding whitespace', () => {
    expect(normalizeDirPath(`  ${PROJECT}//  `)).toBe(PROJECT)
    expect(normalizeDirPath('C:\\code\\project\\')).toBe('C:\\code\\project')
  })

  it('treats blank input as absent so callers can use ?? chains', () => {
    expect(normalizeDirPath('')).toBeUndefined()
    expect(normalizeDirPath('   ')).toBeUndefined()
    expect(normalizeDirPath(undefined)).toBeUndefined()
  })

  it('preserves filesystem roots, which are all separator', () => {
    expect(normalizeDirPath('/')).toBe('/')
    expect(normalizeDirPath('\\')).toBe('\\')
  })
})

describe('resolveWorkingDirectoryUpdate', () => {
  it('uses the requested folder when one is given', () => {
    expect(resolveWorkingDirectoryUpdate(INBOX, PROJECT)).toBe(INBOX)
  })

  // The renderer sends '' for a reset so the server picks the target — a remote server
  // must resolve its own project folder, not a path off the client's machine.
  it('resolves an empty request to the workspace project folder', () => {
    expect(resolveWorkingDirectoryUpdate('', PROJECT)).toBe(PROJECT)
    expect(resolveWorkingDirectoryUpdate(undefined, PROJECT)).toBe(PROJECT)
    expect(resolveWorkingDirectoryUpdate('   ', PROJECT)).toBe(PROJECT)
  })

  // The whole point of the change: no project folder means no target, and the caller
  // reports that. Falling back to the workspace rootPath is what sent sessions into
  // ~/.craft-agent/workspaces/<slug> in the first place.
  it('returns undefined for a reset when no project folder is configured', () => {
    expect(resolveWorkingDirectoryUpdate('', undefined)).toBeUndefined()
    expect(resolveWorkingDirectoryUpdate('', '  ')).toBeUndefined()
  })

  it('normalises both sides so the session and the picker agree on the path', () => {
    expect(resolveWorkingDirectoryUpdate(`${INBOX}/`, PROJECT)).toBe(INBOX)
    expect(resolveWorkingDirectoryUpdate('', `${PROJECT}/`)).toBe(PROJECT)
  })
})

describe('resolveNewSessionWorkingDirectory', () => {
  it('prefers the folder remembered from an earlier pick', () => {
    expect(resolveNewSessionWorkingDirectory(
      { lastSessionWorkingDirectory: INBOX, workingDirectory: PROJECT },
      anything,
    )).toBe(INBOX)
  })

  it('falls back to the project folder once the memory is cleared', () => {
    expect(resolveNewSessionWorkingDirectory({ workingDirectory: PROJECT }, anything)).toBe(PROJECT)
  })

  it('ignores a blank memory rather than treating it as a choice', () => {
    expect(resolveNewSessionWorkingDirectory(
      { lastSessionWorkingDirectory: '   ', workingDirectory: PROJECT },
      anything,
    )).toBe(PROJECT)
  })

  // Stored absolute, so a workspace opened on another machine — or after the folder was
  // moved — would otherwise start every new session in a directory that isn't there.
  it('ignores a remembered folder that no longer exists', () => {
    expect(resolveNewSessionWorkingDirectory(
      { lastSessionWorkingDirectory: INBOX, workingDirectory: PROJECT },
      nothing,
    )).toBe(PROJECT)
  })

  it('returns undefined when the workspace configures neither', () => {
    expect(resolveNewSessionWorkingDirectory({}, anything)).toBeUndefined()
    expect(resolveNewSessionWorkingDirectory(undefined, anything)).toBeUndefined()
  })

  it('strips trailing separators so the session and the picker agree on the path', () => {
    expect(resolveNewSessionWorkingDirectory({ lastSessionWorkingDirectory: `${INBOX}/` }, anything))
      .toBe(INBOX)
  })
})
