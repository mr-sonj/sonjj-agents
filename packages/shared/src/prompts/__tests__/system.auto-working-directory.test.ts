import { describe, expect, it, mock } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// As in system.test.ts: preferences are unrelated to what is checked here
mock.module('../../config/preferences.ts', () => ({
  getCoAuthorPreference: () => true,
  formatPreferencesForPrompt: () => '',
}))

import { getMiniAgentSystemPrompt, getSystemPrompt } from '../system'
import { DOC_REFS } from '../../docs/index.ts'

// Auto working directory: an agent in any session must find the guide and the workspace config,
// so "add this folder to the auto folder list" works without the Settings edit button.
describe('system prompt: auto working directory', () => {
  const prompt = getSystemPrompt(undefined, undefined, '/tmp/workspace', '/tmp/workspace')

  it('lists the guide in the configuration docs', () => {
    expect(DOC_REFS.autoWorkingDirectory).toBe('~/.craft-agent/docs/auto-working-directory.md')
    expect(prompt).toContain(`| Auto Working Directory | \`${DOC_REFS.autoWorkingDirectory}\` | BEFORE changing the folders a session's first message may move to, or turning that on or off |`)
  })

  it('gives the workspace config path', () => {
    expect(prompt).toContain('- Workspace settings: `/tmp/workspace/config.json`')
  })

  it('points Coding mode agents at the guide too', () => {
    const coding = getSystemPrompt(undefined, undefined, '/tmp/workspace', '/tmp/workspace', undefined, undefined, true, undefined, 'coding')
    expect(coding).toContain(`Workspace settings are in \`/tmp/workspace/config.json\`; read \`${DOC_REFS.autoWorkingDirectory}\``)
  })

  it('points the mini agent (Settings edit buttons) at the guide too', () => {
    const mini = getMiniAgentSystemPrompt('/tmp/workspace')
    expect(mini).toContain(`folder list in the workspace \`config.json\`, read \`${DOC_REFS.autoWorkingDirectory}\``)
  })

  it('ships the guide with both keys and the line format', () => {
    const guide = join(import.meta.dir, '../../../../../apps/electron/resources/docs/auto-working-directory.md')
    expect(existsSync(guide)).toBe(true)
    const text = readFileSync(guide, 'utf-8')
    for (const needle of ['`autoWorkingDirectory`', '`autoWorkingDirectoryFolders`', '`defaults.workingDirectory`', '<folder path relative to the root>: <when to pick this folder>']) {
      expect(text).toContain(needle)
    }
  })
})
