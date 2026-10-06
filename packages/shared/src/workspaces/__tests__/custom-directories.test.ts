/**
 * Tests for the custom skills/sources directories (`defaults.skillsDirectory` /
 * `defaults.sourcesDirectory` in a workspace config.json).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { resolveExtraSkillDirs, resolveSkillsDir, resolveSourcesDir } from '@craft-agent/session-tools-core';
import {
  createWorkspaceAtPath,
  getWorkspaceExtraSkillsPaths,
  getWorkspaceSkillsPath,
  getWorkspaceSourcesPath,
  loadWorkspaceConfig,
  saveWorkspaceConfig,
} from '../storage.ts';

let tempDir: string;
let root: string;

/** Edit config.json directly, the way a user or an agent would. */
function writeDefaults(defaults: Record<string, unknown>): void {
  const configPath = join(root, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  config.defaults = { ...config.defaults, ...defaults };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'custom-dirs-test-'));
  root = join(tempDir, 'workspace');
  createWorkspaceAtPath(root, 'Custom Dirs');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('custom skills/sources directories', () => {
  it('falls back to {root}/skills and {root}/sources when unset', () => {
    expect(getWorkspaceSkillsPath(root)).toBe(join(root, 'skills'));
    expect(getWorkspaceSourcesPath(root)).toBe(join(root, 'sources'));
  });

  it('picks up a hand-edited config.json right away', () => {
    const first = join(tempDir, 'first');
    const second = join(tempDir, 'second');

    writeDefaults({ skillsDirectory: first });
    expect(getWorkspaceSkillsPath(root)).toBe(first);

    writeDefaults({ skillsDirectory: second });
    expect(getWorkspaceSkillsPath(root)).toBe(second);

    writeDefaults({ skillsDirectory: undefined });
    expect(getWorkspaceSkillsPath(root)).toBe(join(root, 'skills'));
  });

  it('resolves a relative path from the workspace root', () => {
    writeDefaults({ skillsDirectory: 'my-skills' });

    expect(getWorkspaceSkillsPath(root)).toBe(join(root, 'my-skills'));
    expect(loadWorkspaceConfig(root)?.defaults?.skillsDirectory).toBe('my-skills');
    const config = loadWorkspaceConfig(root)!;
    saveWorkspaceConfig(root, { ...config, name: 'Renamed' });
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf-8')).defaults.skillsDirectory).toBe('my-skills');
  });

  it('expands ~ and $HOME', () => {
    writeDefaults({ skillsDirectory: '~', sourcesDirectory: '$HOME/my-sources' });

    expect(getWorkspaceSkillsPath(root)).toBe(homedir());
    expect(getWorkspaceSourcesPath(root)).toBe(join(homedir(), 'my-sources'));
  });

  it('resolves every path form the same way as session-tools-core', () => {
    const values = ['~', '~/a', '$HOME/b', '${HOME}/c', 'relative/d', join(tempDir, 'e')];

    values.forEach((value, i) => {
      // A fresh workspace per value, so no resolver has read it before
      const wsRoot = join(tempDir, `parity-${i}`);
      mkdirSync(wsRoot);
      writeFileSync(
        join(wsRoot, 'config.json'),
        JSON.stringify({ defaults: { skillsDirectory: value, sourcesDirectory: value } })
      );
      expect(resolveSkillsDir(wsRoot)).toBe(getWorkspaceSkillsPath(wsRoot));
      expect(resolveSourcesDir(wsRoot)).toBe(getWorkspaceSourcesPath(wsRoot));
    });
  });
});

describe('extra skill directories', () => {
  /** Create folders (relative to tempDir) and return their absolute paths */
  function makeDirs<T extends string[]>(...paths: T): { [K in keyof T]: string } {
    return paths.map(path => {
      const dir = join(tempDir, path);
      mkdirSync(dir, { recursive: true });
      return dir;
    }) as { [K in keyof T]: string };
  }

  it('is empty when unset or not a list', () => {
    expect(getWorkspaceExtraSkillsPaths(root)).toEqual([]);

    writeDefaults({ extraSkillDirs: join(tempDir, 'not-a-list') });
    expect(getWorkspaceExtraSkillsPaths(root)).toEqual([]);
  });

  it('keeps the listed order and skips folders that do not exist', () => {
    const [b, a] = makeDirs('b', 'a');
    writeDefaults({ extraSkillDirs: [b, join(tempDir, 'missing'), a, 42, '  '] });

    expect(getWorkspaceExtraSkillsPaths(root)).toEqual([b, a]);
  });

  it('takes * and ? as part of a folder name, not as wildcards', () => {
    makeDirs('projects/alpha/skills');
    const [literal] = makeDirs('literal/*');
    writeDefaults({ extraSkillDirs: [join(tempDir, 'projects/*/skills'), join(tempDir, 'projects/alph?/skills'), literal] });

    expect(getWorkspaceExtraSkillsPaths(root)).toEqual([literal]);
  });

  it('resolves a relative path from the workspace root', () => {
    const [inside] = makeDirs('workspace/team-skills');
    writeDefaults({ extraSkillDirs: ['team-skills'] });

    expect(getWorkspaceExtraSkillsPaths(root)).toEqual([inside]);
  });

  it('lists a folder once when it is listed twice', () => {
    const [one, two] = makeDirs('p/one', 'p/two');
    writeDefaults({ extraSkillDirs: [two, one, two] });

    expect(getWorkspaceExtraSkillsPaths(root)).toEqual([two, one]);
  });

  it('sees a folder created after the config was read', () => {
    writeDefaults({ extraSkillDirs: [join(tempDir, 'later')] });
    expect(getWorkspaceExtraSkillsPaths(root)).toEqual([]);

    const [created] = makeDirs('later');
    expect(getWorkspaceExtraSkillsPaths(root)).toEqual([created]);
  });

  it('matches session-tools-core', () => {
    const [one, two] = makeDirs('x/one', 'x/two');
    writeDefaults({ extraSkillDirs: [one, 'missing', two] });

    expect(resolveExtraSkillDirs(root)).toEqual(getWorkspaceExtraSkillsPaths(root));
  });

  it('saves the config untouched when extraSkillDirs was hand-edited to a non-list', () => {
    writeDefaults({ extraSkillDirs: 'team-skills' });
    const config = loadWorkspaceConfig(root)!;

    saveWorkspaceConfig(root, { ...config, name: 'Renamed' });
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf-8')).defaults.extraSkillDirs).toBe('team-skills');
  });

  it('stores each entry in portable form', () => {
    const config = loadWorkspaceConfig(root)!;
    saveWorkspaceConfig(root, {
      ...config,
      defaults: { ...config.defaults, extraSkillDirs: [join(homedir(), 'code/team-skills'), 'rel'] },
    });

    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf-8')).defaults.extraSkillDirs)
      .toEqual(['~/code/team-skills', 'rel']);
  });
});
