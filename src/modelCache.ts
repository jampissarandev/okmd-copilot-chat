/**
 * Model-list cache and name → numberId lookup table.
 *
 * See ADR-0002 (id mapping) and ADR-0003 (cache strategy).
 */

import * as vscode from 'vscode';
import { CACHE_KEY_MODEL_LIST, CACHE_TTL_MS } from './constants';
import { logError, logWarn } from './logger';

export interface OkmdModel {
  id: number;
  name: string;
  owned_by?: string;
}

export interface CachedModelList {
  fetchedAt: number;
  models: OkmdModel[];
}

export class ModelCache {
  private nameToId: Map<string, number> = new Map();
  private models: OkmdModel[] = [];
  private fetchedAt: number = 0;
  private inFlight: Promise<void> | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Initialise the cache from disk and start the background refresh loop.
   */
  async activate(initialFetch: () => Promise<OkmdModel[]>): Promise<void> {
    const cached = this.context.globalState.get<CachedModelList>(CACHE_KEY_MODEL_LIST);
    if (cached) {
      this.applyModels(cached.models, cached.fetchedAt);
    }
    if (this.isStale()) {
      await this.refresh(initialFetch);
    }
    this.scheduleNextRefresh();
  }

  /**
   * Force-refresh the model list. Coalesces concurrent callers.
   */
  async refresh(fetcher: () => Promise<OkmdModel[]>): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = (async () => {
      try {
        const models = await fetcher();
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
   * Returns the numeric id used by the OKMD API.
   */
  getIdByName(name: string): number | undefined {
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
  }

  private applyModels(models: OkmdModel[], fetchedAt: number): void {
    this.models = models;
    this.nameToId = new Map(models.map((m) => [m.name, m.id]));
    this.fetchedAt = fetchedAt;
  }

  private scheduleNextRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    const elapsed = Date.now() - this.fetchedAt;
    const delay = Math.max(CACHE_TTL_MS - elapsed, 60_000);
    this.refreshTimer = setTimeout(() => {
      this.refresh(this.fetchFromApi.bind(this)).catch((err) => {
        logError('Scheduled refresh failed', err);
      });
    }, delay);
  }

  /**
   * Standalone fetch from the OKMD API. The `refresh()` method owns the
   * coalescing; this is just the I/O.
   */
  private async fetchFromApi(): Promise<OkmdModel[]> {
    const apiKey = await this.context.secrets.get('okmd.apiKey');
    if (!apiKey) {
      throw new Error('API key not configured');
    }
    const res = await fetch(`${require('./constants').OKMD_API_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`GET /models failed: ${res.status}`);
    }
    const data = (await res.json()) as { data: OkmdModel[] };
    return data.data;
  }
}
