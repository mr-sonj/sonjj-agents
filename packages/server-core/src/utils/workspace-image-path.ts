import { existsSync } from 'fs'
import { join, resolve, sep } from 'path'
import { GLOBAL_AGENT_SKILLS_DIR } from '@craft-agent/shared/skills'
import {
  getWorkspaceExtraSkillsPaths,
  getWorkspaceSkillsPath,
  getWorkspaceSourcesPath,
} from '@craft-agent/shared/workspaces'

/**
 * The file a workspace image request (READ_IMAGE) reads. Icons are asked for by their place in
 * a default workspace (`skills/{slug}/icon.svg`, `sources/{slug}/icon.png`), so:
 * - `skills/{slug}/…` is looked up where skills load from, in the same order: the workspace
 *   skills folder (or the custom skillsDirectory), each extra skill folder, then
 *   ~/.agents/skills (project skills depend on the session and are not looked up)
 * - `sources/{slug}/…` in the workspace sources folder (or the custom sourcesDirectory)
 * - anything else in the workspace root
 * Returns the first file that exists inside its folder, or null.
 */
export function resolveWorkspaceImagePath(rootPath: string, relativePath: string): string | null {
  const [top, ...rest] = relativePath.split('/')
  const inside = rest.join('/')
  const folders =
    top === 'skills' && inside ? [getWorkspaceSkillsPath(rootPath), ...getWorkspaceExtraSkillsPaths(rootPath), GLOBAL_AGENT_SKILLS_DIR] :
    top === 'sources' && inside ? [getWorkspaceSourcesPath(rootPath)] :
    null

  if (!folders) return existingInside(rootPath, relativePath)
  for (const folder of folders) {
    const path = existingInside(folder, inside)
    if (path) return path
  }
  return null
}

function existingInside(folder: string, relativePath: string): string | null {
  const base = resolve(folder)
  const path = join(base, relativePath)
  return path.startsWith(base + sep) && existsSync(path) ? path : null
}
