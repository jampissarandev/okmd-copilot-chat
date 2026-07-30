/**
 * Integration tests for picker visibility in VS Code 1.120+.
 *
 * Mirrors the NVIDIA NIM Provider (hidenobunagai/nvidia-nim-provider)
 * pattern. NVIDIA NIM ships `onDidChangeLanguageModelChatInformation`
 * and is selectable with 21K installs, so the #317414 hypothesis
 * is NOT the cause of OKMD's hidden picker; the cause is the
 * activation-order race documented in ADR-0005 and the BYOK
 * `options.configuration` discriminator in
 * `tests/providerByokConfig.test.ts`.
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
  test('exposes onDidChangeLanguageModelChatInformation (NVIDIA NIM pattern)', () => {
    const provider = makeProvider();
    expect(provider.onDidChangeLanguageModelChatInformation).toBeDefined();
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
