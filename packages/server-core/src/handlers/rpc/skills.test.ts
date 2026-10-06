import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanSkillDirectory } from './skills'

describe('scanSkillDirectory', () => {
  it('lists links without following cycles inside a skill', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-files-'))
    try {
      mkdirSync(join(root, 'nested'))
      writeFileSync(join(root, 'nested', 'note.txt'), 'hello')
      symlinkSync(root, join(root, 'nested', 'back'), process.platform === 'win32' ? 'dir' : undefined)
      symlinkSync(root, join(root, 'nested', 'again'), process.platform === 'win32' ? 'dir' : undefined)

      const files = scanSkillDirectory(root)
      expect(files).toHaveLength(1)
      expect(files[0]).toMatchObject({
        name: 'nested',
        type: 'directory',
        children: [
          { name: 'again', type: 'file' },
          { name: 'back', type: 'file' },
          { name: 'note.txt', type: 'file', size: 5 },
        ],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports the size of the file a link points to and skips a broken link', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-files-'))
    try {
      writeFileSync(join(root, 'target.txt'), 'x'.repeat(5000))
      mkdirSync(join(root, 'skill'))
      symlinkSync(join(root, 'target.txt'), join(root, 'skill', 'linked.txt'))
      symlinkSync(join(root, 'missing.txt'), join(root, 'skill', 'broken.txt'))

      expect(scanSkillDirectory(join(root, 'skill'))).toEqual([
        { name: 'linked.txt', type: 'file', size: 5000 },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
