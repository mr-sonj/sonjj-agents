import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionToolContext } from '../context.ts';
import { handleSkillValidate } from './skill-validate.ts';

const SKILL_MD = '---\nname: Extra Skill\ndescription: A skill from an extra folder\n---\n\nDo the thing.\n';

let tempDir: string;
let workspacePath: string;
let projectPath: string;

function createCtx(): SessionToolContext {
  return {
    sessionId: 'test-session',
    workspacePath,
    workingDirectory: projectPath,
    fs: {
      exists: (path: string) => existsSync(path),
      readFile: (path: string) => readFileSync(path, 'utf-8'),
    },
  } as unknown as SessionToolContext;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skill-validate-test-'));
  workspacePath = join(tempDir, 'workspace');
  projectPath = join(tempDir, 'project');
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(projectPath, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('skill_validate with extra skill folders', () => {
  it('validates a skill found in an extra folder', async () => {
    const skillDir = join(tempDir, 'repos', 'one', '.agents', 'skills', 'extra-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD);
    writeFileSync(
      join(workspacePath, 'config.json'),
      JSON.stringify({ defaults: { extraSkillDirs: [join(tempDir, 'repos', 'one', '.agents', 'skills')] } })
    );

    const result = await handleSkillValidate(createCtx(), { skillSlug: 'extra-skill' });

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain(`Validated from extra tier: ${join(skillDir, 'SKILL.md')}`);
  });

  it('lists the extra folders it searched when the skill is missing', async () => {
    const extraDir = join(tempDir, 'extra');
    mkdirSync(extraDir);
    writeFileSync(join(workspacePath, 'config.json'), JSON.stringify({ defaults: { extraSkillDirs: [extraDir] } }));

    const result = await handleSkillValidate(createCtx(), { skillSlug: 'missing-skill' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(`${join(extraDir, 'missing-skill', 'SKILL.md')} (extra)`);
  });
});
