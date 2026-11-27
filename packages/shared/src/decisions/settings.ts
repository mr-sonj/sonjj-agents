/**
 * Decision layer — settings model (browser-safe: no Node imports).
 *
 * Stored under `StoredConfig.decisionLayer` (see config/storage.ts
 * `getDecisionLayerSettings` / `setDecisionLayerSettings`). Everything is
 * optional on disk; `normalizeDecisionLayerSettings` fills the defaults.
 *
 * The layer is OFF by default; the `enabled` switch in Settings > AI is the only
 * master gate (no environment flag).
 */

import {
  DecisionError,
  DECISION_DEFAULT_DEADLINE_MS,
  DECISION_MAX_DEADLINE_MS,
  DECISION_MIN_DEADLINE_MS,
  isDecisionProviderId,
  type DecisionProviderId,
} from './types.ts';
import { DECISION_PROVIDER_PRESETS, buildSystemOneEndpoint, type DecisionProviderPreset } from './providers.ts';

/**
 * Which product surfaces may call the decision model. All zero-authority: an
 * answer can add friction or information, never remove a prompt.
 */
export interface DecisionLayerFeatureToggles {
  /** `decide` session tool (agent-initiated classification / routing / scoring). */
  decideTool: boolean;
  /** Typed task verdicts when the orchestrator's text has no parseable verdict. */
  taskVerdicts: boolean;
  /** Semantic auto-label rules next to regex rules. */
  semanticLabels: boolean;
  /** How a turn ended (finished / needs input / blocked): Needs Review status, task nodes not marked done. */
  turnOutcome: boolean;
  /**
   * Offer the Guarded permission mode: runs like Execute, but a non-read-only call the model
   * judges risky becomes a prompt (adds prompts, never removes them). Execute never asks the model.
   */
  guardedMode: boolean;
  /** Risk badges on permission prompts (informational). */
  riskBadges: boolean;
  /** Automation `semanticCondition`: skip a prompt run whose condition the model answers below its threshold. */
  automationConditions: boolean;
  /** Repair only the subtasks a FAIL verdict's reason implicates (when it names none). */
  taskRepairs: boolean;
  /** Skip titling small talk; refresh automatic titles that no longer fit. */
  smartTitles: boolean;
  /** Lower the thinking level for a simple turn (never above the session's). */
  adaptiveThinking: boolean;
  /** Mid-turn messages: steer corrections, queue follow-ups, merge queued continuations. */
  midTurnMessages: boolean;
  /** Skip the summary of a large tool result when the preview and saved file are enough. */
  largeResults: boolean;
  /** Point the agent at a skill or inactive source the user's message plainly needs. */
  suggestions: boolean;
  /** Run a Claude subagent on a cheaper model when its task does not need the session's (never above it). */
  subagentModels: boolean;
}

export type DecisionLayerFeature = keyof DecisionLayerFeatureToggles;

export const DECISION_LAYER_FEATURES: readonly DecisionLayerFeature[] = [
  'decideTool',
  'taskVerdicts',
  'semanticLabels',
  'turnOutcome',
  'guardedMode',
  'riskBadges',
  'automationConditions',
  'taskRepairs',
  'smartTitles',
  'adaptiveThinking',
  'midTurnMessages',
  'largeResults',
  'suggestions',
  'subagentModels',
] as const;

export interface DecisionLayerSettings {
  /** Master switch. Off → the app behaves exactly as without the layer. */
  enabled: boolean;
  provider: DecisionProviderId;
  /**
   * Reuse the API key of an existing LLM connection (OpenRouter or Vercel AI
   * Gateway). When set, the provider is derived from that connection.
   */
  connectionSlug?: string;
  /** Required for `custom`; optional override for the presets. */
  baseUrl?: string;
  /** Pinned model id; defaults to the provider preset. */
  model?: string;
  /** Wall-clock budget per call for background features. The `decide` tool uses its own. */
  deadlineMs: number;
  features: DecisionLayerFeatureToggles;
}

/** On-disk shape: everything optional. */
export interface DecisionLayerStoredSettings {
  enabled?: boolean;
  provider?: DecisionProviderId;
  connectionSlug?: string;
  baseUrl?: string;
  model?: string;
  deadlineMs?: number;
  features?: Partial<DecisionLayerFeatureToggles>;
}

/** Patch accepted by `setDecisionLayerSettings`: `null` clears an optional string. */
export interface DecisionLayerSettingsPatch {
  enabled?: boolean;
  provider?: DecisionProviderId;
  connectionSlug?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  deadlineMs?: number;
  features?: Partial<DecisionLayerFeatureToggles>;
}

export const DEFAULT_DECISION_LAYER_SETTINGS: DecisionLayerSettings = {
  enabled: false,
  provider: 'typesafe',
  deadlineMs: DECISION_DEFAULT_DEADLINE_MS,
  // The first three only act when invoked (agent tool call, unparsed verdict, a semantic rule
  // exists); the harness features change what the app does on their own, so they start off.
  features: { decideTool: true, taskVerdicts: true, semanticLabels: true, turnOutcome: false, guardedMode: false, riskBadges: false, automationConditions: false, taskRepairs: false, smartTitles: false, adaptiveThinking: false, midTurnMessages: false, largeResults: false, suggestions: false, subagentModels: false },
};

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function cleanDeadline(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DECISION_DEFAULT_DEADLINE_MS;
  return Math.min(DECISION_MAX_DEADLINE_MS, Math.max(DECISION_MIN_DEADLINE_MS, Math.round(value)));
}

/** Fill defaults, drop garbage. Safe on `undefined`/`null`/partial input. */
export function normalizeDecisionLayerSettings(stored?: DecisionLayerStoredSettings | null): DecisionLayerSettings {
  const source = stored ?? {};
  const defaults = DEFAULT_DECISION_LAYER_SETTINGS;
  const features: DecisionLayerFeatureToggles = { ...defaults.features };
  for (const feature of DECISION_LAYER_FEATURES) {
    const value = source.features?.[feature];
    if (typeof value === 'boolean') features[feature] = value;
  }

  const settings: DecisionLayerSettings = {
    enabled: source.enabled === true,
    provider: isDecisionProviderId(source.provider) ? source.provider : defaults.provider,
    deadlineMs: cleanDeadline(source.deadlineMs),
    features,
  };
  const connectionSlug = cleanString(source.connectionSlug);
  if (connectionSlug) settings.connectionSlug = connectionSlug;
  const baseUrl = cleanString(source.baseUrl);
  if (baseUrl) settings.baseUrl = baseUrl;
  const model = cleanString(source.model);
  if (model) settings.model = model;
  return settings;
}

/**
 * Merge a patch over the stored value. `null` clears an optional string; features merge key-wise.
 * Returns the stored (sparse) shape so unknown future keys on disk are preserved.
 *
 * Changing the provider (directly, or by choosing a connection) drops the
 * `baseUrl` and `model` overrides unless the same patch sets them: they belong
 * to the previous provider, and a stale custom base URL would otherwise
 * receive the new provider's key.
 */
export function mergeDecisionLayerSettings(
  current: DecisionLayerStoredSettings | undefined,
  patch: Partial<Record<keyof DecisionLayerStoredSettings, unknown>>,
): DecisionLayerStoredSettings {
  const next: DecisionLayerStoredSettings = { ...(current ?? {}) };

  const previousProvider = current?.provider ?? DEFAULT_DECISION_LAYER_SETTINGS.provider;
  const providerChanged = isDecisionProviderId(patch.provider) && patch.provider !== previousProvider;
  const connectionChanged = 'connectionSlug' in patch && (cleanString(patch.connectionSlug) ?? undefined) !== current?.connectionSlug;
  if (providerChanged || connectionChanged) {
    delete next.baseUrl;
    delete next.model;
  }

  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (isDecisionProviderId(patch.provider)) next.provider = patch.provider;
  if (typeof patch.deadlineMs === 'number') next.deadlineMs = cleanDeadline(patch.deadlineMs);

  for (const key of ['connectionSlug', 'baseUrl', 'model'] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null || value === '') delete next[key];
    else {
      const cleaned = cleanString(value);
      if (cleaned) next[key] = cleaned;
    }
  }

  if (patch.features && typeof patch.features === 'object') {
    const merged: Partial<DecisionLayerFeatureToggles> = { ...(next.features ?? {}) };
    for (const feature of DECISION_LAYER_FEATURES) {
      const value = (patch.features as Record<string, unknown>)[feature];
      if (typeof value === 'boolean') merged[feature] = value;
    }
    next.features = merged;
  }

  return next;
}

export interface ResolvedDecisionEndpoint {
  provider: DecisionProviderId;
  preset: DecisionProviderPreset;
  baseUrl: string;
  endpoint: string;
  model: string;
  extraHeaders: Record<string, string>;
}

/**
 * Turn settings into a concrete endpoint. `providerOverride` is used when the
 * key comes from an LLM connection (the connection decides the provider).
 * Throws `DecisionError('unconfigured')` for `custom` without a base URL.
 */
export function resolveDecisionEndpoint(settings: DecisionLayerSettings, providerOverride?: DecisionProviderId): ResolvedDecisionEndpoint {
  const provider = providerOverride ?? settings.provider;
  const preset = DECISION_PROVIDER_PRESETS[provider];
  const baseUrl = settings.baseUrl ?? preset.baseUrl;
  if (!baseUrl) {
    throw new DecisionError('unconfigured', 'Decision model: a base URL is required for the custom provider');
  }
  let endpoint: string;
  try {
    endpoint = buildSystemOneEndpoint(baseUrl);
    // eslint-disable-next-line no-new
    new URL(endpoint);
  } catch {
    throw new DecisionError('unconfigured', 'Decision model: the base URL is not a valid URL');
  }
  return {
    provider,
    preset,
    baseUrl,
    endpoint,
    model: settings.model ?? preset.defaultModel,
    extraHeaders: { ...(preset.extraHeaders ?? {}) },
  };
}
