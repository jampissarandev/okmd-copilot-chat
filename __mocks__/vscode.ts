/**
 * Manual mock of the `vscode` module for jest.
 *
 * The real `vscode` package is only available inside an Extension
 * Development Host — it is not on `npm` and cannot be `require`d in
 * node. This stub provides the surface that the v1 code uses:
 *
 *   - `LanguageModelError` factories used by `errorMapping.ts`.
 *   - `LanguageModelTextPart` / `LanguageModelToolCallPart` for the
 *     SSE stream parsers.
 *   - `LanguageModelDataPart` for the image-converter path in
 *     `src/converters/openaiToAnthropic.ts`.
 *   - `LanguageModelChatMessageRole` enum used by
 *     `src/provider.ts` `messageRole`.
 *   - `window.createOutputChannel` for `src/logger.ts`.
 *   - `CancellationToken` / `CancellationTokenSource` for
 *     `src/utils/cancellation.ts`.
 *   - `EventEmitter<T>` for `src/modelCache.ts` `_onDidChange`.
 *
 * Tests should not need to pass a `vscode` stub to the code under
 * test for the things covered here; the mock lets the real `import
 * 'vscode'` lines resolve. Code that wants to be exercised without
 * the real `vscode` module (e.g. `errorMapping.ts`) takes an
 * injectable `vscode` parameter — see the `VscodeLike` interface.
 *
 * **Not yet stubbed:** `vscode.lm.registerLanguageModelChatProvider`,
 * `vscode.commands.registerCommand`, `vscode.window.showInputBox`,
 * `vscode.window.showInformationMessage`, `vscode.window.showErrorMessage`.
 * Modules that exercise these (`src/extension.ts`) are not directly
 * tested in the unit suite; the smoke test in `scripts/smoke-test.md`
 * covers them manually.
 */

export class LanguageModelError extends Error {
  readonly code: string;
  private constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
  static NoPermissions(message?: string): LanguageModelError {
    return new LanguageModelError(message ?? '', 'NoPermissions');
  }
  static Blocked(message?: string): LanguageModelError {
    return new LanguageModelError(message ?? '', 'Blocked');
  }
  static NotFound(message?: string): LanguageModelError {
    return new LanguageModelError(message ?? '', 'NotFound');
  }
}

export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
}

export class LanguageModelTextPart {
  constructor(public readonly value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public readonly callId: string,
    public readonly name: string,
    public readonly input: object,
  ) {}
}

/**
 * Stub for `LanguageModelDataPart` — carries raw bytes plus a MIME
 * type. The real 1.104 type exposes static factories
 * (`image`/`json`/`text`); for the v1 converter only the
 * `(data, mimeType)` constructor matters (image path). The fields
 * are public so the converter's `part.data` and `part.mimeType`
 * reads work without any extra plumbing.
 */
export class LanguageModelDataPart {
  constructor(
    public readonly data: Uint8Array,
    public readonly mimeType: string,
  ) {}
  static image(data: Uint8Array, mime: string): LanguageModelDataPart {
    return new LanguageModelDataPart(data, mime);
  }
}

/**
 * Tool-result part. Counterpart to a `LanguageModelToolCallPart`.
 * The mock's constructor takes a `callId` and a content array, matching
 * the real type.
 */
export class LanguageModelToolResultPart {
  constructor(
    public readonly callId: string,
    public readonly content: ReadonlyArray<unknown>,
  ) {}
}

/**
 * Stub for `vscode.window` — the logger uses `createOutputChannel`.
 * Tests that don't need the Output Channel can leave the channel
 * methods as no-ops; tests that want to assert on log output can
 * replace `window` via `jest.requireMock('vscode').window = ...`.
 */
export const window = {
  createOutputChannel(_name: string): { appendLine(_msg: string): void; show(): void } {
    return { appendLine: () => {}, show: () => {} };
  },
};

/**
 * Minimal `CancellationToken` shape used by
 * `cancellationTokenToAbortSignal` in `src/utils/cancellation.ts`.
 * The mock provides a `CancellationTokenSource` so tests can drive
 * the cancel event manually.
 */
export interface CancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export class CancellationTokenSource {
  private listeners: Array<() => void> = [];
  private _isCancellationRequested = false;
  get isCancellationRequested(): boolean {
    return this._isCancellationRequested;
  }
  get token(): CancellationToken {
    const listeners = this.listeners;
    return {
      isCancellationRequested: this._isCancellationRequested,
      onCancellationRequested: (cb: () => void) => {
        listeners.push(cb);
        return { dispose: () => {} };
      },
    };
  }
  cancel(): void {
    if (this._isCancellationRequested) {
      return;
    }
    this._isCancellationRequested = true;
    for (const l of this.listeners) {
      l();
    }
  }
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  };
  fire(data: T): void {
    for (const l of this.listeners) l(data);
  }
  dispose(): void {
    this.listeners = [];
  }
}
