import { describe, it, expect } from 'bun:test';
import {
  SESSION_TOOL_DEFS,
  getSessionToolDefs,
  getSessionToolNames,
  getSessionToolRegistry,
  getSessionSafeAllowedToolNames,
  getSessionSafeBlockedToolNames,
  getToolDefsAsJsonSchema,
} from './tool-defs.ts';

describe('session tool filtering helpers', () => {
  it('excludes developer feedback tool when includeDeveloperFeedback is false', () => {
    const defs = getSessionToolDefs({ includeDeveloperFeedback: false });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(false);
  });

  it('includes developer feedback tool when includeDeveloperFeedback is true', () => {
    const defs = getSessionToolDefs({ includeDeveloperFeedback: true });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(true);
  });

  it('hides the decide tool unless includeDecide is true', () => {
    expect(getSessionToolDefs().some(d => d.name === 'decide')).toBe(false);
    expect(getSessionToolDefs({ includeDeveloperFeedback: true }).some(d => d.name === 'decide')).toBe(false);
    expect(getSessionToolDefs({ includeDecide: false }).some(d => d.name === 'decide')).toBe(false);
    expect(getSessionToolDefs({ includeDecide: true }).some(d => d.name === 'decide')).toBe(true);
    expect(getToolDefsAsJsonSchema({ prefix: 'mcp__session__' }).some(d => d.name === 'mcp__session__decide')).toBe(false);
    expect(getToolDefsAsJsonSchema({ prefix: 'mcp__session__', includeDecide: true }).some(d => d.name === 'mcp__session__decide')).toBe(true);
    // Unfiltered constants still know the tool so backends can execute it once advertised.
    expect(SESSION_TOOL_DEFS.some(d => d.name === 'decide' && d.executionMode === 'registry' && d.readOnly === true)).toBe(true);
  });

  it('name set and registry stay aligned for filtered output', () => {
    const names = getSessionToolNames({ includeDeveloperFeedback: false });
    const registry = getSessionToolRegistry({ includeDeveloperFeedback: false });

    expect(registry.has('send_developer_feedback')).toBe(false);
    expect(names.has('send_developer_feedback')).toBe(false);

    for (const name of names) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it('json schema conversion respects includeDeveloperFeedback filter', () => {
    const defs = getToolDefsAsJsonSchema({ includeDeveloperFeedback: false });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(false);
  });

  it('converts every session tool to an object-root JSON schema', () => {
    const defs = getToolDefsAsJsonSchema({ includeDeveloperFeedback: true });

    for (const def of defs) {
      expect(def.inputSchema.type, def.name).toBe('object');
      expect(def.inputSchema.properties, def.name).toBeTypeOf('object');
    }
  });

  it('all canonical session tools declare safeMode metadata', () => {
    for (const def of SESSION_TOOL_DEFS) {
      expect(def.safeMode === 'allow' || def.safeMode === 'block').toBe(true);
    }
  });

  it('safe-mode helper sets classify expected tools', () => {
    const allowed = getSessionSafeAllowedToolNames();
    const blocked = getSessionSafeBlockedToolNames();

    expect(allowed.has('send_developer_feedback')).toBe(true);
    expect(allowed.has('call_llm')).toBe(true);
    expect(allowed.has('browser_tool')).toBe(true);
    expect(allowed.has('script_sandbox')).toBe(true);
    // decide only reads and judges; Explore-safe once it is advertised
    expect(getSessionSafeAllowedToolNames({ includeDecide: true }).has('decide')).toBe(true);

    expect(blocked.has('source_oauth_trigger')).toBe(true);
    expect(blocked.has('source_credential_prompt')).toBe(true);
    expect(blocked.has('spawn_session')).toBe(true);

    // Pages: reads are Explore-safe, mutations are not
    expect(allowed.has('list_pages')).toBe(true);
    expect(allowed.has('get_page')).toBe(true);
    expect(blocked.has('create_page')).toBe(true);
    expect(blocked.has('update_page')).toBe(true);
    expect(blocked.has('write_page_data')).toBe(true);
    expect(blocked.has('delete_page')).toBe(true);
  });

  it('safe-mode helpers support MCP prefixing', () => {
    const allowedPrefixed = getSessionSafeAllowedToolNames({ prefix: 'mcp__session__' });
    const blockedPrefixed = getSessionSafeBlockedToolNames({ prefix: 'mcp__session__' });

    expect(allowedPrefixed.has('mcp__session__send_developer_feedback')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__call_llm')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__script_sandbox')).toBe(true);
    expect(blockedPrefixed.has('mcp__session__source_oauth_trigger')).toBe(true);
    expect(blockedPrefixed.has('mcp__session__spawn_session')).toBe(true);
  });
});
