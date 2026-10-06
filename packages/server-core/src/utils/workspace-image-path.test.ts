import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { createWorkspaceAtPath } from '@craft-agent/shared/workspaces'
import { resolveWorkspaceImagePath } from './workspace-image-path'

let tempDir: string
let root: string

function writeDefaults(defaults: Record<string, unknown>): void {
  const configPath = join(root, 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf-8'))
  config.defaults = { ...config.defaults, ...defaults }
  writeFileSync(configPath, JSON.stringify(config, null, 2))
}

/** Create a file (relative to tempDir) and return its absolute path */
function touch(path: string): string {
  const file = join(tempDir, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '<svg/>')
  return file
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'workspace-image-path-'))
  root = join(tempDir, 'workspace')
  createWorkspaceAtPath(root, 'Images')
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('resolveWorkspaceImagePath', () => {
  it('reads other images from the workspace root', () => {
    const icon = touch('workspace/statuses/icons/todo.svg')
    expect(resolveWorkspaceImagePath(root, 'statuses/icons/todo.svg')).toBe(icon)
  })

  it('reads a skill icon from the default skills folder', () => {
    const icon = touch('workspace/skills/commit/icon.svg')
    expect(resolveWorkspaceImagePath(root, 'skills/commit/icon.svg')).toBe(icon)
  })

  it('reads a skill icon from a custom skills folder', () => {
    const icon = touch('elsewhere/my-skills/commit/icon.svg')
    writeDefaults({ skillsDirectory: join(tempDir, 'elsewhere/my-skills') })
    expect(resolveWorkspaceImagePath(root, 'skills/commit/icon.svg')).toBe(icon)
  })

  it('reads a skill icon from an extra skill folder', () => {
    const icon = touch('project/.claude/skill-lib/review/icon.png')
    writeDefaults({ extraSkillDirs: [join(tempDir, 'project/.claude/skill-lib')] })
    expect(resolveWorkspaceImagePath(root, 'skills/review/icon.png')).toBe(icon)
  })

  it('takes the icon of the skill that wins the slug', () => {
    const workspaceIcon = touch('workspace/skills/review/icon.svg')
    touch('extra/review/icon.svg')
    writeDefaults({ extraSkillDirs: [join(tempDir, 'extra')] })
    expect(resolveWorkspaceImagePath(root, 'skills/review/icon.svg')).toBe(workspaceIcon)
  })

  it('reads a source icon from a custom sources folder', () => {
    const icon = touch('elsewhere/my-sources/github/icon.svg')
    writeDefaults({ sourcesDirectory: join(tempDir, 'elsewhere/my-sources') })
    expect(resolveWorkspaceImagePath(root, 'sources/github/icon.svg')).toBe(icon)
  })

  it('returns null for a missing file or a path that leaves its folder', () => {
    touch('workspace/secret.svg')
    expect(resolveWorkspaceImagePath(root, 'skills/none/icon.svg')).toBeNull()
    expect(resolveWorkspaceImagePath(root, 'skills/x/../../secret.svg')).toBeNull()
  })
})
