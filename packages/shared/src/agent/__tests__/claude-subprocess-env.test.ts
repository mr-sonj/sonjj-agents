import { afterEach, describe, expect, it } from 'bun:test';
import { buildClaudeSubprocessEnv, engineLoadsClaudeMd } from '../options.ts';

const originalTodoFlag = process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS;
const originalDisableClaudeMds = process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS;

afterEach(() => {
  if (originalTodoFlag === undefined) delete process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS;
  else process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS = originalTodoFlag;
  if (originalDisableClaudeMds === undefined) delete process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS;
  else process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = originalDisableClaudeMds;
});

describe('buildClaudeSubprocessEnv', () => {
  it('keeps the task-tracking tools available on every model (SDK 0.3.268 default change)', () => {
    delete process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS;
    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1');
  });

  it('respects an explicit opt-out from the process environment', () => {
    process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '0';
    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('0');
  });

  it('respects a per-session override', () => {
    delete process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS;
    expect(buildClaudeSubprocessEnv({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' }).CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('0');
  });

  // The system prompt leaves out the CLAUDE.md files the engine loads itself
  // (prompts/system.ts), so the engine must keep loading them.
  it('leaves the engine loading CLAUDE.md files', () => {
    delete process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS;
    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBeUndefined();
  });
});

describe('engineLoadsClaudeMd', () => {
  it('is true while CLAUDE_CODE_DISABLE_CLAUDE_MDS is unset or falsy', () => {
    expect(engineLoadsClaudeMd({})).toBe(true);
    expect(engineLoadsClaudeMd({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0' })).toBe(true);
    expect(engineLoadsClaudeMd({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: 'false' })).toBe(true);
  });

  it('is false for every value the engine reads as true', () => {
    for (const value of ['1', 'true', 'YES', ' on ']) {
      expect(engineLoadsClaudeMd({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: value })).toBe(false);
    }
  });
});
