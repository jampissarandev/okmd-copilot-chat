/**
 * Snapshot-style tests for the OpenAI → Anthropic request body
 * converter in `src/converters/openaiToAnthropic.ts`.
 *
 * The converter is a pure function — it has no I/O, no clock, no
 * randomness — so the test style is "given this input, expect
 * exactly this output body". Each test asserts on the entire
 * `AnthropicRequestBody` shape (not just one field), so a
 * future regression in any field shows up as a single diff.
 *
 * Spec 0001 §Testing Decisions pins the externally observable
 * contract: the body that ends up on the wire to OKMD's
 * `/messages` endpoint.
 *
 * --- Important note on the issue's acceptance criteria ---
 *
 * Issue #5 ("[tests] openaiToAnthropic converter snapshot suite")
 * was filed against the pre-1.104 code, which extracted
 * `System`-role messages into a top-level `body.system` string.
 * After commit f55c63c (closes #2) the extension was aligned to VS
 * Code 1.104, where `LanguageModelChatMessageRole` no longer has a
 * `System` variant — only `User` and `Assistant`. ADR-0004 codifies
 * that decision: the converter does NOT populate `body.system`
 * because the upstream Copilot never sends a System-role message
 * to a BYOK provider in 1.104+.
 *
 * The test cases below therefore verify the *current* contract:
 *
 *   - `system` is never set on the body.
 *   - All non-assistant messages become `{ role: "user", content }`
 *     (in 1.104, only User and Assistant exist on the wire).
 *   - A future VS Code release that adds a system-prompt channel
 *     will be wired up in this one place.
 */

jest.mock('vscode');

import {
  LanguageModelChatMessageRole,
  LanguageModelDataPart,
  LanguageModelTextPart,
} from 'vscode';
import type { LanguageModelChatRequestMessage } from 'vscode';
import { openaiToAnthropic } from '../../src/converters/openaiToAnthropic';

/**
 * Build a `LanguageModelChatRequestMessage` with the given role and
 * a single text part. Real `vscode.lm` messages have the same shape
 * (role + content: ReadonlyArray<...>), so the converter cannot
 * tell the difference.
 */
function textMessage(
  role: LanguageModelChatMessageRole,
  text: string,
): LanguageModelChatRequestMessage {
  return {
    role,
    content: [new LanguageModelTextPart(text)],
  };
}

function userText(text: string): LanguageModelChatRequestMessage {
  return textMessage(LanguageModelChatMessageRole.User, text);
}

function assistantText(text: string): LanguageModelChatRequestMessage {
  return textMessage(LanguageModelChatMessageRole.Assistant, text);
}

function userImage(
  text: string,
  imageBytes: Uint8Array,
  mimeType: string,
): LanguageModelChatRequestMessage {
  return {
    role: LanguageModelChatMessageRole.User,
    content: [new LanguageModelTextPart(text), new LanguageModelDataPart(imageBytes, mimeType)],
  };
}

describe('openaiToAnthropic — pure text messages', () => {
  test('pure user message → string content, no system field', () => {
    expect(openaiToAnthropic(1, [userText('hello')])).toEqual({
      model: 1,
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      max_tokens: 4096,
    });
  });

  test('assistant message → role: "assistant"', () => {
    expect(openaiToAnthropic(1, [assistantText('hi back')])).toEqual({
      model: 1,
      messages: [{ role: 'assistant', content: 'hi back' }],
      stream: true,
      max_tokens: 4096,
    });
  });

  test('multiple user/assistant messages → preserves order', () => {
    const messages = [
      userText('hi'),
      assistantText('hello'),
      userText('how are you?'),
      assistantText('fine, thanks'),
    ];
    expect(openaiToAnthropic(7, messages)).toEqual({
      model: 7,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'how are you?' },
        { role: 'assistant', content: 'fine, thanks' },
      ],
      stream: true,
      max_tokens: 4096,
    });
  });

  test('multiple text parts in a single message are concatenated', () => {
    // The converter joins text parts within a single message with
    // no separator (i.e. a string join, not `\n\n`). This matches
    // the issue's "stream: true is always set" and pure-text path
    // — the original `openaiToAnthropic` join is `.join('')`, not
    // `.join('\n')`. This test pins that contract.
    const msg: LanguageModelChatRequestMessage = {
      role: LanguageModelChatMessageRole.User,
      content: [new LanguageModelTextPart('hello '), new LanguageModelTextPart('world')],
    };
    expect(openaiToAnthropic(1, [msg])).toEqual({
      model: 1,
      messages: [{ role: 'user', content: 'hello world' }],
      stream: true,
      max_tokens: 4096,
    });
  });
});

describe('openaiToAnthropic — image content', () => {
  test('image part → content is an array of blocks with base64 + media_type', () => {
    // The image bytes are arbitrary — the converter does not
    // inspect them, only base64-encodes them. We pick a 3-byte
    // payload so the expected base64 is short and obviously
    // correct (`AAA=`).
    const bytes = new Uint8Array([0x00, 0x00, 0x00]);
    const out = openaiToAnthropic(1, [userImage('look:', bytes, 'image/png')]);
    expect(out).toEqual({
      model: 1,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look:' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: Buffer.from(bytes).toString('base64'),
              },
            },
          ],
        },
      ],
      stream: true,
      max_tokens: 4096,
    });
  });

  test('the base64 encoding of a known byte sequence matches the converter', () => {
    // Independent pin: known bytes "Man" → "TWFu" in base64 (the
    // classic RFC 4648 example). This is a sanity check on the
    // encoding step, not on the converter's structure.
    const bytes = new Uint8Array([0x4d, 0x61, 0x6e]);
    const out = openaiToAnthropic(1, [userImage('x', bytes, 'image/jpeg')]);
    const blocks = out.messages[0].content as Array<{
      type: string;
      source?: { data: string; media_type: string };
    }>;
    expect(blocks[1].source?.data).toBe('TWFu');
    expect(blocks[1].source?.media_type).toBe('image/jpeg');
  });
});

describe('openaiToAnthropic — system prompt (ADR-0004)', () => {
  test('body.system is never set, even when only one message is supplied', () => {
    // ADR-0004: VS Code 1.104's `LanguageModelChatMessageRole` has
    // no `System` variant. The converter therefore has no
    // System-role messages to extract. The body never has a
    // `system` key.
    const body = openaiToAnthropic(1, [userText('hi')]);
    expect(body).not.toHaveProperty('system');
  });

  test('body.system is never set, even with multiple messages', () => {
    const body = openaiToAnthropic(1, [
      userText('hi'),
      assistantText('hello'),
      userText('again'),
    ]);
    expect(body).not.toHaveProperty('system');
  });
});

describe('openaiToAnthropic — body invariants', () => {
  test('stream is always true', () => {
    expect(openaiToAnthropic(1, [userText('x')]).stream).toBe(true);
  });

  test('max_tokens defaults to 4096', () => {
    expect(openaiToAnthropic(1, [userText('x')]).max_tokens).toBe(4096);
  });

  test('the modelId is forwarded verbatim', () => {
    expect(openaiToAnthropic(42, [userText('x')]).model).toBe(42);
  });

  test('an empty message list produces an empty messages array', () => {
    expect(openaiToAnthropic(1, [])).toEqual({
      model: 1,
      messages: [],
      stream: true,
      max_tokens: 4096,
    });
  });
});
