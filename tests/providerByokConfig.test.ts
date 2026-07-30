/**
 * Tests for the BYOK `options.configuration` discriminator in
 * `OkmdChatProvider.provideLanguageModelChatInformation`.
 *
 * Background: in VS Code 1.104+, the user configures the API key
 * via the Copilot "Add Models" dialog. VS Code then calls
 * `provideLanguageModelChatInformation` with
 * `options.configuration.apiKey` set. Without the discriminator
 * we miss this path and either:
 *   - return [] (when secret storage is empty), and the vendor
 *     stays hidden in the picker; or
 *   - fall through to secret storage and miss the BYOK key.
 *
 * Mirrors the opencode-copilot-chat `getConfiguredApiKey` pattern.
 * See ADR-0005 (activation order) and the model-visibility
 * investigation behind the diagnostic
 * `[OKMD] provideLanguageModelChatInformation() — returning 23 models`.
 */

jest.mock('vscode');

import { OkmdChatProvider } from '../src/provider';

function makeCache(
  models: ReadonlyArray<{ id: string; name: string }> = [],
): {
  getModels: jest.Mock;
  getIdByName: jest.Mock;
  refresh: jest.Mock;
  onDidChange: jest.Mock;
} {
  const nameToId = new Map(models.map((m) => [m.name, m.id]));
  return {
    getModels: jest.fn(() => models),
    getIdByName: jest.fn((name: string) => nameToId.get(name)),
    refresh: jest.fn(async () => undefined),
    onDidChange: jest.fn(),
  };
}

function makeContext(apiKeyFromSecrets?: string): {
  secrets: { get: jest.Mock; store: jest.Mock; delete: jest.Mock };
  globalState: { get: jest.Mock; update: jest.Mock };
} {
  return {
    secrets: {
      get: jest.fn(async () => apiKeyFromSecrets),
      store: jest.fn(),
      delete: jest.fn(),
    },
    globalState: {
      get: jest.fn(() => undefined),
      update: jest.fn(async () => undefined),
    },
  };
}

function notCancelled() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
}

describe('OkmdChatProvider — BYOK configuration discriminator', () => {
  test('returns [] when no API key (neither BYOK nor secret storage)', async () => {
    const cache = makeCache([{ id: '1', name: 'claude-sonnet-4' }]);
    const context = makeContext(undefined);
    const provider = new OkmdChatProvider(context as never, cache as never);

    const infos = await provider.provideLanguageModelChatInformation(
      { silent: false } as never,
      notCancelled() as never,
    );

    expect(infos).toEqual([]);
    // Should NOT have triggered a network refresh — the cache
    // is already populated, and the failure is "no key", not
    // "no models".
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test('uses BYOK apiKey from options.configuration when present', async () => {
    const cache = makeCache([{ id: '1', name: 'claude-sonnet-4' }]);
    const context = makeContext('secret-storage-key-should-be-ignored');
    const provider = new OkmdChatProvider(context as never, cache as never);

    const infos = await provider.provideLanguageModelChatInformation(
      {
        silent: false,
        configuration: { apiKey: 'byok-key-from-vscode' },
      } as never,
      notCancelled() as never,
    );

    expect(infos).toHaveLength(1);
    // The apiKey is embedded on the model info so VS Code can
    // route BYOK requests without re-prompting.
    expect((infos[0] as unknown as { apiKey?: string }).apiKey).toBe(
      'byok-key-from-vscode',
    );
    // Should not have probed secret storage at all.
    expect(context.secrets.get).not.toHaveBeenCalled();
  });

  test('returns [] when configuration is undefined (VS Code still resolving)', async () => {
    // Mirrors opencode-copilot-chat's `configuration=undefined` branch:
    // VS Code is still resolving, so we return [] and let the
    // platform re-query us once the BYOK flow completes. Probing
    // secret storage here would race the platform's call.
    const cache = makeCache([{ id: '1', name: 'claude-sonnet-4' }]);
    const context = makeContext('secret-storage-key');
    const provider = new OkmdChatProvider(context as never, cache as never);

    const infos = await provider.provideLanguageModelChatInformation(
      // configuration is undefined → VS Code is still resolving.
      { silent: false } as never,
      notCancelled() as never,
    );

    expect(infos).toEqual([]);
    // Should NOT have probed secret storage — we are waiting for
    // VS Code to come back with a real configuration.
    expect(context.secrets.get).not.toHaveBeenCalled();
  });

  test('falls back to secret storage when BYOK configuration has no apiKey', async () => {
    const cache = makeCache([{ id: '1', name: 'claude-sonnet-4' }]);
    const context = makeContext('secret-storage-key');
    const provider = new OkmdChatProvider(context as never, cache as never);

    // VS Code 1.126+ sometimes sends an empty configuration
    // object for non-BYOK providers. We must fall through to
    // secret storage in that case (opencode-copilot-chat does
    // the same).
    const infos = await provider.provideLanguageModelChatInformation(
      { silent: false, configuration: {} } as never,
      notCancelled() as never,
    );

    expect(infos).toHaveLength(1);
    expect((infos[0] as unknown as { apiKey?: string }).apiKey).toBe(
      'secret-storage-key',
    );
  });

  test('ignores non-string apiKey in BYOK configuration', async () => {
    const cache = makeCache([{ id: '1', name: 'claude-sonnet-4' }]);
    const context = makeContext('secret-storage-key');
    const provider = new OkmdChatProvider(context as never, cache as never);

    // Defensive: VS Code could send a number/null/object in the
    // configuration object; we should treat it as "no key"
    // and fall back.
    const infos = await provider.provideLanguageModelChatInformation(
      {
        silent: false,
        configuration: { apiKey: 12345 as unknown as string },
      } as never,
      notCancelled() as never,
    );

    expect(infos).toHaveLength(1);
    expect((infos[0] as unknown as { apiKey?: string }).apiKey).toBe(
      'secret-storage-key',
    );
  });

  test('returns bundled fallback models when cache is empty and refresh fails (3-tier fallback)', async () => {
    // The opencode-copilot-chat 3-tier fallback:
    //   1. cache.getModels()  ← synchronous, free
    //   2. network refresh    ← when cache is empty
    //   3. bundled fallback   ← when network fails too
    //
    // The provider should NEVER show an empty picker just because
    // the network is flaky. The bundled list keeps the vendor
    // visible so the user can at least try a known model.
    const cache = {
      getModels: jest.fn(() => []),
      getIdByName: jest.fn(),
      refresh: jest.fn(async () => {
        throw new Error('network down');
      }),
      onDidChange: jest.fn(),
    };
    const context = makeContext('secret-storage-key');
    const provider = new OkmdChatProvider(context as never, cache as never);

    const infos = await provider.provideLanguageModelChatInformation(
      { silent: false, configuration: {} } as never,
      notCancelled() as never,
    );

    // The bundled list is exposed (not the empty array the cache
    // produced). Each entry is a LanguageModelChatInformation
    // that VS Code can render in the picker.
    expect(infos.length).toBeGreaterThan(0);
    for (const info of infos) {
      expect((info as unknown as Record<string, unknown>).isUserSelectable).toBe(true);
    }
  });

  test('prefers cached models over bundled fallback', async () => {
    // When the cache already has a model, the bundled fallback
    // must NOT be appended on top — that would double-register
    // models and break the "23 unique models" invariant the user
    // expects to see in the picker.
    const cache = makeCache([{ id: 'cached-only', name: 'cached-only' }]);
    const context = makeContext('secret-storage-key');
    const provider = new OkmdChatProvider(context as never, cache as never);

    const infos = await provider.provideLanguageModelChatInformation(
      { silent: false, configuration: {} } as never,
      notCancelled() as never,
    );

    // Exactly one model, and it is the cached one — not bundled.
    expect(infos).toHaveLength(1);
    expect(infos[0].id).toBe('okmd/cached-only');
  });
});
