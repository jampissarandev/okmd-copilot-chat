/**
 * Convert a vscode.lm request (OpenAI shape) into the Anthropic
 * `/messages` body.
 *
 * vscode.lm shape:  { messages: [{ role, content: string | Part[] }] }
 * Anthropic shape:  { system: string, messages: [{ role, content: ... }] }
 *
 * Per decision 33: if multiple system messages are present, they are
 * concatenated with blank lines. Anthropic's API accepts a single
 * system string.
 */

import type * as vscode from 'vscode';

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export interface AnthropicRequestBody {
  model: number;
  system?: string;
  messages: AnthropicMessage[];
  stream: true;
  max_tokens: number;
}

export function openaiToAnthropic(
  modelId: number,
  vscodeMessages: readonly vscode.LanguageModelChatMessage[],
): AnthropicRequestBody {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const m of vscodeMessages) {
    const role = m.role;
    if (role === vscode.LanguageModelChatMessageRole.System) {
      systemParts.push(messageToText(m));
      continue;
    }
    const anthropicRole: 'user' | 'assistant' =
      role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
    messages.push({ role: anthropicRole, content: messageToBlocks(m) });
  }

  const body: AnthropicRequestBody = {
    model: modelId,
    messages,
    stream: true,
    max_tokens: 4096,
  };
  if (systemParts.length > 0) {
    body.system = systemParts.join('\n\n');
  }
  return body;
}

function messageToText(m: vscode.LanguageModelChatMessage): string {
  // System messages in vscode.lm are always plain text. We can safely
  // extract just the text content.
  return m.content
    .map((part) => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return part.value;
      }
      return '';
    })
    .join('');
}

function messageToBlocks(m: vscode.LanguageModelChatMessage): string | AnthropicContentBlock[] {
  // If the message is pure text, send a string for compatibility with older
  // Claude models. If it has any image parts, send blocks.
  let hasImage = false;
  const blocks: AnthropicContentBlock[] = [];
  for (const part of m.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      blocks.push({ type: 'text', text: part.value });
    } else if (part instanceof vscode.LanguageModelDataPart) {
      hasImage = true;
      const data = Buffer.from(part.data).toString('base64');
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.mimeType,
          data,
        },
      });
    }
  }
  return hasImage ? blocks : blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
}
