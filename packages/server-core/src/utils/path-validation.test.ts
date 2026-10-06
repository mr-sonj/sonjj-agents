import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Stats } from 'fs'
import {
  validatePathFormat,
  isValidWorkingDirectory,
  isValidWorkspaceRootPath,
  isValidCustomDirectory,
  isValidDirectorySetting,
  isValidExtraSkillDir,
  validateExtraSkillDirs,
  savedExtraSkillDirs,
} from './path-validation'

function directoryStats(): Stats {
  return { isDirectory: () => true } as Stats
}

function fileStats(): Stats {
  return { isDirectory: () => false } as Stats
}

describe('validatePathFormat', () => {
  it('accepts Unix absolute paths on Unix platforms', () => {
    expect(validatePathFormat('/Users/test/project', 'darwin')).toEqual({ valid: true })
  })

  it('rejects relative paths on Unix platforms', () => {
    expect(validatePathFormat('project', 'linux')).toEqual({
      valid: false,
      reason: 'Path must be absolute (start with /).',
    })
  })

  it('rejects Windows-style paths on Unix platforms', () => {
    expect(validatePathFormat('C:\\repo', 'darwin').valid).toBe(false)
    expect(validatePathFormat('\\\\server\\share', 'linux').valid).toBe(false)
    expect(validatePathFormat('C:repo', 'linux').valid).toBe(false)
  })

  it('accepts only absolute Windows paths on Windows platforms', () => {
    expect(validatePathFormat('C:\\repo', 'win32')).toEqual({ valid: true })
    expect(validatePathFormat('\\\\server\\share\\folder', 'win32')).toEqual({ valid: true })
  })

  it('rejects relative and drive-relative Windows paths on Windows platforms', () => {
    const samples = ['repo', '.\\repo', 'C:repo', '\\temp']
    for (const sample of samples) {
      expect(validatePathFormat(sample, 'win32').valid).toBe(false)
    }
  })
})

describe('isValidWorkingDirectory', () => {
  it('accepts an existing Unix directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-agent-path-validation-'))
    try {
      expect(isValidWorkingDirectory(dir, 'darwin')).toEqual({ valid: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a file path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-agent-path-validation-'))
    const file = join(dir, 'file.txt')
    writeFileSync(file, 'x')

    try {
      expect(isValidWorkingDirectory(file, 'darwin')).toEqual({
        valid: false,
        reason: `Not a directory: ${file}`,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects invalid Windows paths before filesystem checks', () => {
    expect(isValidWorkingDirectory('C:repo', 'win32').valid).toBe(false)
  })

  it('accepts absolute Windows paths when the directory exists', () => {
    const statFn = (path: string) => {
      expect(path).toBe('C:\\repo')
      return directoryStats()
    }

    expect(isValidWorkingDirectory('C:\\repo', 'win32', statFn)).toEqual({ valid: true })
  })
})

describe('isValidWorkspaceRootPath', () => {
  it('accepts an existing directory', () => {
    const statFn = (path: string) => {
      expect(path).toBe('/workspace/new-root')
      return directoryStats()
    }

    expect(isValidWorkspaceRootPath('/workspace/new-root', 'linux', statFn)).toEqual({ valid: true })
  })

  it('accepts a non-existent path when the parent directory exists', () => {
    const statFn = (path: string) => {
      if (path === '/workspace/new-root') throw new Error('missing')
      if (path === '/workspace') return directoryStats()
      throw new Error(`Unexpected path: ${path}`)
    }

    expect(isValidWorkspaceRootPath('/workspace/new-root', 'linux', statFn)).toEqual({ valid: true })
  })

  it('accepts a non-existent path when an ancestor directory exists', () => {
    const statFn = (path: string) => {
      if (path === '/workspace/nested/new-root') throw new Error('missing')
      if (path === '/workspace/nested') throw new Error('missing')
      if (path === '/workspace') return directoryStats()
      throw new Error(`Unexpected path: ${path}`)
    }

    expect(isValidWorkspaceRootPath('/workspace/nested/new-root', 'linux', statFn)).toEqual({ valid: true })
  })

  it('rejects a non-existent path when no ancestor directory exists', () => {
    const statFn = () => {
      throw new Error('missing')
    }

    expect(isValidWorkspaceRootPath('/workspace/new-root', 'linux', statFn)).toEqual({
      valid: false,
      reason: 'Parent directory not found: /',
    })
  })

  it('rejects a non-directory parent path', () => {
    const statFn = (path: string) => {
      if (path === 'C:\\workspaces\\new-root') throw new Error('missing')
      if (path === 'C:\\workspaces') return fileStats()
      throw new Error(`Unexpected path: ${path}`)
    }

    expect(isValidWorkspaceRootPath('C:\\workspaces\\new-root', 'win32', statFn)).toEqual({
      valid: false,
      reason: 'Parent path is not a directory: C:\\workspaces',
    })
  })
})

describe('isValidCustomDirectory', () => {
  function withDirs(run: (dirs: { base: string; workspace: string; outside: string }) => void) {
    const base = mkdtempSync(join(tmpdir(), 'custom-dir-validation-'))
    const workspace = join(base, 'workspace')
    const outside = join(base, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    try {
      run({ base, workspace, outside })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }

  it('accepts an existing directory outside the workspace', () => {
    withDirs(({ workspace, outside }) => {
      expect(isValidCustomDirectory(outside, workspace)).toEqual({ valid: true })
    })
  })

  it('accepts an existing directory inside the workspace', () => {
    withDirs(({ workspace }) => {
      const inside = join(workspace, 'data', 'skills')
      mkdirSync(inside, { recursive: true })
      expect(isValidCustomDirectory(inside, workspace)).toEqual({ valid: true })
    })
  })

  it('rejects a relative or missing path', () => {
    withDirs(({ workspace, base }) => {
      expect(isValidCustomDirectory('skills', workspace).valid).toBe(false)
      expect(isValidCustomDirectory(join(base, 'missing'), workspace).valid).toBe(false)
    })
  })

  it('rejects the workspace folder itself, also through a symlink', () => {
    withDirs(({ workspace, base }) => {
      const alias = join(base, 'alias')
      symlinkSync(workspace, alias, process.platform === 'win32' ? 'dir' : undefined)
      expect(isValidCustomDirectory(workspace, workspace)).toEqual({
        valid: false,
        reason: 'Cannot be the workspace folder itself.',
      })
      expect(isValidCustomDirectory(alias, workspace).valid).toBe(false)
    })
  })

  it('rejects a folder that contains the workspace', () => {
    withDirs(({ workspace, base }) => {
      const expected = { valid: false, reason: 'Cannot be a parent of the workspace folder.' }
      expect(isValidCustomDirectory(base, workspace)).toEqual(expected)
      expect(isValidCustomDirectory('/', workspace)).toEqual(expected)
    })
  })

  it('rejects the folder already used by the other setting', () => {
    withDirs(({ workspace, outside }) => {
      expect(isValidCustomDirectory(outside, workspace, outside)).toEqual({
        valid: false,
        reason: 'Skills and sources directories cannot overlap.',
      })
    })
  })

  it('rejects nested skills and sources folders in either direction', () => {
    withDirs(({ workspace, outside }) => {
      const nested = join(outside, 'nested')
      mkdirSync(nested)
      expect(isValidCustomDirectory(nested, workspace, outside).valid).toBe(false)
      expect(isValidCustomDirectory(outside, workspace, nested).valid).toBe(false)
    })
  })
})

describe('isValidDirectorySetting', () => {
  it('rejects going back to the default folder when the other setting uses it', () => {
    const base = mkdtempSync(join(tmpdir(), 'directory-setting-'))
    try {
      const workspace = join(base, 'workspace')
      const defaultSkills = join(workspace, 'skills')
      mkdirSync(defaultSkills, { recursive: true })

      // sourcesDirectory was set to {workspace}/skills while skills used a custom folder
      expect(isValidDirectorySetting(undefined, defaultSkills, workspace, defaultSkills)).toEqual({
        valid: false,
        reason: 'Skills and sources directories cannot overlap.',
      })
      expect(isValidDirectorySetting(undefined, defaultSkills, workspace, join(workspace, 'sources'))).toEqual({ valid: true })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('checks a custom folder like isValidCustomDirectory', () => {
    const base = mkdtempSync(join(tmpdir(), 'directory-setting-'))
    try {
      const workspace = join(base, 'workspace')
      mkdirSync(workspace)
      expect(isValidDirectorySetting(workspace, join(workspace, 'skills'), workspace, join(workspace, 'sources'))).toEqual({
        valid: false,
        reason: 'Cannot be the workspace folder itself.',
      })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('isValidExtraSkillDir', () => {
  it('accepts an existing folder; a relative entry starts at the workspace root', () => {
    const base = mkdtempSync(join(tmpdir(), 'extra-skill-dir-'))
    try {
      const workspace = join(base, 'workspace')
      mkdirSync(join(base, 'repos'))
      mkdirSync(join(workspace, 'local'), { recursive: true })

      expect(isValidExtraSkillDir(join(base, 'repos'), workspace)).toEqual({ valid: true })
      expect(isValidExtraSkillDir('local', workspace)).toEqual({ valid: true })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('rejects a missing folder, naming where it looked', () => {
    const base = mkdtempSync(join(tmpdir(), 'extra-skill-dir-'))
    try {
      expect(isValidExtraSkillDir('missing', base)).toEqual({
        valid: false,
        reason: `Directory not found: ${join(base, 'missing')}`,
      })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('takes * as part of a folder name', () => {
    const base = mkdtempSync(join(tmpdir(), 'extra-skill-dir-'))
    try {
      mkdirSync(join(base, 'repos', 'one', 'skills'), { recursive: true })
      const entry = join(base, 'repos', '*', 'skills')
      expect(isValidExtraSkillDir(entry, base)).toEqual({ valid: false, reason: `Directory not found: ${entry}` })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('rejects a file', () => {
    const base = mkdtempSync(join(tmpdir(), 'extra-skill-dir-'))
    try {
      const file = join(base, 'notes.txt')
      writeFileSync(file, '')
      expect(isValidExtraSkillDir(file, base)).toEqual({ valid: false, reason: `Not a directory: ${file}` })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('savedExtraSkillDirs', () => {
  it('keeps the path entries of a hand-edited list as written', () => {
    expect(savedExtraSkillDirs([' ~/a ', 1, null, { dir: 'b' }, 'c'])).toEqual([' ~/a ', 'c'])
  })

  it('reads anything but a list as no folders', () => {
    expect(savedExtraSkillDirs(undefined)).toEqual([])
    expect(savedExtraSkillDirs('~/skills')).toEqual([])
  })
})

describe('validateExtraSkillDirs', () => {
  it('trims entries and drops blanks and repeats', () => {
    const base = mkdtempSync(join(tmpdir(), 'extra-skill-dirs-'))
    try {
      const a = join(base, 'a')
      mkdirSync(a)
      expect(validateExtraSkillDirs([` ${a} `, '', a, '  '], base)).toEqual({ valid: true, dirs: [a] })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('returns no list when nothing is left', () => {
    expect(validateExtraSkillDirs([' '], '/tmp')).toEqual({ valid: true, dirs: undefined })
    expect(validateExtraSkillDirs(undefined, '/tmp')).toEqual({ valid: true, dirs: undefined })
  })

  it('rejects a value that is not a list of strings', () => {
    expect(validateExtraSkillDirs('/tmp', '/tmp').valid).toBe(false)
    expect(validateExtraSkillDirs([42], '/tmp').valid).toBe(false)
  })

  it('checks new entries but keeps saved ones whose folder is gone', () => {
    const base = mkdtempSync(join(tmpdir(), 'extra-skill-dirs-'))
    try {
      const gone = join(base, 'gone')
      const missing = join(base, 'missing')
      expect(validateExtraSkillDirs([gone], base, [gone])).toEqual({ valid: true, dirs: [gone] })
      expect(validateExtraSkillDirs([gone, missing], base, [gone])).toEqual({
        valid: false,
        reason: `Directory not found: ${missing}`,
      })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
