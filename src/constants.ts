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

/**
 * Last-resort fallback list for the picker when both `globalState`
 * and the network are unavailable. Mirrors the opencode-copilot-chat
 * `fallbackModels` pattern. The picker surfaces these even before
 * the first successful `/models` fetch so the user is never
 * staring at an empty vendor on a flaky network.
 *
 * MUST stay in sync with whatever the OKMD gateway actually serves.
 * If a model is removed upstream, drop it from this list in the
 * next release or the picker will offer dead options.
 */
export const BUNDLED_FALLBACK_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'claude-sonnet-4', name: 'claude-sonnet-4' },
  { id: 'claude-opus-4', name: 'claude-opus-4' },
  { id: 'gpt-5', name: 'gpt-5' },
  { id: 'gemini-2.5-pro', name: 'gemini-2.5-pro' },
];

export const REQUEST_TIMEOUT_MS = 60_000; // 60 seconds (decision 36)
export const RETRY_DELAY_MS = 1_000; // 1 second backoff (decision 37)

/**
 * Hard ceiling for a single `GET /models` fetch (connect + body).
 * Without this, undici's default `headersTimeout` (300s) can leave
 * the picker stuck for minutes on a hung TCP connection. Mirrors
 * opencode-copilot-chat's `MODEL_LIST_FETCH_TIMEOUT_MS` (issue #78).
 */
export const MODEL_LIST_FETCH_TIMEOUT_MS = 15_000;

/** Max retry attempts after the initial fetch on transient errors. */
export const MODEL_LIST_FETCH_MAX_RETRIES = 3;

/** Base delay for exponential backoff between retries (500ms → 1s → 2s). */
export const MODEL_LIST_FETCH_RETRY_BASE_MS = 500;

/** User-Agent sent on `/models` requests so strict gateways don't drop them. */
export const OKMD_USER_AGENT = 'okmd-for-copilot-chat/0.1.0 VSCode';

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
