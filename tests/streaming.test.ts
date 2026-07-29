/**
 * Integration tests for the streaming contract between
 * `postOkmd` and the SSE parsers.
 *
 * The unit tests for `okmdClient` (in `tests/okmdClient.test.ts`)
 * cover the HTTP boundary: URL, headers, retry, timeout. The
 * unit tests for the parsers (in `tests/streaming/*.test.ts`)
 * cover the SSE-shape contract: feed a fake stream, assert
 * the parts yielded.
 *
 * The tests in this file cover the **seam between the two**:
 * does the parser actually see bytes as they arrive, or does
 * the client buffer them up first? Per spec 0001 §Request
 * lifecycle ("text parts are streamed chunk-by-chunk") and
 * issue #8 ("the user does not see incremental text"), the
 * client must hand the parser the live response body — not a
 * fully-buffered string.
 *
 * The trick is to give `fetch` a mock whose `Response.body` is
 * a `ReadableStream` we control. We can:
 *
 * 1.  Start the request.
 * 2.  Wait until the parser has yielded its first part.
 * 3.  Push the rest of the SSE bytes.
 * 4.  Close the stream.
 *
 * If the client is buffering, step 2 never resolves until
 * step 3 is done. With real streaming, the parser yields as
 * soon as a complete `\n\n`-delimited event arrives — even
 * if the upstream is still pumping.
 */

jest.mock('vscode');
// Override the retry back-off to 0 so any retry triggered by a
// transient mock failure does not add a 1-second wait.
jest.mock('../src/constants', () => {
  const actual = jest.requireActual('../src/constants');
  return {
    ...actual,
    RETRY_DELAY_MS: 0,
  };
});

import { LanguageModelTextPart } from 'vscode';
import { postOkmd } from '../src/okmdClient';
import { parseOpenAiStream } from '../src/streaming/openaiParser';
import { parseAnthropicStream } from '../src/streaming/anthropicParser';

const realFetch = global.fetch;
const notAborted = new AbortController().signal;

afterEach(() => {
  global.fetch = realFetch;
});

/**
 * Build a mock `fetch` that returns a `Response` whose `body`
 * is a `ReadableStream<Uint8Array>` we can push bytes into from
 * the test. The mock also records every call so we can assert
 * on URL/headers if needed.
 *
 * The returned `push(bytes)` enqueues UTF-8 bytes into the
 * stream; `close()` closes it. The stream is not closed
 * automatically — the test controls the timing.
 */
function makeStreamingFetchMock(initialStatus = 200) {
  const encoder = new TextEncoder();
  // We hold the controller in a closure so `push()` can enqueue
  // bytes asynchronously. The consumer's `getReader().read()` is
  // what drives the stream; the test does not need to instrument
  // pulls itself.
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const calls: Array<[string, RequestInit]> = [];
  const fetchMock = jest.fn().mockImplementation((url: string, init: RequestInit) => {
    calls.push([url, init]);
    return Promise.resolve({
      status: initialStatus,
      body,
      // No `text()` / `json()` — the real `Response` has them but
      // the production code does not call them on the streaming
      // path. If the production code accidentally calls `.text()`,
      // the test will throw because `body` is a `ReadableStream`
      // and `.text()` is not defined on this stub.
    } as unknown as Response);
  });
  return {
    fetchMock: fetchMock as unknown as typeof fetch,
    calls,
    push(text: string) {
      if (!controller) {
        throw new Error('push() called before stream start');
      }
      controller.enqueue(encoder.encode(text));
    },
    close() {
      if (!controller) {
        throw new Error('close() called before stream start');
      }
      controller.close();
    },
  };
}

describe('postOkmd → parser: real streaming contract', () => {
  test('postOkmd returns a ReadableStream<Uint8Array> body, not a buffered string', async () => {
    // Pin the new return shape: `bodyStream` is the seam. If the
    // client falls back to a buffered string, this test fails
    // because `bodyStream` will not exist.
    const mock = makeStreamingFetchMock(200);
    global.fetch = mock.fetchMock;

    const res = await postOkmd({
      endpoint: 'openai',
      apiKey: 'k',
      body: {},
      signal: notAborted,
    });

    expect(res.status).toBe(200);
    expect(res.bodyStream).toBeInstanceOf(ReadableStream);
    // The old shape must be gone. This pins the removal of
    // `bodyText` from the return type.
    expect((res as unknown as { bodyText?: string }).bodyText).toBeUndefined();

    // Drain the stream so the test does not leak an open reader.
    mock.close();
  });

  test('parser sees the first text chunk before the upstream finishes', async () => {
    // The acceptance criterion from issue #8: "the first text
    // chunk is yielded to the parser before the upstream fetch
    // has finished". The mock enqueues a single OpenAI SSE
    // event, then waits. If the client is buffering, the parser
    // will not see this event until the mock closes the stream.
    const mock = makeStreamingFetchMock(200);
    global.fetch = mock.fetchMock;

    const res = await postOkmd({
      endpoint: 'openai',
      apiKey: 'k',
      body: {},
      signal: notAborted,
    });

    // The OpenAI SSE shape: each event is `data: <json>\n\n`.
    mock.push('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');

    // Start the parser, then race its iteration against a
    // timeout. If the client is buffering, the parser's first
    // `for await` will block until the stream is closed and
    // the timeout will fire. With real streaming, the parser
    // yields "hello" within milliseconds.
    const parts: string[] = [];
    const parserPromise = (async () => {
      for await (const part of parseOpenAiStream(res.bodyStream, notAborted)) {
        if (part instanceof LanguageModelTextPart) {
          parts.push(part.value);
        }
      }
    })();

    // Wait for the parser to consume the first chunk. Use a
    // short polling loop instead of a fixed sleep so the test
    // does not flake on slow CI.
    const deadline = Date.now() + 1000;
    while (parts.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // At this point the parser has yielded "hello" — the mock
    // has NOT yet closed the stream and has NOT yet pushed
    // [DONE]. If we got here, streaming is real.
    expect(parts).toEqual(['hello']);

    // Now finish the stream: push [DONE] and close. The parser
    // must return cleanly.
    mock.push('data: [DONE]\n\n');
    mock.close();
    await parserPromise;
  });

  test('Anthropic parser sees partial data the same way', async () => {
    // Mirror of the OpenAI test, to pin that the streaming
    // contract holds for both parsers.
    const mock = makeStreamingFetchMock(200);
    global.fetch = mock.fetchMock;

    const res = await postOkmd({
      endpoint: 'anthropic',
      apiKey: 'k',
      body: {},
      signal: notAborted,
    });

    // One Anthropic event: content_block_delta → text "alpha".
    mock.push(
      [
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"alpha"}}',
        '',
        '',
      ].join('\n'),
    );

    const parts: string[] = [];
    const parserPromise = (async () => {
      for await (const part of parseAnthropicStream(res.bodyStream, notAborted)) {
        if (part instanceof LanguageModelTextPart) {
          parts.push(part.value);
        }
      }
    })();

    const deadline = Date.now() + 1000;
    while (parts.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(parts).toEqual(['alpha']);

    mock.push(
      [
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\n'),
    );
    mock.close();
    await parserPromise;
  });

  test('error path: a 4xx response still surfaces the body text to the caller', async () => {
    // The non-streaming error path: the caller (provider.ts)
    // must still be able to read the body text of a 4xx
    // response, because `mapHttpError` inspects the body for
    // keywords. The test pins that the new `bodyStream` shape
    // does not break this — the caller can buffer the stream
    // to text.
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const fetchMock = jest.fn().mockResolvedValue({
      status: 401,
      body,
    } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await postOkmd({
      endpoint: 'openai',
      apiKey: 'k',
      body: {},
      signal: notAborted,
    });

    expect(res.status).toBe(401);
    expect(res.bodyStream).toBeInstanceOf(ReadableStream);

    // Caller-side buffering: drain the stream into text the way
    // `provider.ts` does on the error path. This proves the
    // shape is consumable.
    controller!.enqueue(encoder.encode('Invalid API key'));
    controller!.close();
    const reader = res.bodyStream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toBe('Invalid API key');
  });
});

// Regression pin (issue #8 acceptance): the existing parser
// tests in `tests/streaming/*.test.ts` build their own
// `ReadableStream<Uint8Array>` from a string and never depended
// on the `bodyText` shape. The new tests below drive the same
// parser inputs through `postOkmd`'s `bodyStream` and assert
// the same outputs, so a refactor of `postOkmd` cannot silently
// change the SSE shape the parsers see.

describe('postOkmd.bodyStream feeds the existing parser tests', () => {
  test('parseOpenAiStream yields the same parts on a postOkmd bodyStream', async () => {
    // Mirrors `openaiParser.test.ts` "a single chunk with
    // delta.content emits one text part" but with the bytes
    // arriving through `postOkmd`'s return shape instead of a
    // hand-built stream.
    const mock = makeStreamingFetchMock(200);
    global.fetch = mock.fetchMock;

    const res = await postOkmd({
      endpoint: 'openai',
      apiKey: 'k',
      body: {},
      signal: notAborted,
    });

    const sse = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n';
    mock.push(sse);
    mock.close();

    const parts: string[] = [];
    for await (const part of parseOpenAiStream(res.bodyStream, notAborted)) {
      if (part instanceof LanguageModelTextPart) {
        parts.push(part.value);
      }
    }
    expect(parts).toEqual(['hello']);
  });

  test('parseAnthropicStream yields the same parts on a postOkmd bodyStream', async () => {
    // Mirrors `anthropicParser.test.ts` "a content_block_delta
    // with text_delta emits a text part" with the bytes
    // arriving through `postOkmd`'s return shape.
    const mock = makeStreamingFetchMock(200);
    global.fetch = mock.fetchMock;

    const res = await postOkmd({
      endpoint: 'anthropic',
      apiKey: 'k',
      body: {},
      signal: notAborted,
    });

    const sse = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    mock.push(sse);
    mock.close();

    const parts: string[] = [];
    for await (const part of parseAnthropicStream(res.bodyStream, notAborted)) {
      if (part instanceof LanguageModelTextPart) {
        parts.push(part.value);
      }
    }
    expect(parts).toEqual(['hi']);
  });
});
