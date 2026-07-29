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
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
}
