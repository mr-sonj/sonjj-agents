/**
 * Skill Validate Handler
 *
 * Validates a skill's SKILL.md file for correct format and required fields.
 * Resolves skills from every tier: project > workspace > extra folders > global.
 *
 * The handler resolves the session's workingDirectory on demand from the
 * persisted session.jsonl header — no construction-time propagation needed.
 * If resolution fails, project-tier skills are silently skipped with a warning.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse } from '../response.ts';
import { resolveSessionWorkingDirectory } from '../source-helpers.ts';
import { resolveExtraSkillDirs, resolveSkillsDir } from '../workspace-dirs.ts';
import {
  validateSlug,
  validateSkillContent,
  formatValidationResult,
} from '../validation.ts';

export interface SkillValidateArgs {
  skillSlug: string;
}

/**
 * Every place the skill's SKILL.md may be, highest priority first:
 * 1. Project: {projectRoot}/.agents/skills/{slug}/SKILL.md
 * 2. Workspace: {workspace}/skills/{slug}/SKILL.md, or the custom skillsDirectory
 * 3. Extra: each folder from extraSkillDirs, in the order listed
 * 4. Global: ~/.agents/skills/{slug}/SKILL.md
 */
function skillMdCandidates(
  ctx: SessionToolContext,
  slug: string,
  workingDirectory: string | undefined
): Array<{ path: string; tier: string }> {
  const dirs: Array<{ dir: string; tier: string }> = [
    ...(workingDirectory ? [{ dir: join(workingDirectory, '.agents', 'skills'), tier: 'project' }] : []),
    { dir: resolveSkillsDir(ctx.workspacePath), tier: 'workspace' },
    ...resolveExtraSkillDirs(ctx.workspacePath).map(dir => ({ dir, tier: 'extra' })),
    { dir: join(homedir(), '.agents', 'skills'), tier: 'global' },
  ];
  return dirs.map(({ dir, tier }) => ({ path: join(dir, slug, 'SKILL.md'), tier }));
}

/**
 * Handle the skill_validate tool call.
 *
 * 1. Validate slug format
 * 2. Resolve workingDirectory from ctx or session header (graceful fallback)
 * 3. Resolve SKILL.md from every tier (project > workspace > extra > global)
 * 4. Read and validate content (frontmatter + body)
 * 5. Return validation result with warnings if project tier was skipped
 */
export async function handleSkillValidate(
  ctx: SessionToolContext,
  args: SkillValidateArgs
): Promise<ToolResult> {
  const { skillSlug } = args;

  // Validate slug format first
  const slugResult = validateSlug(skillSlug);
  if (!slugResult.valid) {
    return {
      content: [{ type: 'text', text: formatValidationResult(slugResult) }],
      isError: true,
    };
  }

  // Resolve workingDirectory: ctx first (if factories ever populate it), then session header
  const workingDirectory = ctx.workingDirectory
    ?? resolveSessionWorkingDirectory(ctx.workspacePath, ctx.sessionId);

  // Resolve SKILL.md from every tier, first match wins
  const candidates = skillMdCandidates(ctx, skillSlug, workingDirectory);
  const resolved = candidates.find(candidate => ctx.fs.exists(candidate.path));
  if (!resolved) {
    const searchedPaths = candidates.map(({ path, tier }) => `  - ${path} (${tier})`).join('\n');

    const warning = !workingDirectory
      ? '\n\nNote: Project-level skills (.agents/skills/) were not checked — working directory could not be resolved.'
      : '';

    return errorResponse(
      `SKILL.md not found for skill "${skillSlug}". Searched:\n${searchedPaths}${warning}\n\nCreate it with YAML frontmatter.`
    );
  }

  // Read and validate content
  let content: string;
  try {
    content = ctx.fs.readFile(resolved.path);
  } catch (e) {
    return errorResponse(
      `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`
    );
  }

  const result = validateSkillContent(content, skillSlug);
  const tierInfo = `Validated from ${resolved.tier} tier: ${resolved.path}`;
  const formatted = formatValidationResult(result);

  // If workingDirectory couldn't be resolved, warn that project tier was skipped
  const warnings: string[] = [];
  if (!workingDirectory) {
    warnings.push('Note: Project-level skills (.agents/skills/) were not checked — working directory could not be resolved.');
  }
  const warningText = warnings.length > 0 ? '\n\n' + warnings.join('\n') : '';

  return {
    content: [{ type: 'text', text: `${tierInfo}\n\n${formatted}${warningText}` }],
    isError: !result.valid, // warnings don't make it an error
  };
}
