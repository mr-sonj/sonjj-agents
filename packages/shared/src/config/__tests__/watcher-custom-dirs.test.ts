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
    // One write at a time: on Linux Bun drops a watcher's second change event within the
    // same millisecond, even for another file
    writeSkill(outer, 'inner', 'After');
    expect(await waitFor(() => skillEvents.some(e => e.slug === 'a-inner' && e.name === 'After'))).toBe(true);
    writeFileSync(join(outer, 'SKILL.md'), '---\nname: Outer After\ndescription: Test skill\n---\n');
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

  it('reloads every link to a folder when the change is reported under only one of them', async () => {
    // On Linux the workspace watcher follows symlinks, and a folder reached through several
    // paths reports its events under just one of them
    const target = join(tempDir, 'shared-target');
    writeSkill(tempDir, 'shared-target', 'After');
    symlinkSync(target, join(root, 'skills', 'first'), linkType);
    symlinkSync(target, join(root, 'skills', 'second'), linkType);
    writeSkill(join(root, 'skills'), 'plain', 'After');
    symlinkSync(join(root, 'skills', 'plain'), join(root, 'skills', 'plain-link'), linkType);

    const w = startWatcher();
    w.notifyFileChange('skills/second/SKILL.md');
    w.notifyFileChange('skills/plain-link/SKILL.md');

    expect(await waitFor(() => skillEvents.some(e => e.slug === 'first' && e.name === 'After'))).toBe(true);
    expect(await waitFor(() => skillEvents.some(e => e.slug === 'plain' && e.name === 'After'))).toBe(true);
  });
});

describe('ConfigWatcher extra skill folders', () => {
  function startExtraWatcher(events: string[][], label: (skill: LoadedSkill) => string = s => s.slug): ConfigWatcher {
    watcher = new ConfigWatcher(root, {
      onSkillsListChange: (skills) => events.push(skills.filter(s => s.source === 'extra').map(label).sort()),
    });
    watcher.start();
    return watcher;
  }

  function setExtraSkillDirs(dirs: string[]): void {
    const config = loadWorkspaceConfig(root)!;
    saveWorkspaceConfig(root, { ...config, defaults: { ...config.defaults, extraSkillDirs: dirs } });
  }

  it('broadcasts the skills list when the extra folders change, even with a warm skills cache', () => {
    writeSkill(join(tempDir, 'repos', 'one', '.agents', 'skills'), 'extra-one');
    writeSkill(join(tempDir, 'repos', 'two', '.agents', 'skills'), 'extra-two');
    const events: string[][] = [];

    const w = startExtraWatcher(events);
    loadAllSkills(root); // warm the skills cache
    setExtraSkillDirs([join(tempDir, 'repos', 'one', '.agents', 'skills'), join(tempDir, 'repos', 'two', '.agents', 'skills')]);
    w.refreshDirectoryPaths();

    expect(events.at(-1)).toEqual(['extra-one', 'extra-two']);
  });

  it('does not broadcast when the extra folders stay the same', () => {
    writeSkill(join(tempDir, 'extra'), 'extra-skill');
    setExtraSkillDirs([join(tempDir, 'extra')]);
    const events: string[][] = [];

    const w = startExtraWatcher(events);
    w.refreshDirectoryPaths();

    expect(events).toEqual([]);
  });

  it('reloads the skills list when a skill is added to an extra folder, even with a warm skills cache', async () => {
    const extra = join(tempDir, 'extra');
    writeSkill(extra, 'first');
    setExtraSkillDirs([extra]);
    const events: string[][] = [];

    startExtraWatcher(events);
    loadAllSkills(root); // warm the skills cache
    await Bun.sleep(200);
    writeSkill(extra, 'second');

    expect(await waitFor(() => events.at(-1)?.join() === 'first,second')).toBe(true);
  });

  it('reloads the skills list when an extra skill is edited', async () => {
    const extra = join(tempDir, 'extra');
    writeSkill(extra, 'tool', 'Before');
    setExtraSkillDirs([extra]);
    const events: string[][] = [];

    startExtraWatcher(events, s => s.metadata.name);
    await Bun.sleep(200);
    writeSkill(extra, 'tool', 'After');

    expect(await waitFor(() => events.at(-1)?.join() === 'After')).toBe(true);
  });

  it('starts watching an extra folder once it is added to the setting', async () => {
    const extra = join(tempDir, 'extra');
    mkdirSync(extra, { recursive: true });
    const events: string[][] = [];

    const w = startExtraWatcher(events);
    setExtraSkillDirs([extra]);
    w.refreshDirectoryPaths();
    expect(w._getExtraWatchedDirs()).toEqual([extra]);
    await Bun.sleep(200);
    writeSkill(extra, 'late');

    expect(await waitFor(() => events.at(-1)?.join() === 'late')).toBe(true);
  });

  it('stops watching an extra folder removed from the setting', () => {
    const extra = join(tempDir, 'extra');
    mkdirSync(extra, { recursive: true });
    setExtraSkillDirs([extra]);

    const w = startExtraWatcher([]);
    expect(w._getExtraWatchedDirs()).toEqual([extra]);
    setExtraSkillDirs([]);
    w.refreshDirectoryPaths();

    expect(w._getExtraWatchedDirs()).toEqual([]);
  });

  it('reloads an extra folder inside the workspace through the workspace watcher', async () => {
    const extra = join(root, 'more-skills');
    mkdirSync(extra, { recursive: true });
    setExtraSkillDirs([extra]);
    const events: string[][] = [];

    const w = startExtraWatcher(events);
    expect(w._getExtraWatchedDirs()).toEqual([]);
    await Bun.sleep(200);
    writeSkill(extra, 'inside');

    expect(await waitFor(() => events.at(-1)?.join() === 'inside')).toBe(true);
  });

  it('watches an extra folder nested in another extra folder only through the outer one', () => {
    const outer = join(tempDir, 'extra');
    mkdirSync(join(outer, 'nested'), { recursive: true });
    setExtraSkillDirs([join(outer, 'nested'), outer]);

    expect(startExtraWatcher([])._getExtraWatchedDirs()).toEqual([outer]);
  });

  it('does not watch an extra folder that contains the workspace', async () => {
    setExtraSkillDirs([tempDir]);
    const events: string[][] = [];

    const w = startExtraWatcher(events);
    expect(w._getExtraWatchedDirs()).toEqual([]);
    await Bun.sleep(200);
    writeFileSync(join(root, 'notes.txt'), 'a change in the workspace is not a skill change');
    await Bun.sleep(300);

    expect(events).toEqual([]);
  });
});
