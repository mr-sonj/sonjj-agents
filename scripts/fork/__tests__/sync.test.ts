/**
 * Runs scripts/fork/sync.sh against throwaway repos: a bare "upstream", a bare "origin" fork holding
 * main, every branch of FEATURES and mod, and a clone of it to sync in. This checkout is not touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const script = join(import.meta.dir, '../sync.sh')
const featuresBlock = readFileSync(script, 'utf8').match(/^FEATURES=\(\n([\s\S]*?)^\)/m)
if (!featuresBlock) throw new Error('FEATURES=( ... ) not found in sync.sh')
const features = [...featuresBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])

const root = mkdtempSync(join(tmpdir(), 'fork-sync-test-'))
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}
const seed = join(root, 'seed')
const work = join(root, 'work')
const upstream = join(root, 'upstream.git')
const origin = join(root, 'origin.git')

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function sync(...args: string[]) {
  const result = Bun.spawnSync(['bash', script, ...args], { cwd: work, env })
  const output = result.stdout.toString() + result.stderr.toString()
  if (result.exitCode !== 0) throw new Error(`sync.sh ${args.join(' ')} failed:\n${output}`)
  return output
}

function commitFile(cwd: string, file: string, content: string) {
  writeFileSync(join(cwd, file), content)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', `change ${file}`)
}

beforeAll(() => {
  writeFileSync(env.GIT_CONFIG_GLOBAL, '[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n')
  git(root, 'init', '-q', '--bare', upstream)
  git(root, 'init', '-q', '--bare', origin)
  git(root, 'init', '-q', seed)
  commitFile(seed, 'README.md', 'upstream\n')
  git(seed, 'push', '-q', upstream, 'main')

  features.forEach((branch, i) => {
    git(seed, 'checkout', '-q', '-b', branch, 'main')
    commitFile(seed, `feature-${i}.txt`, `${branch}\n`)
  })
  git(seed, 'checkout', '-q', '-b', 'mod', 'main')
  for (const branch of features) git(seed, 'merge', '-q', '--no-edit', branch)
  git(seed, 'push', '-q', origin, 'main', 'mod', ...features)

  git(root, 'clone', '-q', '-b', 'mod', origin, work)
  git(work, 'remote', 'add', 'upstream', upstream)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('scripts/fork/sync.sh', () => {
  it('keeps the published mod when nothing changed, so --push force-pushes nothing', () => {
    const published = git(origin, 'rev-parse', 'mod')

    const output = sync()
    expect(git(work, 'rev-parse', 'mod')).toBe(published)
    expect(output).toContain('keeping mod')

    sync('--push')
    expect(git(work, 'rev-parse', 'mod')).toBe(published)
    expect(git(origin, 'rev-parse', 'mod')).toBe(published)
  }, 60_000)

  it('rebuilds mod when a feature branch gains a commit', () => {
    const before = git(work, 'rev-parse', 'mod')
    git(work, 'checkout', '-q', features[0])
    commitFile(work, 'feature-extra.txt', 'more\n')
    const tip = git(work, 'rev-parse', 'HEAD')
    git(work, 'checkout', '-q', 'mod')

    expect(sync()).not.toContain('keeping mod')
    const after = git(work, 'rev-parse', 'mod')
    expect(after).not.toBe(before)
    expect(git(work, 'merge-base', '--is-ancestor', tip, after)).toBe('')
  }, 60_000)

  it('rebuilds mod on top of new upstream commits', () => {
    git(seed, 'checkout', '-q', 'main')
    commitFile(seed, 'UPSTREAM.md', 'new upstream work\n')
    const upstreamTip = git(seed, 'rev-parse', 'HEAD')
    git(seed, 'push', '-q', upstream, 'main')
    const before = git(work, 'rev-parse', 'mod')

    sync()
    const after = git(work, 'rev-parse', 'mod')
    expect(after).not.toBe(before)
    expect(git(work, 'rev-parse', 'main')).toBe(upstreamTip)
    expect(git(work, 'merge-base', '--is-ancestor', upstreamTip, after)).toBe('')

    // A second run with nothing new keeps that rebuilt mod.
    const output = sync()
    expect(git(work, 'rev-parse', 'mod')).toBe(after)
    expect(output).toContain('keeping mod')
  }, 60_000)
})
