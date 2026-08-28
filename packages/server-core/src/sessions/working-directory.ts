/**
 * Working-directory resolution for sessions.
 *
 * Two folders are easy to confuse:
 *
 * - **workspace.rootPath** — the app's internal storage folder
 *   (`~/.craft-agent/workspaces/<slug>`). Metadata, sessions, skills. A user never
 *   means this when they say "the project".
 * - **defaults.workingDirectory** — the workspace's *project* folder, set by the user
 *   in Workspace Settings. This is what a reset goes back to.
 *
 * Pure decision logic, kept out of SessionManager so the rules can be tested without
 * standing up a session.
 */

import { existsSync } from 'fs'

export interface WorkingDirectoryDefaults {
  /** The workspace's project folder, from Workspace Settings. */
  workingDirectory?: string
  /** Folder last picked in a session, remembered so the next new session starts there. */
  lastSessionWorkingDirectory?: string
}

/**
 * Trim a directory path for comparison: drop surrounding whitespace and any trailing
 * separators. Returns `undefined` for blank input so callers can use `??` chains.
 * Filesystem roots (`/`, `\`) are preserved as-is.
 *
 * @example
 * normalizeDirPath('/Users/alice/code/')  // '/Users/alice/code'
 * normalizeDirPath('   ')                 // undefined
 * normalizeDirPath('/')                   // '/'
 */
export function normalizeDirPath(path?: string | null): string | undefined {
  if (!path) return undefined
  const trimmed = path.trim()
  if (!trimmed) return undefined
  if (trimmed === '/' || trimmed === '\\') return trimmed
  return trimmed.replace(/[/\\]+$/, '') || trimmed
}

/**
 * Resolve a working-directory change request into a concrete target.
 *
 * The renderer sends `''` for a reset rather than a concrete path, so the *server*
 * chooses the target: a remote server resolves its own project folder instead of a
 * path that only exists on the client's machine.
 *
 * Returns `undefined` when a reset is requested but the workspace has no project
 * folder configured. `rootPath` is deliberately not a fallback — dropping the session
 * into the app's internal storage folder is the behaviour this replaces.
 */
export function resolveWorkingDirectoryUpdate(
  requestedPath: string | undefined,
  projectRoot: string | undefined,
): string | undefined {
  return normalizeDirPath(requestedPath) ?? normalizeDirPath(projectRoot)
}

/**
 * The folder a *new* session opens in, before any caller override.
 *
 * A folder picked in an earlier session wins over the workspace setting: that pick is
 * the more recent statement of intent, and remembering it is the whole point of
 * `lastSessionWorkingDirectory`. Reset clears it, which is how new sessions find their
 * way back to the configured project folder.
 *
 * A remembered folder that no longer exists is ignored rather than inherited. It is
 * stored as an absolute path, so a workspace opened on another machine (or after the
 * folder was moved) would otherwise start every new session in a dead directory.
 *
 * @param exists - Existence check, injectable for tests.
 */
export function resolveNewSessionWorkingDirectory(
  defaults: WorkingDirectoryDefaults | undefined,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const remembered = normalizeDirPath(defaults?.lastSessionWorkingDirectory)
  if (remembered && exists(remembered)) return remembered
  return normalizeDirPath(defaults?.workingDirectory)
}
