import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('OKMD for Copilot Chat');
  }
  return channel;
}

export function logInfo(message: string, ...args: unknown[]): void {
  getLogger().appendLine(`[INFO] ${format(message, args)}`);
}

export function logWarn(message: string, ...args: unknown[]): void {
  getLogger().appendLine(`[WARN] ${format(message, args)}`);
}

export function logError(message: string, ...args: unknown[]): void {
  getLogger().appendLine(`[ERROR] ${format(message, args)}`);
  console.error(message, ...args);
}

function format(message: string, args: unknown[]): string {
  if (args.length === 0) {
    return message;
  }
  return `${message} ${args
    .map((a) => {
      if (typeof a === 'string') {
        return a;
      }
      if (a instanceof Error) {
        // `JSON.stringify(new Error('x'))` returns `{}` because
        // `message` is non-enumerable. `String(err)` gives the
        // full stack, which is what we want for diagnostics.
        return a.stack ?? a.message ?? String(a);
      }
      return JSON.stringify(a);
    })
    .join(' ')}`;
}
