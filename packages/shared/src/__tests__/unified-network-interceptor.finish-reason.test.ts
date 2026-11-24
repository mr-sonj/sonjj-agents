// Fork test: kept apart from upstream's unified-network-interceptor.sse.test.ts
// so syncing with upstream does not conflict on that file.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toolMetadataStore } from '../interceptor-common.ts';

let createOpenAiSseStrippingStream: typeof import('../unified-network-interceptor.ts').createOpenAiSseStrippingStream;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function runThroughProcessor(
  processor: TransformStream<Uint8Array, Uint8Array>,
  chunks: string[],
): Promise<string> {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const reader = input.pipeThrough(processor).getReader();
  let result = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}

function dataEvents(out: string): Array<Record<string, any>> {
  return out
    .split('\n')
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)));
}

describe('OpenAI SSE: finish_reason on a chunk that also carries tool_calls', () => {
  let sessionDir: string;

  beforeAll(async () => {
    process.env.CRAFT_INTERCEPTOR_DISABLE_AUTO_INSTALL = '1';
    ({ createOpenAiSseStrippingStream } = await import('../unified-network-interceptor.ts'));
  });

  afterAll(() => {
    delete process.env.CRAFT_INTERCEPTOR_DISABLE_AUTO_INSTALL;
  });

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'interceptor-finish-'));
    toolMetadataStore.setSessionDir(sessionDir);
  });

  afterEach(() => {
    toolMetadataStore._clearForTesting();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('keeps finish_reason when the terminal chunk also has the last tool arguments', async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_time","arguments":"{"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const out = await runThroughProcessor(createOpenAiSseStrippingStream(), sse);
    const events = dataEvents(out);

    expect(events).toHaveLength(2);
    expect(events[0]!.choices[0].delta.tool_calls[0].id).toBe('call_1');
    expect(events[0]!.choices[0].delta.tool_calls[0].function.arguments).toBe('{}');
    expect(events[1]!.choices[0].finish_reason).toBe('tool_calls');
    expect(events[1]!.choices[0].delta.tool_calls).toBeUndefined();
    expect(out).toContain('[DONE]');
  });

  it('keeps finish_reason when the whole tool call arrives in the terminal chunk', async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_2","type":"function","function":{"name":"toolA","arguments":"{\\"a\\":1,\\"_intent\\":\\"intent-2\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const out = await runThroughProcessor(createOpenAiSseStrippingStream(), sse);
    const events = dataEvents(out);

    expect(events).toHaveLength(3);
    expect(events[0]!.choices[0].delta.content).toBe('ok');
    expect(events[1]!.choices[0].delta.tool_calls[0].function.arguments).toBe('{"a":1}');
    expect(events[2]!.choices[0].finish_reason).toBe('tool_calls');
    expect(out).not.toContain('_intent');
    expect(toolMetadataStore.get('call_2', sessionDir)?.intent).toBe('intent-2');
  });
});
