import { describe, expect, test } from 'bun:test'
import type { UserConfig } from 'vite'
import config from './vite.config'

describe('renderer dependency resolution', () => {
  test('deduplicates context-bearing Radix menu packages', () => {
    const dedupe = (config as UserConfig).resolve?.dedupe

    expect(dedupe).toEqual(expect.arrayContaining([
      '@radix-ui/react-context-menu',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-menu',
    ]))
  })
})
