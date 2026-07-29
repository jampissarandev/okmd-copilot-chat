/**
 * Routing table: which model uses which endpoint, and which params it
 * supports. See ADR-0001.
 *
 * The default endpoint is OpenAI-compatible. Names starting with `claude-`
 * are routed to the Anthropic endpoint.
 */

import { TOOL_CAPABLE_MODELS } from './constants';

export type EndpointKind = 'openai' | 'anthropic';

export interface ModelCapabilities {
  endpoint: EndpointKind;
  toolCalling: boolean;
}

export function getCapabilities(modelName: string): ModelCapabilities {
  const endpoint: EndpointKind = modelName.startsWith('claude-') ? 'anthropic' : 'openai';
  return {
    endpoint,
    toolCalling: TOOL_CAPABLE_MODELS.has(modelName),
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
