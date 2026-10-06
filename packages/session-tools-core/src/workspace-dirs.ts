/**
 * Workspace skills/sources directories.
 *
 * A workspace can move its skills or sources folder with `defaults.skillsDirectory` /
 * `defaults.sourcesDirectory` in its config.json. This is the only resolver for those
 * settings: @craft-agent/shared's getWorkspaceSkillsPath/getWorkspaceSourcesPath delegate
 * here, and session tools running in a subprocess (no dependency on shared) use it directly,
 * so every process resolves the same folder.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';

interface WorkspaceDirs {
  /** Identity of config.json when it was read; an edit or an atomic replace changes it. */
  stamp: string;
  skillsDirectory: string | null;
  sourcesDirectory: string | null;
}

/**
 * Parsed directories per workspace root. Each lookup costs one stat of config.json, so
 * edits from any process or by hand are seen at once without explicit invalidation.
 */
const dirsCache = new Map<string, WorkspaceDirs>();

/**
 * Expand a configured directory: `~`, `~/…`, `$HOME` and `${HOME}` point at the home
 * directory, and a relative path resolves from the workspace root.
 */
export function expandWorkspaceDirPath(rawPath: string, workspaceRootPath: string): string {
  const home = homedir();
  let expanded = rawPath.trim();
  if (expanded === '~') return home;
  if (expanded.startsWith('~/')) expanded = join(home, expanded.slice(2));
  expanded = expanded.replace(/\$\{HOME\}/g, home).replace(/\$HOME(?=\/|$)/g, home);
  return isAbsolute(expanded) ? normalize(expanded) : resolve(workspaceRootPath, expanded);
}

function readWorkspaceDirs(workspaceRootPath: string): WorkspaceDirs | null {
  const configPath = join(workspaceRootPath, 'config.json');
  let stamp: string;
  try {
    const stats = statSync(configPath);
    stamp = `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    dirsCache.delete(workspaceRootPath);
    return null;
  }

  const cached = dirsCache.get(workspaceRootPath);
  if (cached?.stamp === stamp) return cached;

  let defaults: Record<string, unknown> | undefined;
  try {
    const raw = readFileSync(configPath, 'utf-8').replace(/^﻿/, '');
    defaults = JSON.parse(raw)?.defaults;
  } catch {
    // Unreadable or half-written config: use the default folders until it changes again
  }

  const read = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? expandWorkspaceDirPath(value, workspaceRootPath) : null;

  const dirs: WorkspaceDirs = {
    stamp,
    skillsDirectory: read(defaults?.skillsDirectory),
    sourcesDirectory: read(defaults?.sourcesDirectory),
  };
  dirsCache.set(workspaceRootPath, dirs);
  return dirs;
}

/**
 * The workspace's sources folder: the custom `sourcesDirectory` if set, else {root}/sources.
 */
export function resolveSourcesDir(workspaceRootPath: string): string {
  return readWorkspaceDirs(workspaceRootPath)?.sourcesDirectory ?? join(workspaceRootPath, 'sources');
}

/**
 * The workspace's skills folder: the custom `skillsDirectory` if set, else {root}/skills.
 */
export function resolveSkillsDir(workspaceRootPath: string): string {
  return readWorkspaceDirs(workspaceRootPath)?.skillsDirectory ?? join(workspaceRootPath, 'skills');
}
