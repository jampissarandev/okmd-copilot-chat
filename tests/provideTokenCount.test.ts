/**
 * Unit test for the v1 stub of `provideTokenCount`.
 *
 * Per spec 0001 §Token counting: v1 throws
 * `Error('OKMD token counting is not implemented in v1')` rather
 * than returning a silently-wrong number from a chars/4 heuristic.
 * This test pins that contract. Issue #18 will replace the stub
 * with a real implementation; the test in that ticket will replace
 * this one.
 */

jest.mock('vscode');

import { OkmdChatProvider } from '../src/provider';

/**
 * Build an `OkmdChatProvider` with the minimum viable dependencies.
 * `provideTokenCount` does not touch the model cache, the API, or
 * the secret store, so empty stubs are fine here.
 */
function makeProvider(): OkmdChatProvider {
  // `OkmdChatProvider`'s constructor takes an `ExtensionContext` and
  // a `ModelCache`. The methods we exercise here don't read either,
  // so we pass empty objects cast to the right shape.
  return new OkmdChatProvider({} as never, { onDidChange: jest.fn() } as never);
}

describe('OkmdChatProvider.provideTokenCount (v1 stub)', () => {
  const provider = makeProvider();
  const model = {} as never;
  const token = {} as never;

  // The 1.104 contract accepts either a `string` or a
  // `LanguageModelChatRequestMessage`. v1's stub does not
  // differentiate between them — both paths throw the same
  // "not implemented" error. One test covers the externally
  // observable contract; an internal case-split is not part of
  // the contract.
  test('throws "not implemented" for any input', () => {
    expect(() => provider.provideTokenCount(model, 'hello world', token)).toThrow(
      /not implemented/i,
    );
    const requestMessage = { role: 1, content: [] } as never;
    expect(() => provider.provideTokenCount(model, requestMessage, token)).toThrow(
      /not implemented/i,
    );
  });
});
