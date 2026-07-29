/**
 * Manual mock of the `vscode` module for jest.
 *
 * The real `vscode` package is only available inside an Extension
 * Development Host — it is not on `npm` and cannot be `require`d in
 * node. This stub provides a working `LanguageModelError` surface so
 * that modules that import `vscode` for *type only* (e.g. our
 * `errorMapping.ts` which takes a `VscodeLike` and only uses the real
 * `vscode` as a default) can still be loaded by jest.
 *
 * Tests that exercise the `vscode`-using branches should pass a stub
 * explicitly to the function under test. The `default` export of
 * `errorMapping.ts` is a *fallback* for production code; the test
 * suite should never exercise it.
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

export class LanguageModelToolCallPart {}
