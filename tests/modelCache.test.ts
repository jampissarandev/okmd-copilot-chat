/**
 * Regression tests for the activation-order race in `ModelCache`.
 *
 * History: the picker was hidden because `cache.activate()` and
 * the API-key migration ran in parallel as fire-and-forget
 * promises. The platform's first `provideLanguageModelChatInformation`
 * call (triggered by the migration) sometimes found the cache
 * empty, so the provider returned 0 models and the provider
 * group was registered with no models. Splitting the disk load
 * out of `activate()` and running it BEFORE the migration is
 * the fix — see ADR-0005.
 *
 * The test pins the new contract: `applyPersisted()` populates
 * the cache synchronously from `globalState`, so a caller that
 * invokes it before the migration has a non-empty cache
 * available immediately.
 */

jest.mock('vscode');

import { CACHE_KEY_MODEL_LIST } from '../src/constants';
import { ModelCache } from '../src/modelCache';

function makeContext(persisted: unknown): {
  globalState: { get: jest.Mock; update: jest.Mock };
  secrets: { get: jest.Mock; store: jest.Mock; delete: jest.Mock };
} {
  return {
    globalState: {
      get: jest.fn((key: string) =>
        key === CACHE_KEY_MODEL_LIST ? persisted : undefined,
      ),
      update: jest.fn(async () => undefined),
    },
    secrets: {
      get: jest.fn(async () => undefined),
      store: jest.fn(),
      delete: jest.fn(),
    },
  };
}

describe('ModelCache — activation order', () => {
  test('applyPersisted populates the cache synchronously from globalState', () => {
    const context = makeContext({
      fetchedAt: 1_000_000,
      models: [
        { id: '1', name: 'claude-sonnet-4' },
        { id: '2', name: 'gpt-5' },
      ],
    });
    const cache = new ModelCache(context as never);

    // The cache starts empty.
    expect(cache.getModels()).toEqual([]);

    // applyPersisted populates it synchronously.
    const loaded = cache.applyPersisted();
    expect(loaded).toBeDefined();
    expect(loaded?.models).toHaveLength(2);
    expect(cache.getModels()).toHaveLength(2);
    expect(cache.getIdByName('claude-sonnet-4')).toBe('1');
    expect(cache.getIdByName('gpt-5')).toBe('2');
  });

  test('applyPersisted returns undefined when globalState is empty', () => {
    const context = makeContext(undefined);
    const cache = new ModelCache(context as never);

    expect(cache.applyPersisted()).toBeUndefined();
    expect(cache.getModels()).toEqual([]);
  });

  test('applyPersisted is idempotent: calling it twice does not duplicate models', () => {
    const context = makeContext({
      fetchedAt: 1_000_000,
      models: [{ id: '1', name: 'claude-sonnet-4' }],
    });
    const cache = new ModelCache(context as never);

    cache.applyPersisted();
    cache.applyPersisted();

    expect(cache.getModels()).toHaveLength(1);
  });

  test('activate() without prior applyPersisted still loads from globalState (legacy callers)', async () => {
    const context = makeContext({
      fetchedAt: 1_000_000,
      models: [{ id: '1', name: 'claude-sonnet-4' }],
    });
    const cache = new ModelCache(context as never);

    await cache.activate();
    expect(cache.getModels()).toHaveLength(1);
  });
});
