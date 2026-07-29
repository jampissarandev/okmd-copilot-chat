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
 *
 * Tests should not need to pass a `vscode` stub to the code under
 * test for the things covered here; the mock lets the real `import
 * 'vscode'` lines resolve. Code that wants to be exercised without
 * the real `vscode` module (e.g. `errorMapping.ts`) takes an
 * injectable `vscode` parameter — see the `VscodeLike` interface.
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
