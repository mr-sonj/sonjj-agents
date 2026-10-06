/**
 * Tests for ConfigWatcher with custom skills directories and symlinked skills.
 *
 * Uses real fs.watch, so the live-reload cases poll for the expected callback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigWatcher } from '../watcher.ts';
import { createWorkspaceAtPath, loadWorkspaceConfig, saveWorkspaceConfig } from '../../workspaces/storage.ts';
import { loadAllSkills } from '../../skills/storage.ts';
import type { LoadedSkill } from '../../skills/types.ts';

let tempDir: string;
let root: string;
let watcher: ConfigWatcher | null;
let listEvents: string[][];
let skillEvents: Array<{ slug: string; name: string | null }>;
let sourceEvents: string[];
let validationEvents: string[];

function writeSkill(dir: string, slug: string, name: string = slug): void {
  mkdirSync(join(dir, slug), { recursive: true });
  writeFileSync(join(dir, slug, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill\n---\n\nBody\n`);
}

function setDefaults(defaults: { skillsDirectory?: string; sourcesDirectory?: string }): void {
  const config = loadWorkspaceConfig(root)!;
  saveWorkspaceConfig(root, { ...config, defaults: { ...config.defaults, ...defaults } });
}

function setSkillsDirectory(dir: string): void {
  setDefaults({ skillsDirectory: dir });
}

const linkType = process.platform === 'win32' ? 'dir' : undefined;

function workspaceSlugs(skills: LoadedSkill[]): string[] {
  return skills.filter(s => s.source === 'workspace').map(s => s.slug).sort();
}

function startWatcher(workspaceRoot: string = root): ConfigWatcher {
  watcher = new ConfigWatcher(workspaceRoot, {
    onSkillsListChange: (skills) => listEvents.push(workspaceSlugs(skills)),
    onSkillChange: (slug, skill) => skillEvents.push({ slug, name: skill?.metadata.name ?? null }),
    onSourceChange: (slug) => sourceEvents.push(slug),
    onValidationError: (file) => validationEvents.push(file),
  });
  watcher.start();
  return watcher;
}

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

beforeEach(() => {
  // realpath: macOS reports /var/... temp dirs as /private/var/... in watch events
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'watcher-custom-dirs-')));
  root = join(tempDir, 'workspace');
  createWorkspaceAtPath(root, 'Watcher Custom Dirs');
  watcher = null;
  listEvents = [];
  skillEvents = [];
  sourceEvents = [];
  validationEvents = [];
});

afterEach(() => {
  watcher?.stop();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('ConfigWatcher custom skills directory', () => {
  it('lists skills from the new directory after a switch, even with a warm skills cache', () => {
    writeSkill(join(root, 'skills'), 'old-skill');
    const custom = join(tempDir, 'custom-skills');
    writeSkill(custom, 'new-skill');

    const w = startWatcher();
    loadAllSkills(root); // warm the skills cache
    setSkillsDirectory(custom);
    w.refreshDirectoryPaths();

    expect(listEvents.at(-1)).toEqual(['new-skill']);
  });

  it('notices a new skill in a custom directory outside the workspace', async () => {
    const custom = join(tempDir, 'custom-skills');
    mkdirSync(custom, { recursive: true });
    setSkillsDirectory(custom);

    startWatcher();
    await Bun.sleep(200);
    writeSkill(custom, 'fresh-skill');

    expect(await waitFor(() => listEvents.some(l => l.includes('fresh-skill')))).toBe(true);
  });

  it('notices a new skill in a custom directory inside the workspace', async () => {
    const custom = join(root, 'data', 'skills');
    mkdirSync(custom, { recursive: true });
    setSkillsDirectory(custom);

    startWatcher();
    await Bun.sleep(200);
    writeSkill(custom, 'fresh-skill');

    expect(await waitFor(() => listEvents.some(l => l.includes('fresh-skill')))).toBe(true);
  });

  it('ignores changes in the old default skills folder', async () => {
    const custom = join(tempDir, 'custom-skills');
    mkdirSync(custom);
    setSkillsDirectory(custom);
    startWatcher();
    await Bun.sleep(200);

    writeSkill(join(root, 'skills'), 'ghost');
    await Bun.sleep(400);

    expect(listEvents).toEqual([]);
    expect(skillEvents).toEqual([]);
  });

  it('ignores changes in the old default sources folder', async () => {
    const custom = join(tempDir, 'custom-sources');
    mkdirSync(custom);
    setDefaults({ sourcesDirectory: custom });
    startWatcher();
    await Bun.sleep(200);

    const oldSource = join(root, 'sources', 'ghost');
    mkdirSync(oldSource, { recursive: true });
    writeFileSync(join(oldSource, 'config.json'), '{}');
    await Bun.sleep(400);

    expect(sourceEvents).toEqual([]);
    expect(validationEvents).toEqual([]);
  });

  it('still reloads the default skills folder when the setting names it with a trailing slash', async () => {
    setSkillsDirectory(join(root, 'skills') + '/');
    startWatcher();
    await Bun.sleep(200);
    writeSkill(join(root, 'skills'), 'fresh-skill');

    expect(await waitFor(() => skillEvents.some(e => e.slug === 'fresh-skill'))).toBe(true);
  });

  it('still reloads the default skills folder when the workspace is opened through a symlink', async () => {
    const link = join(tempDir, 'workspace-link');
    symlinkSync(root, link, linkType);
    setSkillsDirectory(join(root, 'skills'));
    startWatcher(link);
    await Bun.sleep(200);
    writeSkill(join(root, 'skills'), 'fresh-skill');

    expect(await waitFor(() => skillEvents.some(e => e.slug === 'fresh-skill'))).toBe(true);
  });

  it('watches only folders outside the workspace tree with extra watchers', () => {
    // Overlapping recursive watchers on one tree can wedge Bun's event loop on Linux
    const outside = join(tempDir, 'custom-skills');
    mkdirSync(outside, { recursive: true });
    setSkillsDirectory(outside);
    expect(startWatcher()._getExtraWatchedDirs()).toEqual([outside]);
    watcher!.stop();

    const inside = join(root, 'data', 'skills');
    mkdirSync(inside, { recursive: true });
    const linkTarget = join(root, 'shared', 'linked');
    writeSkill(join(root, 'shared'), 'linked');
    symlinkSync(linkTarget, join(inside, 'linked'), process.platform === 'win32' ? 'dir' : undefined);
    setSkillsDirectory(inside);
    expect(startWatcher()._getExtraWatchedDirs()).toEqual([]);
  });

  it('reloads a symlinked skill whose target is inside the workspace', async () => {
    writeSkill(join(root, 'shared'), 'linked', 'Before');
    symlinkSync(join(root, 'shared', 'linked'), join(root, 'skills', 'linked'), process.platform === 'win32' ? 'dir' : undefined);

    startWatcher();
    await Bun.sleep(200);
    writeSkill(join(root, 'shared'), 'linked', 'After');

    expect(await waitFor(() => skillEvents.some(e => e.slug === 'linked' && e.name === 'After'))).toBe(true);
  });

  it('reloads a symlinked skill when its SKILL.md changes', async () => {
    const target = join(tempDir, 'linked-target');
    writeSkill(target, 'linked', 'Before');
    symlinkSync(join(target, 'linked'), join(root, 'skills', 'linked'), process.platform === 'win32' ? 'dir' : undefined);

    startWatcher();
    await Bun.sleep(200);
    writeSkill(target, 'linked', 'After');

    expect(await waitFor(() => skillEvents.some(e => e.slug === 'linked' && e.name === 'After'))).toBe(true);
  });

  it('reloads a symlinked skill whose target is nested in an outside custom folder', async () => {
    const custom = join(tempDir, 'custom-skills');
    writeSkill(join(custom, 'dev'), 'commit', 'Before');
    symlinkSync(join(custom, 'dev', 'commit'), join(custom, 'commit'), linkType);
    setSkillsDirectory(custom);

    startWatcher();
    await Bun.sleep(200);
    writeSkill(join(custom, 'dev'), 'commit', 'After');

    expect(await waitFor(() => skillEvents.some(e => e.slug === 'commit' && e.name === 'After'))).toBe(true);
  });

  it('reloads both links when one symlink target contains the other', async () => {
    const outer = join(tempDir, 'outer');
    writeSkill(outer, 'inner', 'Before');
    writeFileSync(join(outer, 'SKILL.md'), '---\nname: Outer Before\ndescription: Test skill\n---\n');
    symlinkSync(join(outer, 'inner'), join(root, 'skills', 'a-inner'), linkType);
    symlinkSync(outer, join(root, 'skills', 'b-outer'), linkType);

    const w = startWatcher();
    expect(w._getExtraWatchedDirs()).toEqual([outer]);
    await Bun.sleep(200);
    writeSkill(outer, 'inner', 'After');
    writeFileSync(join(outer, 'SKILL.md'), '---\nname: Outer After\ndescription: Test skill\n---\n');

    expect(await waitFor(() => skillEvents.some(e => e.slug === 'a-inner' && e.name === 'After'))).toBe(true);
    expect(await waitFor(() => skillEvents.some(e => e.slug === 'b-outer' && e.name === 'Outer After'))).toBe(true);
  });

  it('keeps reloading a skill linked into the sources folder after the sources folder moves', async () => {
    const sources = join(tempDir, 'custom-sources');
    writeSkill(join(sources, 'shared'), 'linked', 'Before');
    symlinkSync(join(sources, 'shared', 'linked'), join(root, 'skills', 'linked'), linkType);
    setDefaults({ sourcesDirectory: sources });

    const w = startWatcher();
    const otherSources = join(tempDir, 'other-sources');
    mkdirSync(otherSources);
    setDefaults({ sourcesDirectory: otherSources });
    w.refreshDirectoryPaths();
    await Bun.sleep(200);
    writeSkill(join(sources, 'shared'), 'linked', 'After');

    expect(await waitFor(() => skillEvents.some(e => e.slug === 'linked' && e.name === 'After'))).toBe(true);
  });

  it('reloads two symlinked skills that point at the same folder', async () => {
    const target = join(tempDir, 'shared-target');
    writeSkill(tempDir, 'shared-target', 'Before');
    symlinkSync(target, join(root, 'skills', 'first'), linkType);
    symlinkSync(target, join(root, 'skills', 'second'), linkType);

    startWatcher();
    await Bun.sleep(200);
    writeSkill(tempDir, 'shared-target', 'After');

    expect(await waitFor(() => skillEvents.some(e => e.slug === 'first' && e.name === 'After'))).toBe(true);
    expect(await waitFor(() => skillEvents.some(e => e.slug === 'second' && e.name === 'After'))).toBe(true);
  });
});
