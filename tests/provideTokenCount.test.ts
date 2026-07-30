/**
 * Unit tests for `OkmdChatProvider.provideTokenCount`.
 *
 * Per spec 0001 §Token counting (as updated by issue #18): the v1
 * strategy is a **chars/4 heuristic** — `Math.ceil(text.length / 4)`
 * for plain text, summed across `LanguageModelTextPart`s for a
 * `LanguageModelChatRequestMessage`. Non-text parts (image, tool
 * call, tool result) are skipped. The function returns a
 * `Thenable<number>` per the 1.104 contract.
 *
 * Caveats that this test pins:
 *
 *   - The result is an **approximation**, not a real token count. It
 *     is off by ~30% on non-English text and on code. The function
 *     does not consult OKMD.
 *   - Image, tool-call, and tool-result parts contribute 0 to the
 *     count. A request composed entirely of images returns 0.
 *   - An already-cancelled token makes the returned thenable reject.
 *     The function does no async work, but it must respect the
 *     contract.
 *
 * The tests assert the externally observable contract only: the
 * number returned, and the rejection on cancellation. They do not
 * import or test the implementation file directly.
 */

jest.mock('vscode');

import {
  LanguageModelChatMessageRole,
  LanguageModelDataPart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  type CancellationToken,
  type LanguageModelChatRequestMessage,
} from 'vscode';
import { OkmdChatProvider } from '../src/provider';

/**
 * Build a provider with empty dependencies — the token-count path
 * never touches the model cache, the API, or the secret store.
 */
function makeProvider(): OkmdChatProvider {
  return new OkmdChatProvider({} as never, {} as never);
}

/**
 * A non-cancelled `CancellationToken`. The provider may check
 * `isCancellationRequested` synchronously; the mock exposes it as
 * a plain field.
 */
const notCancelled: CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

const model = {} as never;

// --------------------------------------------------------------------------
// String input
// --------------------------------------------------------------------------

describe('provideTokenCount — string input (chars/4 heuristic)', () => {
  const provider = makeProvider();

  test('short text is rounded up to 1 token', async () => {
    // 2 characters → Math.ceil(2/4) = 1
    const count = await provider.provideTokenCount(model, 'hi', notCancelled);
    expect(count).toBe(1);
  });

  test('empty string returns 0', async () => {
    const count = await provider.provideTokenCount(model, '', notCancelled);
    expect(count).toBe(0);
  });

  test('exact multiple of 4 returns the exact quotient', async () => {
    // 8 characters → Math.ceil(8/4) = 2
    const count = await provider.provideTokenCount(
      model,
      'abcdefgh',
      notCancelled,
    );
    expect(count).toBe(2);
  });

  test('text that does not divide evenly is rounded up', async () => {
    // 9 characters → Math.ceil(9/4) = 3
    const count = await provider.provideTokenCount(
      model,
      'abcdefghi',
      notCancelled,
    );
    expect(count).toBe(3);
  });

  test('1 character returns 1 (rounded up from 0.25)', async () => {
    const count = await provider.provideTokenCount(model, 'a', notCancelled);
    expect(count).toBe(1);
  });
});

// --------------------------------------------------------------------------
// LanguageModelChatRequestMessage input
// --------------------------------------------------------------------------

describe('provideTokenCount — message input (chars/4 heuristic)', () => {
  const provider = makeProvider();

  test('a single text part is counted by length', async () => {
    // 'hello world' is 11 chars → Math.ceil(11/4) = 3
    const message: LanguageModelChatRequestMessage = {
      role: LanguageModelChatMessageRole.User,
      content: [new LanguageModelTextPart('hello world')],
    };
    const count = await provider.provideTokenCount(model, message, notCancelled);
    expect(count).toBe(3);
  });

  test('multiple text parts are summed', async () => {
    // 4 chars + 8 chars = 12 chars → Math.ceil(12/4) = 3
    const message: LanguageModelChatRequestMessage = {
      role: LanguageModelChatMessageRole.User,
      content: [
        new LanguageModelTextPart('abcd'),
        new LanguageModelTextPart('abcdefgh'),
      ],
    };
    const count = await provider.provideTokenCount(model, message, notCancelled);
    expect(count).toBe(3);
  });

  test('image parts do not contribute to the count', async () => {
    // Only the text part (3 chars → 1 token) is counted. The image
    // part is ignored. A 0-token text part would still produce 0
    // because Math.ceil(0/4) === 0, so the test uses a small text
    // part to make the ignoring-assertion non-trivial.
    const message: LanguageModelChatRequestMessage = {
      role: LanguageModelChatMessageRole.User,
      content: [
        new LanguageModelTextPart('abc'),
        new LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png'),
      ],
    };
    const count = await provider.provideTokenCount(model, message, notCancelled);
    expect(count).toBe(1);
  });

  test('tool-call parts do not contribute to the count', async () => {
    // Same idea: 4 chars of text contributes 1 token, the tool call
    // part is ignored.
    const message: LanguageModelChatRequestMessage = {
      role: LanguageModelChatMessageRole.Assistant,
      content: [
        new LanguageModelTextPart('abcd'),
        new LanguageModelToolCallPart('call_1', 'get_weather', { city: 'Bangkok' }),
      ],
    };
    const count = await provider.provideTokenCount(model, message, notCancelled);
    expect(count).toBe(1);
  });

  test('tool-result parts do not contribute to the count', async () => {
    // A user message carrying a tool-result back to the model. The
    // text inside the result is **not** counted (the result is a
    // structured payload, not free-form text), and the empty text
    // part contributes 0. Total: 0.
    const message: LanguageModelChatRequestMessage = {
      role: LanguageModelChatMessageRole.User,
      content: [
        new LanguageModelToolResultPart('call_1', [
          new LanguageModelTextPart('ignored'),
        ]),
        new LanguageModelTextPart(''),
      ],
    };
    const count = await provider.provideTokenCount(model, message, notCancelled);
    expect(count).toBe(0);
  });

  test('empty content array returns 0', async () => {
    const message: LanguageModelChatRequestMessage = {
      role: LanguageModelChatMessageRole.User,
      content: [],
    };
    const count = await provider.provideTokenCount(model, message, notCancelled);
    expect(count).toBe(0);
  });

  test('a message of only an image returns 0', async () => {
    // A non-English-ish case: a request composed entirely of an
    // image (e.g. user pastes a screenshot). The heuristic
    // cannot count image tokens, so it returns 0. The function
    // does not throw.
    const message: LanguageModelChatRequestMessage = {
      role: LanguageModelChatMessageRole.User,
      content: [new LanguageModelDataPart(new Uint8Array(), 'image/png')],
    };
    const count = await provider.provideTokenCount(model, message, notCancelled);
    expect(count).toBe(0);
  });
});

// --------------------------------------------------------------------------
// Cancellation contract
// --------------------------------------------------------------------------

describe('provideTokenCount — cancellation', () => {
  const provider = makeProvider();

  test('rejects when the token is already cancelled', async () => {
    const cancelled: CancellationToken = {
      isCancellationRequested: true,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    };
    // The function does no real async work, but the contract is:
    // a cancelled token must produce a rejected thenable, not a
    // resolved one with a (possibly wrong) number.
    await expect(
      provider.provideTokenCount(model, 'hello', cancelled),
    ).rejects.toBeDefined();
  });
});
