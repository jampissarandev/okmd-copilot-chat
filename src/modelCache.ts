/**
 * Model-list cache and name → numberId lookup table.
 *
 * See ADR-0002 (id mapping) and ADR-0003 (cache strategy).
 */

import * as vscode from 'vscode';
import { CACHE_KEY_MODEL_LIST, CACHE_TTL_MS } from './constants';
import { logError, logWarn } from './logger';
import { fetchOkmdModels, getOkmdApiKey } from './api';

export interface OkmdModel {
  /**
   * The OKMD model identifier. The upstream `/models` endpoint
   * returns this as a string (e.g. `"claude-sonnet-5"`); the
   * provider key for picker lookups is the `name` field, not
   * the `id`, so the type drift between "what the API gives us"
   * and "what we pass to the request body" is intentional.
   */
  id: string;
  name: string;
  owned_by?: string;
}

export interface CachedModelList {
  fetchedAt: number;
  models: OkmdModel[];
}

export class ModelCache {
  private nameToId: Map<string, string> = new Map();
  private models: OkmdModel[] = [];
  private fetchedAt: number = 0;
  private inFlight: Promise<void> | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;

  private _onDidChange = new vscode.EventEmitter<void>();
  /** Fires when the model list changes (initial load, refresh, etc.) */
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Synchronously load the persisted model list from
   * `globalState` and apply it to the in-memory cache. Returns
   * the loaded cache, or `undefined` if no persisted list
   * exists. Does NOT touch the network.
   *
   * Splitting this out of `activate()` lets `extension.ts`
   * populate the cache before the VS Code LM provider group
   * migration triggers the platform's first
   * `provideLanguageModelChatInformation` call. If the cache
   * is empty when the platform calls, it returns 0 models and
   * the provider group is registered with no models, hiding
   * the vendor from the picker. See ADR-0005.
   *
   * Fire-timing note: `applyModels` (called internally) fires
   * `_onDidChange` synchronously. Any listener attached after
   * `applyPersisted()` returns will not see this fire. Wire
   * listeners on the `ModelCache` instance before calling
   * `applyPersisted()` if you need to observe the initial load.
   */
  applyPersisted(): CachedModelList | undefined {
    const cached = this.context.globalState.get<CachedModelList>(CACHE_KEY_MODEL_LIST);
    if (cached) {
      this.applyModels(cached.models, cached.fetchedAt);
    }
    return cached;
  }

  /**
   * Initialise the cache. If `applyPersisted` was already
   * called, this only refreshes from the network (if stale)
   * and schedules the next periodic refresh. Otherwise it
   * loads from disk first.
   */
  async activate(): Promise<void> {
    if (this.fetchedAt === 0) {
      this.applyPersisted();
    }
    if (this.isStale()) {
      await this.refresh();
    }
    this.scheduleNextRefresh();
  }

  /**
   * Force-refresh the model list. Coalesces concurrent callers.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = (async () => {
      try {
        const apiKey = await getOkmdApiKey(this.context);
        if (!apiKey) {
          throw new Error('API key not configured');
        }
        const models = await fetchOkmdModels(apiKey);
        this.applyModels(models, Date.now());
        await this.context.globalState.update(CACHE_KEY_MODEL_LIST, {
          fetchedAt: this.fetchedAt,
          models: this.models,
        } satisfies CachedModelList);
      } catch (err) {
        logWarn('Model list refresh failed; keeping previous cache', err);
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }

  getModels(): readonly OkmdModel[] {
    return this.models;
  }

  /**
   * Look up a model by its display name (e.g. "claude-sonnet-4").
   * Returns the OKMD model id (a string, e.g. "claude-sonnet-5") used
   * in the request body. Returns `undefined` if the name is not in
   * the cache — the caller should refresh and retry.
   */
  getIdByName(name: string): string | undefined {
    return this.nameToId.get(name);
  }

  isStale(): boolean {
    if (this.fetchedAt === 0) {
      return true;
    }
    return Date.now() - this.fetchedAt > CACHE_TTL_MS;
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this._onDidChange.dispose();
  }

  private applyModels(models: OkmdModel[], fetchedAt: number): void {
    this.models = models;
    this.nameToId = new Map(models.map((m) => [m.name, m.id]));
    this.fetchedAt = fetchedAt;
    this._onDidChange.fire();
  }

  private scheduleNextRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    const elapsed = Date.now() - this.fetchedAt;
    const delay = Math.max(CACHE_TTL_MS - elapsed, 60_000);
    this.refreshTimer = setTimeout(() => {
      this.refresh().catch((err) => {
        logError('Scheduled refresh failed', err);
      });
    }, delay);
  }
}
