/**
 * Routing table: which model uses which endpoint, and which params it
 * supports. See ADR-0001.
 *
 * The default endpoint is OpenAI-compatible. Names starting with `claude-`
 * are routed to the Anthropic endpoint.
 *
 * Tool capability: every OKMD model is reported as `toolCalling: true`.
 * The OKMD gateway forwards tool calls to the underlying model
 * (Claude, GPT-5, Gemini all support tools), so the picker can safely
 * show all 23 models in Agent mode. VS Code 1.120+ filters BYOK
 * models that are not `toolCalling` out of the picker in Agent mode
 * (microsoft/vscode#296786); reporting `true` here is what makes
 * OKMD show up at all. If a future model on the OKMD gateway does
 * not support tools, the dispatch path will log an info line and
 * pass the request through; the upstream will return a 4xx which
 * `mapHttpError` surfaces to the chat UI (see `dispatch` in
 * `provider.ts`).
 */

export type EndpointKind = 'openai' | 'anthropic';

export interface ModelCapabilities {
  endpoint: EndpointKind;
  toolCalling: boolean;
}

export function getCapabilities(modelName: string): ModelCapabilities {
  const endpoint: EndpointKind = modelName.startsWith('claude-') ? 'anthropic' : 'openai';
  return {
    endpoint,
    toolCalling: true,
  };
}

/**
 * Which body parameters the OpenAI endpoint accepts (forwarded as-is from
 * `vscode.lm` options where present).
 */
export const OPENAI_FORWARDED_PARAMS = ['temperature', 'max_tokens', 'stream'] as const;

/**
 * Which body parameters the Anthropic endpoint accepts.
 * Note: `system` is handled separately by the converter, not forwarded.
 */
export const ANTHROPIC_FORWARDED_PARAMS = [
  'temperature',
  'max_tokens',
  'top_p',
  'top_k',
  'stop_sequences',
  'thinking',
  'tools',
  'tool_choice',
  'stream',
] as const;
