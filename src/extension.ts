/**
 * Extension entry point.
 */

import * as vscode from 'vscode';
import { PROVIDER_ID, PROVIDER_VENDOR } from './constants';
import { ModelCache } from './modelCache';
import { OkmdChatProvider } from './provider';
import { getLogger, logError, logInfo } from './logger';

export function activate(context: vscode.ExtensionContext): void {
  logInfo('Activating OKMD for Copilot Chat');

  const cache = new ModelCache(context);
  const provider = new OkmdChatProvider(context, cache);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(PROVIDER_ID, provider),
    cache,
  );

  // Wire up the manual refresh command.
  context.subscriptions.push(
    vscode.commands.registerCommand('okmd.refreshModelList', async () => {
      try {
        await cache.refresh(provider['fetchModelsFromApi'].bind(provider));
        vscode.window.showInformationMessage(
          `OKMD model list refreshed (${cache.getModels().length} models)`,
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

  // Block on initial cache load so the picker has models immediately.
  cache.activate(provider['fetchModelsFromApi'].bind(provider)).catch((err) => {
    logError('Initial model cache activation failed', err);
  });
}

export function deactivate(): void {
  logInfo('Deactivating OKMD for Copilot Chat');
}
