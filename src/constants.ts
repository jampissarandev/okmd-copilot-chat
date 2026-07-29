/**
 * Constants for the OKMD provider.
 *
 * These are the single source of truth for the names that other modules
 * import. Do not inline these strings elsewhere.
 */

export const PROVIDER_ID = 'okmd';
export const PROVIDER_NAME = 'OKMD';
export const PROVIDER_VENDOR = 'OKMD';

export const OKMD_API_BASE_URL = 'https://gen.ai.kku.ac.th/okmd/api/v1';

export const CACHE_KEY_MODEL_LIST = 'okmd.modelList';
export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export const REQUEST_TIMEOUT_MS = 60_000; // 60 seconds (decision 36)
export const RETRY_DELAY_MS = 1_000; // 1 second backoff (decision 37)

/**
 * Hardcoded whitelist of models that are known to support tool calling.
 *
 * If a model name is not in this list, the extension still registers it,
 * but does not flag `toolCalling` in `LanguageModelChatInformation.capabilities`.
 * Future versions may replace this with a runtime probe (decision 3 / D).
 */
export const TOOL_CAPABLE_MODELS: ReadonlySet<string> = new Set([
  'claude-sonnet-4',
  'claude-opus-4',
  'gpt-5',
  'gemini-2.5-pro',
]);
