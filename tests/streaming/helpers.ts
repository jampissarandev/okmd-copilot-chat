/**
 * Shared test helpers for the SSE parser test files.
 *
 * The parsers under test consume a `ReadableStream<Uint8Array>` of
 * SSE bytes. Production code uses `makeStreamFromString` from
 * `provider.ts`; tests need the same shape so we centralise it here
 * to avoid drift.
 */

/**
 * Build a `ReadableStream<Uint8Array>` from a string. The whole
 * string is enqueued in a single chunk and the stream is then
 * closed. This matches the shape of `provider.ts`'s
 * `makeStreamFromString` so the parsers see the same input as
 * production code.
 */
export function makeStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/**
 * Drain an async generator into an array. Used by parser tests to
 * assert on the emitted sequence without writing `for await` at
 * every call site.
 */
export async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const part of gen) {
    out.push(part);
  }
  return out;
}

/**
 * Shape used by parser tests to inspect the parts. The real
 * `LanguageModelTextPart` and `LanguageModelToolCallPart` types
 * live in `vscode`; tests assert on the public fields (`value` /
 * `callId` / `name` / `input`) without importing the real types.
 */
export type AnyPart = {
  value?: string;
  callId?: string;
  name?: string;
  input?: object;
};
