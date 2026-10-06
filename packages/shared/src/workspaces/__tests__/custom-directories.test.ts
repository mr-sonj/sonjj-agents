/**
 * Tests for the custom skills/sources directories (`defaults.skillsDirectory` /
 * `defaults.sourcesDirectory` in a workspace config.json).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { resolveSkillsDir, resolveSourcesDir } from '@craft-agent/session-tools-core';
import {
  createWorkspaceAtPath,
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
