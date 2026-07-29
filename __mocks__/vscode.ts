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
