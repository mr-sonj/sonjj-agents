import { realpathSync, statSync, type Stats } from 'fs'
import { dirname, resolve, sep, win32 as pathWin32 } from 'path'
import { getExtraSkillsPath } from '@craft-agent/shared/workspaces'

export interface PathValidationResult {
  valid: boolean
  reason?: string
}

type StatLike = (path: string) => Stats

function isAbsolutePathForPlatform(path: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
  }
  return path.startsWith('/')
}

/**
 * Validate path format for the current server platform (no filesystem access).
 * Rejects cross-platform paths (e.g., Windows paths on macOS and vice versa).
 * Platform is injectable for cross-platform unit testing without mocking globals.
 */
export function validatePathFormat(
  path: string,
  platform: NodeJS.Platform = process.platform
): PathValidationResult {
  const trimmed = path.trim()
  const isWindows = platform === 'win32'

  if (!trimmed) {
    return { valid: false, reason: 'Path is required.' }
  }

  if (!isWindows) {
    if (/^[A-Za-z]:(?:[\\/]|$)/.test(trimmed)) {
      return { valid: false, reason: 'Windows drive path is not valid on this server. Use a server-side path.' }
    }
    if (trimmed.startsWith('\\\\')) {
      return { valid: false, reason: 'UNC path is not valid on this server. Use a server-side path.' }
    }
    if (!trimmed.startsWith('/')) {
      return { valid: false, reason: 'Path must be absolute (start with /).' }
    }
    return { valid: true }
  }

  if (trimmed.startsWith('/')) {
    return { valid: false, reason: 'Unix path is not valid on this server. Use a Windows path (e.g., C:\\...).' }
  }

  if (!isAbsolutePathForPlatform(trimmed, platform)) {
    return { valid: false, reason: 'Path must be an absolute Windows path (e.g., C:\\... or \\\\server\\share\\...).' }
  }

  return { valid: true }
}

/**
 * Validate that a path is a usable working directory on the current server.
 * Checks format, existence, and that the path is a directory.
 */
export function isValidWorkingDirectory(
  path: string,
  platform: NodeJS.Platform = process.platform,
  statFn: StatLike = statSync
): PathValidationResult {
  const trimmed = path.trim()
  const formatCheck = validatePathFormat(trimmed, platform)
  if (!formatCheck.valid) return formatCheck

  try {
    const s = statFn(trimmed)
    if (!s.isDirectory()) {
      return { valid: false, reason: `Not a directory: ${trimmed}` }
    }
  } catch {
    return { valid: false, reason: `Directory not found: ${trimmed}` }
  }

  return { valid: true }
}

/**
 * Validate that a workspace root path is usable on the current server.
 * Existing directories are allowed. Non-existent paths are allowed only when
 * their parent directory exists, which supports "create new workspace" flows.
 */
export function isValidWorkspaceRootPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
  statFn: StatLike = statSync
): PathValidationResult {
  const trimmed = path.trim()
  const formatCheck = validatePathFormat(trimmed, platform)
  if (!formatCheck.valid) return formatCheck

  try {
    const existing = statFn(trimmed)
    if (!existing.isDirectory()) {
      return { valid: false, reason: `Not a directory: ${trimmed}` }
    }
    return { valid: true }
  } catch {
    let currentPath = trimmed

    while (true) {
      const parentPath = platform === 'win32' ? pathWin32.dirname(currentPath) : dirname(currentPath)

      if (!parentPath || parentPath === currentPath) {
        return { valid: false, reason: `Parent directory not found: ${currentPath}` }
      }

      try {
        const parent = statFn(parentPath)
        if (!parent.isDirectory()) {
          return { valid: false, reason: `Parent path is not a directory: ${parentPath}` }
        }
        return { valid: true }
      } catch {
        currentPath = parentPath
      }
    }
  }
}

/**
 * Validate a custom skills or sources folder for a workspace.
 * Must be an existing directory (see isValidWorkingDirectory) that is neither the
 * workspace folder nor one of its parents (the watcher would then watch the whole
 * tree), and must not overlap the other setting's folder. Symlinks are resolved first.
 */
export function isValidCustomDirectory(
  path: string,
  workspaceRoot: string,
  otherDirectory?: string
): PathValidationResult {
  const trimmed = path.trim()
  const basic = isValidWorkingDirectory(trimmed)
  if (!basic.valid) return basic

  const dir = realpathOrResolve(trimmed)
  const root = realpathOrResolve(workspaceRoot)

  if (dir === root) {
    return { valid: false, reason: 'Cannot be the workspace folder itself.' }
  }
  if (root.startsWith(dir.endsWith(sep) ? dir : dir + sep)) {
    return { valid: false, reason: 'Cannot be a parent of the workspace folder.' }
  }
  if (otherDirectory && directoriesOverlap(otherDirectory, dir)) {
    return SAME_FOLDER
  }

  return { valid: true }
}

/**
 * Validate a new skillsDirectory/sourcesDirectory setting. `path` undefined means going
 * back to `defaultDirectory`, which must not overlap the folder the other setting
 * uses; a custom path gets the full isValidCustomDirectory check.
 */
export function isValidDirectorySetting(
  path: string | undefined,
  defaultDirectory: string,
  workspaceRoot: string,
  otherDirectory: string
): PathValidationResult {
  if (path === undefined) {
    return directoriesOverlap(defaultDirectory, otherDirectory) ? SAME_FOLDER : { valid: true }
  }
  return isValidCustomDirectory(path, workspaceRoot, otherDirectory)
}

/**
 * Validate a new `extraSkillDirs` entry: it must be an existing folder (`~` is the home
 * folder, a relative entry starts at the workspace root).
 */
export function isValidExtraSkillDir(entry: string, workspaceRoot: string): PathValidationResult {
  return isValidWorkingDirectory(getExtraSkillsPath(workspaceRoot, entry))
}

/**
 * The `extraSkillDirs` entries saved in a workspace config. A hand-edited config may hold
 * anything there, so only path entries are kept, as written.
 */
export function savedExtraSkillDirs(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * Clean up a new `extraSkillDirs` list (trim, drop blanks, keep the first entry for each folder
 * however it is written; `dirs` is undefined when nothing is left) and check each entry whose
 * folder is not in `saved` with isValidExtraSkillDir. Saved folders stay as they are, so a
 * folder that went away does not block other edits.
 */
export function validateExtraSkillDirs(
  value: unknown,
  workspaceRoot: string,
  saved: readonly string[] = []
): PathValidationResult & { dirs?: string[] } {
  if (value === undefined || value === null) return { valid: true, dirs: undefined }
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    return { valid: false, reason: 'Extra skill folders must be a list of paths.' }
  }

  const savedPaths = new Set(saved.map(entry => getExtraSkillsPath(workspaceRoot, entry)))
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const entry of (value as string[]).map(entry => entry.trim()).filter(Boolean)) {
    const path = getExtraSkillsPath(workspaceRoot, entry)
    if (seen.has(path)) continue
    seen.add(path)
    if (!savedPaths.has(path)) {
      const validation = isValidExtraSkillDir(entry, workspaceRoot)
      if (!validation.valid) return validation
    }
    dirs.push(entry)
  }
  return { valid: true, dirs: dirs.length > 0 ? dirs : undefined }
}

const SAME_FOLDER: PathValidationResult = { valid: false, reason: 'Skills and sources directories cannot overlap.' }

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function directoriesOverlap(a: string, b: string): boolean {
  const first = realpathOrResolve(a)
  const second = realpathOrResolve(b)
  return first === second || first.startsWith(second + sep) || second.startsWith(first + sep)
}
