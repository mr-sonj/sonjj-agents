import { describe, expect, it } from 'bun:test';
import { stream as streamGoogle } from '@earendil-works/pi-ai/api/google-generative-ai';
import { stream as streamVertex } from '@earendil-works/pi-ai/api/google-vertex';
import { normalizeContext } from '@earendil-works/pi-ai';
import { getToolDefsAsJsonSchema } from '@craft-agent/session-tools-core';

const STOP_BEFORE_NETWORK = 'captured provider payload';

const tool = {
  name: 'choose_mode',
  description: 'Choose an execution mode',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        const: 'fast',
      },
    },
    required: ['mode'],
  },
};

async function captureToolDeclaration(
  streamProvider: typeof streamGoogle,
  api: 'google-generative-ai' | 'google-vertex',
  tools: typeof tool[] = [tool],
): Promise<Record<string, unknown>> {
  let capturedPayload: any;
  const eventStream = streamProvider(
    {
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      api,
      provider: api === 'google-vertex' ? 'google-vertex' : 'google',
      baseUrl: '',
      reasoning: false,
      input: ['text'],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 1_000_000,
      maxTokens: 8_192,
    } as any,
    // Provider stream functions take a transcript context: tools ride on the
    // leading system message instead of a top-level `tools` field.
    normalizeContext({
      messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
      tools,
    } as any) as any,
    {
      apiKey: 'test-key',
      onPayload(payload) {
        capturedPayload = payload;
        throw new Error(STOP_BEFORE_NETWORK);
      },
    },
  );

  for await (const event of eventStream) {
    if (event.type === 'error') {
      expect(event.error.errorMessage).toContain(STOP_BEFORE_NETWORK);
    }
  }

  expect(capturedPayload).toBeDefined();
  return capturedPayload.config.tools[0].functionDeclarations[0];
}

async function captureSessionToolDeclarations(): Promise<any[]> {
  let capturedPayload: any;
  const tools = getToolDefsAsJsonSchema({ includeDeveloperFeedback: true }).map(def => ({
    name: def.name,
    description: def.description,
    parameters: def.inputSchema,
  }));
  const eventStream = streamGoogle(
    {
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      api: 'google-generative-ai',
      provider: 'google',
      baseUrl: '',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 8_192,
    } as any,
    // Provider stream functions take a transcript context: tools ride on the
    // leading system message instead of a top-level `tools` field.
    normalizeContext({
      messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
      tools,
    } as any) as any,
    {
      apiKey: 'test-key',
      onPayload(payload) {
        capturedPayload = payload;
        throw new Error(STOP_BEFORE_NETWORK);
      },
    },
  );

  for await (const event of eventStream) {
    if (event.type === 'error') {
      expect(event.error.errorMessage).toContain(STOP_BEFORE_NETWORK);
    }
  }

  return capturedPayload.config.tools[0].functionDeclarations;
}

describe('Google provider tool schema compatibility', () => {
  it('uses parametersJsonSchema for Google AI Studio', async () => {
    const declaration = await captureToolDeclaration(
      streamGoogle,
      'google-generative-ai',
    );

    expect(declaration).not.toHaveProperty('parameters');
    expect(declaration).toHaveProperty('parametersJsonSchema.type', 'object');
    expect(declaration).toHaveProperty(
      'parametersJsonSchema.properties.mode.const',
      'fast',
    );
  });

  it('uses legacy OpenAPI parameters for Vertex and converts const to enum', async () => {
    const declaration = await captureToolDeclaration(
      streamVertex as typeof streamGoogle,
      'google-vertex',
    );

    expect(declaration).not.toHaveProperty('parametersJsonSchema');
    expect(declaration).toHaveProperty('parameters.type', 'object');
    expect(declaration).toHaveProperty(
      'parameters.properties.mode.enum',
      ['fast'],
    );
    expect(declaration).not.toHaveProperty('parameters.properties.mode.const');
  });

  it('serializes every session proxy tool with an object-root schema', async () => {
    const declarations = await captureSessionToolDeclarations();

    expect(declarations.length).toBeGreaterThan(20);
    for (const declaration of declarations) {
      expect(declaration).not.toHaveProperty('parameters');
      expect(declaration).toHaveProperty('parametersJsonSchema.type', 'object');
      expect(declaration).toHaveProperty('parametersJsonSchema.properties');
    }
  });
});
