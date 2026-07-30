/**
 * Regression guard for picker visibility in VS Code 1.120+.
 *
 * Per ADR-0005 (`docs/adr/0005-no-on-did-change-event.md`), the OKMD
 * provider deliberately omits `onDidChangeLanguageModelChatInformation`.
 * Its presence triggers `microsoft/vscode#317414`, which causes the
 * Copilot Chat model picker to mis-render the vendor and hide the
 * provider's models. This test pins the "no EventEmitter" contract
 * so a future contributor cannot silently re-introduce the bug.
 *
 * The remaining assertions (every model has `isUserSelectable: true`,
 * `detail`, `tooltip`) document the NVIDIA NIM Provider parity that
 * the picker still relies on.
 */

jest.mock('vscode');

import { OkmdChatProvider } from '../src/provider';

/**
 * Build a provider with the minimum viable dependencies.  No
 * ExtensionContext, no ModelCache; just enough to test the shape of
 * the provider instance and its model info output. A
 * secret-storage stub is wired so the BYOK `options.configuration`
 * discriminator in the provider has a fallback to consume.
 */
function makeProvider(models: Array<{ id: string; name: string }> = []): OkmdChatProvider {
  return new OkmdChatProvider(
    {
      secrets: {
        get: jest.fn(async () => 'stub-key-for-tests'),
        store: jest.fn(),
        delete: jest.fn(),
      },
      globalState: {
        get: jest.fn(() => undefined),
        update: jest.fn(async () => undefined),
      },
    } as never,
    {
      getModels: () => models,
      getNameById: () => undefined,
      getIdByName: () => undefined,
      onDidChange: jest.fn(),
      refresh: jest.fn().mockResolvedValue(undefined),
    } as never,
  );
}

describe('OkmdChatProvider — picker visibility (NVIDIA NIM parity)', () => {
  test('does NOT expose onDidChangeLanguageModelChatInformation (vscode#317414 guard)', () => {
    const provider = makeProvider();
    // Regression guard for microsoft/vscode#317414. The presence of
    // this EventEmitter causes the LM picker to collapse the vendor
    // label and hide the provider's models in VS Code 1.120+.
    // See docs/adr/0005-no-on-did-change-event.md.
    expect(provider.onDidChangeLanguageModelChatInformation).toBeUndefined();
  });

  test('every returned model has isUserSelectable: true', async () => {
    const provider = makeProvider([
      { id: 'claude-sonnet-4', name: 'claude-sonnet-4' },
      { id: 'gpt-5', name: 'gpt-5' },
    ]);
    // configuration={} drives the BYOK fallback into secret storage,
    // which the stub returns a key for. This is the path VS Code
    // takes when no BYOK key is configured.
    const infos = await provider.provideLanguageModelChatInformation(
      { silent: false, configuration: {} },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as never,
    );
    expect(infos).toHaveLength(2);
    for (const info of infos) {
      expect((info as unknown as Record<string, unknown>).isUserSelectable).toBe(true);
    }
  });

  test('returns models with detail and tooltip fields (NVIDIA NIM parity)', async () => {
    const provider = makeProvider([
      { id: 'claude-sonnet-4', name: 'claude-sonnet-4' },
    ]);
    const infos = await provider.provideLanguageModelChatInformation(
      { silent: false, configuration: {} },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as never,
    );
    expect(infos).toHaveLength(1);
    const info = infos[0] as unknown as Record<string, unknown>;
    expect(info.detail).toBe('OKMD');
    expect(typeof info.tooltip).toBe('string');
  });
});
