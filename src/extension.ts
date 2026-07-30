/**
 * Extension entry point.
 */

import * as vscode from 'vscode';
import { PROVIDER_ID, PROVIDER_NAME, PROVIDER_VENDOR } from './constants';
import { ModelCache } from './modelCache';
import { OkmdChatProvider } from './provider';
import { getLogger, logError, logInfo } from './logger';
import { getOkmdApiKey } from './api';

/**
 * Push the API key from VS Code SecretStorage into the VS Code
 * language model provider group configuration. This mirrors the
 * NVIDIA NIM pattern (hidenobunagai/nvidia-nim-provider) and
 * ensures the key is visible to the VS Code platform when
 * `required: ["apiKey"]` is set in package.json.
 *
 * Returns true on success or if the group already exists.
 */
async function migrateLanguageModelProviderGroup(apiKey: string): Promise<boolean> {
  try {
    await vscode.commands.executeCommand(
      'lm.migrateLanguageModelsProviderGroup',
      {
        vendor: PROVIDER_ID,
        name: PROVIDER_NAME,
        apiKey,
      },
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /already exists/i.test(message);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  logInfo('Activating OKMD for Copilot Chat');

  const cache = new ModelCache(context);
  const provider = new OkmdChatProvider(context, cache);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(PROVIDER_ID, provider),
    cache,
  );

  // Wire up the API-key management command. Unlike the Copilot
  // "Add Models" dialog (whose save is opaque and sometimes fails
  // silently in ExtDev Host), this stores the key directly in
  // `context.secrets` — the same mechanism NVIDIA NIM uses.
  context.subscriptions.push(
    vscode.commands.registerCommand('okmd.manageApiKey', async () => {
      const existing = await context.secrets.get('okmd.apiKey');
      const apiKey = await vscode.window.showInputBox({
        title: 'OKMD API Key',
        prompt: existing
          ? 'Update your OKMD API key'
          : 'Enter your OKMD API key from playground.okmd.or.th → API Platform',
        ignoreFocusOut: true,
        password: true,
        value: existing ?? '',
        placeHolder: 'Enter your OKMD API key...',
      });
      if (apiKey === undefined) {
        return; // user cancelled
      }
      if (!apiKey.trim()) {
        await context.secrets.delete('okmd.apiKey');
        vscode.window.showInformationMessage('OKMD API key cleared.');
        await cache.refresh().catch(() => {});
        return;
      }
      await context.secrets.store('okmd.apiKey', apiKey.trim());
      // Push key to VS Code LM provider group — same as NVIDIA NIM.
      await migrateLanguageModelProviderGroup(apiKey.trim());
      vscode.window.showInformationMessage('OKMD API key saved.');
      // VS Code 1.120+ hides third-party BYOK models from the
      // picker when the provider exposes an
      // `onDidChangeLanguageModelChatInformation` EventEmitter
      // (microsoft/vscode#317414). The OKMD provider therefore
      // does not fire that event; we trigger a refresh by
      // re-running the manual refresh command. The command
      // itself surfaces the model count via an info message, so
      // the user gets feedback without us having to talk to the
      // picker directly. See ADR-0005.
      try {
        await vscode.commands.executeCommand('okmd.refreshModelList');
      } catch {
        // The refresh command logs its own errors; nothing for us
        // to do here.
      }
    }),
  );

  // Wire up the manual refresh command. The cache owns its own
  // I/O (via `fetchOkmdModels` in `api.ts`), so the handler just
  // calls `cache.refresh()` — no bracket-access into the provider.
  // See issue #3.
  context.subscriptions.push(
    vscode.commands.registerCommand('okmd.refreshModelList', async () => {
      try {
        logInfo('[manual-refresh] start');
        await cache.refresh();
        const n = cache.getModels().length;
        logInfo(`[manual-refresh] done — cache now has ${n} models`);
        vscode.window.showInformationMessage(
          `OKMD model list refreshed (${n} models)`,
        );
      } catch (err) {
        logError('Manual refresh failed', err);
        vscode.window.showErrorMessage(`OKMD refresh failed: ${String(err)}`);
      }
    }),
  );

  // Wire up the show-logs command.
  context.subscriptions.push(
    vscode.commands.registerCommand('okmd.showLogs', () => {
      getLogger().show();
    }),
  );

  // Wire up the refresh-tool-capability command (decision 3/D).
  // In v1, this is a no-op placeholder that re-emits the current whitelist.
  context.subscriptions.push(
    vscode.commands.registerCommand('okmd.refreshToolCapability', () => {
      vscode.window.showInformationMessage(
        `OKMD tool-capable list reloaded (${PROVIDER_VENDOR} hardcoded whitelist)`,
      );
    }),
  );

  // NVIDIA NIM Provider's `initializeStoredApiKey` runs the
  // migration AFTER the cache is populated, so the platform's
  // first `provideLanguageModelChatInformation` call (which the
  // migration triggers internally) finds the cache ready. The
  // previous code kicked both off in parallel as fire-and-forget
  // promises, which left a race: if the platform's call won the
  // race, OKMD returned 0 models and the provider group was
  // registered with no models, hiding the vendor from the
  // picker. The correct order is:
  //
  //   1. Load the cache from `globalState` (synchronous on
  //      `cache.applyPersisted`'s call) so any subsequent
  //      platform call has models to return.
  //   2. Migrate the stored API key to the VS Code LM provider
  //      group. This triggers the platform's first
  //      `provideLanguageModelChatInformation` call against the
  //      provider, which now finds the disk cache ready and
  //      returns the model list.
  //   3. Kick off a background refresh to update the cache from
  //      the network (do not block activation on it).
  (async () => {
    try {
      // Step 1 — load the disk cache. `applyModels` populates
      // `cache.models` synchronously, so any caller arriving
      // after this line sees the cache non-empty.
      cache.applyPersisted();
      logInfo(
        `[activate:step1] disk cache loaded: ${cache.getModels().length} models`,
      );

      // Step 2 — migrate the API key. The platform's
      // `lm.migrateLanguageModelsProviderGroup` command is
      // synchronous-ish: it activates the provider and calls
      // `provideLanguageModelChatInformation` once with the
      // configuration. We want that call to find the cache
      // populated.
      const apiKey = await getOkmdApiKey(context);
      if (apiKey) {
        logInfo('[activate:step2] migrating API key to LM provider group');
        const migrated = await migrateLanguageModelProviderGroup(apiKey);
        logInfo(`[activate:step2] migration result: ${migrated ? 'ok' : 'skipped'}`);
      } else {
        logInfo(
          '[activate:step2] no API key yet — vendor will show in picker but as 0 models until user adds key',
        );
      }

      // Step 3 — schedule the background refresh. This updates
      // the cache from the network and does not block startup.
      logInfo('[activate:step3] starting background network refresh');
      await cache.activate().catch((err) => {
        logError('Background model cache refresh failed', err);
      });
      logInfo(
        `[activate:done] cache has ${cache.getModels().length} models`,
      );
    } catch (err) {
      logError('Initial activation sequence failed', err);
    }
  })();
}

export function deactivate(): void {
  logInfo('Deactivating OKMD for Copilot Chat');
}
