import { describe, expect, it } from 'bun:test';
import { resolveSearchProvider } from './resolve-provider.ts';
import { ResponsesApiSearchProvider } from './providers/openai.ts';
import { DDGSearchProvider } from './providers/ddg.ts';

// A custom endpoint connection is tagged `openai` or `anthropic` only to pick the auth header
// format; its key belongs to the user's endpoint, not to the provider. Provider-native search
// would send that key to the real provider and fail with 401 on every call.
describe('resolveSearchProvider on a custom endpoint', () => {
  it.each(['openai', 'openrouter', 'google'])('falls back to DDG for %s + api_key', (provider) => {
    const resolved = resolveSearchProvider(
      { provider, credential: { type: 'api_key', key: 'proxy-key' } },
      'gpt-6-sol',
      { customEndpoint: true },
    );

    expect(resolved).toBeInstanceOf(DDGSearchProvider);
  });

  it('keeps provider-native search when the connection is not a custom endpoint', () => {
    const resolved = resolveSearchProvider(
      { provider: 'openai', credential: { type: 'api_key', key: 'sk-test' } },
      undefined,
      { customEndpoint: false },
    );

    expect(resolved).toBeInstanceOf(ResponsesApiSearchProvider);
  });
});
