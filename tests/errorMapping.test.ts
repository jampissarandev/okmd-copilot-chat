/**
 * Table-driven tests for `mapHttpError`.
 *
 * Per spec 0001 §Testing Decisions: assert the externally observable
 * contract — the `code` (variant) and the user-facing message — never
 * implementation details.
 *
 * The function accepts a `VscodeLike` for testability, so we pass a tiny
 * stub that records which factory was called and the message it was
 * called with.
 */

// `vscode` is not available outside the Extension Development Host; mock
// the module so `errorMapping.ts`'s default import resolves at load time.
jest.mock('vscode');

import { mapHttpError, type VscodeLike, type ErrorEndpoint } from '../src/errorMapping';

type Variant = 'NoPermissions' | 'Blocked' | 'NotFound';

function makeStub(): VscodeLike & {
  calls: Array<{ variant: Variant; message: string }>;
} {
  const calls: Array<{ variant: Variant; message: string }> = [];
  const factory = (variant: Variant) => (message?: string) => {
    const msg = message ?? '';
    calls.push({ variant, message: msg });
    // Mimic the real LanguageModelError: an Error with a `code` field.
    const err = new Error(msg) as Error & { code: string };
    err.code = variant;
    return err;
  };
  return {
    calls,
    LanguageModelError: {
      NoPermissions: factory('NoPermissions'),
      Blocked: factory('Blocked'),
      NotFound: factory('NotFound'),
    },
  };
}

type Case = {
  name: string;
  status: number;
  body: string;
  endpoint: ErrorEndpoint;
  expectVariant: Variant;
  expectMessage: string | RegExp;
};

const cases: Case[] = [
  // --- 401/403 keyword disambiguation (existing, no fix needed) ---
  {
    name: '401 + "Invalid API key" → NoPermissions',
    status: 401,
    body: '{"error": "Invalid API key"}',
    endpoint: 'openai',
    expectVariant: 'NoPermissions',
    expectMessage: 'Invalid OKMD API key',
  },
  {
    name: '403 + "Invalid API key" → NoPermissions',
    status: 403,
    body: 'Invalid API key supplied',
    endpoint: 'anthropic',
    expectVariant: 'NoPermissions',
    expectMessage: 'Invalid OKMD API key',
  },
  {
    name: '401 + "Invalid model" → NotFound (semantic: missing resource)',
    status: 401,
    body: 'Invalid model id',
    endpoint: 'openai',
    expectVariant: 'NotFound',
    expectMessage: 'Invalid OKMD model',
  },
  {
    name: '401 + "reached daily limit" → Blocked',
    status: 401,
    body: 'You have reached daily limit for this model',
    endpoint: 'openai',
    expectVariant: 'Blocked',
    expectMessage: /quota/i,
  },
  {
    name: '401 + no known keyword → NoPermissions (auth-failed fallback)',
    status: 401,
    body: 'unauthorized',
    endpoint: 'openai',
    expectVariant: 'NoPermissions',
    expectMessage: /auth failed.*401/,
  },
  {
    name: '403 + no known keyword → NoPermissions (auth-failed fallback)',
    status: 403,
    body: 'forbidden',
    endpoint: 'anthropic',
    expectVariant: 'NoPermissions',
    expectMessage: /auth failed.*403/,
  },

  // --- 429 / 5xx (existing, no fix needed) ---
  {
    name: '429 → Blocked (rate limit)',
    status: 429,
    body: 'rate limit exceeded',
    endpoint: 'openai',
    expectVariant: 'Blocked',
    expectMessage: /rate limit/i,
  },
  {
    name: '500 → Blocked (server error)',
    status: 500,
    body: 'internal server error',
    endpoint: 'openai',
    expectVariant: 'Blocked',
    expectMessage: /server error.*500/,
  },
  {
    name: '502 → Blocked (bad gateway)',
    status: 502,
    body: 'bad gateway',
    endpoint: 'openai',
    expectVariant: 'Blocked',
    expectMessage: /server error.*502/,
  },
  {
    name: '503 → Blocked (service unavailable)',
    status: 503,
    body: 'try again',
    endpoint: 'anthropic',
    expectVariant: 'Blocked',
    expectMessage: /server error.*503/,
  },
  {
    name: '504 → Blocked (gateway timeout)',
    status: 504,
    body: 'gateway timeout',
    endpoint: 'openai',
    expectVariant: 'Blocked',
    expectMessage: /server error.*504/,
  },

  // --- #11: 400 + "messages is required" → NotFound is wrong ---
  // An empty messages array is a client-side validation failure, not a
  // missing-resource failure. The right variant in 1.104 is whatever the
  // spec documents (see #15): the closest fit is "Blocked" for "the
  // server refused this request" — but 1.104 has no InvalidRequest.
  // Decision (spec 0001 §Error handling): use `Blocked` for client-input
  // errors and `NotFound` ONLY for missing-resource conditions. The
  // message must still tell the user that the provider sent an empty
  // request.
  {
    name: '400 + "messages is required" → Blocked (client-side validation)',
    status: 400,
    body: 'messages is required',
    endpoint: 'openai',
    expectVariant: 'Blocked',
    expectMessage: /empty.*messages|missing.*messages|no messages/i,
  },
  {
    name: '400 + "Messages is required" (capital M) → Blocked',
    status: 400,
    body: 'Messages is required',
    endpoint: 'anthropic',
    expectVariant: 'Blocked',
    expectMessage: /empty|messages/i,
  },
  {
    name: '400 + "messages is required" with extra context → Blocked',
    status: 400,
    body: '{"error": "messages is required (at least 1 message expected)"}',
    endpoint: 'openai',
    expectVariant: 'Blocked',
    expectMessage: /messages/i,
  },

  // --- #15: catch-all for unrecognised statuses ---
  // The "OKMD quirk" 401/403 are handled above. Everything else that
  // doesn't match a known keyword falls into a generic bucket. The 1.104
  // variants are NoPermissions / Blocked / NotFound. Decision: use
  // Blocked for any unrecognised client or server failure (4xx/5xx that
  // didn't match above) and reserve NotFound for the "the resource you
  // asked for does not exist" semantic. The fallback for 4xx in general
  // is Blocked. The fallback for unknown 4xx (e.g. 418) is also Blocked.
  {
    name: '418 unrecognised 4xx → Blocked (catch-all)',
    status: 418,
    body: "I'm a teapot",
    endpoint: 'openai',
    expectVariant: 'Blocked',
    expectMessage: /418.*teapot|OKMD.*418/,
  },
  {
    name: '451 unavailable-for-legal-reasons → Blocked (catch-all)',
    status: 451,
    body: 'unavailable for legal reasons',
    endpoint: 'anthropic',
    expectVariant: 'Blocked',
    expectMessage: /451/,
  },
  {
    name: '408 request-timeout → Blocked (catch-all 4xx, not a known keyword)',
    status: 408,
    body: 'request timeout',
    endpoint: 'openai',
    expectVariant: 'Blocked',
    expectMessage: /408/,
  },
  {
    name: '422 unprocessable entity → Blocked (catch-all)',
    status: 422,
    body: 'unprocessable entity',
    endpoint: 'openai',
    expectVariant: 'Blocked',
    expectMessage: /422/,
  },

  // --- semantic: "Invalid model" really is NotFound ---
  {
    name: '401 + "Invalid model id 99" → NotFound',
    status: 401,
    body: 'Invalid model id 99',
    endpoint: 'openai',
    expectVariant: 'NotFound',
    expectMessage: 'Invalid OKMD model',
  },
];

describe('mapHttpError', () => {
  // The map function also takes a logger for side-effect logging; we
  // pass a no-op in tests so the test process does not depend on a
  // working Output Channel.
  const noLog = () => {};

  for (const c of cases) {
    test(c.name, () => {
      const stub = makeStub();
      const err = mapHttpError(c.status, c.body, c.endpoint, stub, noLog) as Error & {
        code: string;
      };
      // Exactly one factory was called.
      expect(stub.calls).toHaveLength(1);
      expect(err.code).toBe(c.expectVariant);
      if (typeof c.expectMessage === 'string') {
        expect(err.message).toBe(c.expectMessage);
      } else {
        expect(err.message).toMatch(c.expectMessage);
      }
    });
  }

  test('endpoint is only used for logging; behaviour is identical for openai vs anthropic on 4xx', () => {
    const a = makeStub();
    const b = makeStub();
    mapHttpError(418, "I'm a teapot", 'openai', a, noLog);
    mapHttpError(418, "I'm a teapot", 'anthropic', b, noLog);
    expect(a.calls[0]).toEqual(b.calls[0]);
  });
});
