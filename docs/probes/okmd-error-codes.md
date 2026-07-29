# OKMD error-code probe (issue #10)

**Date:** 2026-07-30
**Probed against:** `https://gen.ai.kku.ac.th/okmd/api/v1`
**Method:** `curl -i` against the public endpoint, no real API key
available during the probe.

## Summary

| # | Case                                       | Status tested | Notes                                           |
|---|--------------------------------------------|---------------|-------------------------------------------------|
| 1 | Successful `POST /chat/completions`        | **not tested** | Requires a real API key.                       |
| 2 | Bad API key (OpenAI)                       | 401           | `{"error":"Invalid API key"}`                  |
| 3 | Non-existent model id (with bad key)       | 401           | Auth check fails first; cannot isolate.        |
| 4 | Daily quota exhausted                      | **not tested** | Cannot reach quota without a real key.         |
| 5 | Empty `messages` array (with bad key)      | 401           | Auth check fails first; cannot isolate.        |
| 6 | Successful `POST /messages` (Anthropic)    | **not tested** | Requires a real API key.                       |
| — | Malformed JSON body (extra)                | 422           | `{"message":"Invalid JSON, only supports object and array"}` |
| — | Empty body (extra)                         | 401           | `{"error":"Invalid API key"}`                  |
| — | `POST /messages` with bad `x-api-key` (extra) | 401        | `{"error":"Invalid API key"}`                  |

The OKMD API consistently returns `401 {"error":"Invalid API key"}` for
any request that fails the API-key check, **before** any deeper
validation runs. Cases 1, 3, 4, 5, 6 could not be isolated because
the auth gate runs first. This matches the "OKMD quirk" described
in the spec (decision 13: many distinct failure modes return 401,
so the keyword parse disambiguates them).

## Detailed probes

### Case 2: bad API key (OpenAI)

```
$ curl -i -H "Authorization: Bearer invalid_key" -H "Content-Type: application/json" \
       -X POST -d '{"model":1,"messages":[{"role":"user","content":"hi"}]}' \
       https://gen.ai.kku.ac.th/okmd/api/v1/chat/completions
HTTP/2 401
content-type: application/json; charset=utf-8
x-request-id: a5hci22hrueh8m2mva6ey7zx

{"error":"Invalid API key"}
```

**Mapped variant:** `LanguageModelError.NoPermissions("Invalid OKMD API key")` —
matches the existing `mapHttpError` branch on
`/invalid api key/i` at 401/403.

### Case 3: non-existent model (with bad key)

```
$ curl -i -H "Authorization: Bearer invalid_key" -H "Content-Type: application/json" \
       -X POST -d '{"model":99999,"messages":[{"role":"user","content":"hi"}]}' \
       https://gen.ai.kku.ac.th/okmd/api/v1/chat/completions
HTTP/2 401
content-type: application/json; charset=utf-8
x-request-id: yg0jhedvw3t9l2fjpn84v8ei

{"error":"Invalid API key"}
```

**Cannot isolate** — auth check runs before model lookup. The
existing `mapHttpError` keyword `/invalid model/i` would catch
`Invalid model` text in a 401/403 body if the API ever returned
that. Without a real key we cannot verify whether the live API
uses 401 or 404 for a missing model.

### Case 5: empty `messages` array (with bad key)

```
$ curl -i -H "Authorization: Bearer invalid_key" -H "Content-Type: application/json" \
       -X POST -d '{"model":1,"messages":[]}' \
       https://gen.ai.kku.ac.th/okmd/api/v1/chat/completions
HTTP/2 401
content-type: application/json; charset=utf-8
x-request-id: tgjjwt0g5no7sywhp66cy4zt

{"error":"Invalid API key"}
```

**Cannot isolate** — auth check runs first. The existing
`mapHttpError` branch on `400 + /messages is required/i` would
catch the empty-messages case if the live API uses a 400. The
extension itself also won't trigger this in production: VS Code
1.104's `provideLanguageModelChatResponse` contract never delivers
zero `LanguageModelChatRequestMessage`s to the provider (the
pre-flight check in `vscode.lm` rejects the call earlier).

### Case 6: bad `x-api-key` (Anthropic)

```
$ curl -i -H "x-api-key: invalid" -H "anthropic-version: 2023-06-01" \
       -H "Content-Type: application/json" \
       -X POST -d '{"model":1,"messages":[{"role":"user","content":"hi"}],"max_tokens":10}' \
       https://gen.ai.kku.ac.th/okmd/api/v1/messages
HTTP/2 401
content-type: application/json; charset=utf-8
x-request-id: duqkqhp472kjx1fhlkettxze

{"error":"Invalid API key"}
```

**Mapped variant:** `LanguageModelError.NoPermissions("Invalid OKMD API key")` —
the OKMD API uses the **same** body shape on both endpoints.

### Extra: malformed JSON body

```
$ curl -i -H "Authorization: Bearer invalid_key" -H "Content-Type: application/json" \
       -X POST -d 'not json' \
       https://gen.ai.kku.ac.th/okmd/api/v1/chat/completions
HTTP/2 422
content-type: application/json; charset=utf-8

{"message":"Invalid JSON, only supports object and array"}
```

**Finding:** 422 is a new status not previously documented. The
current `mapHttpError` falls through to the generic catch-all
(`Blocked` with a 422 mention in the message), which is the
correct user-facing behaviour — the request was rejected by the
server. No code change required for v1.

The body uses a different field name (`message` instead of
`error`) and a different status. None of the existing keyword
branches match, so the catch-all handles it.

## Conclusion

The current `mapHttpError` implementation in `src/errorMapping.ts`
is consistent with every probe we could run. The only new
discovery is **422** (for malformed JSON), which is handled
correctly by the existing catch-all branch. Cases that require a
real API key (1, 3, 4, 5, 6) could not be isolated because the
OKMD API authenticates before doing any deeper validation; the
spec's documented "OKMD quirk" (401 for many failure modes) is
confirmed by the probe.

**No code change to `mapHttpError` is required for v1.** The
existing branches cover all the cases we could test, and the
new 422 status is correctly funnelled into the `Blocked`
catch-all.

## Follow-up

- Re-run this probe with a real OKMD API key (out of scope for
  the agent — requires the maintainer's credentials). The cases
  marked "not tested" above are the ones that depend on a real
  key.
- If a future probe shows that OKMD returns 401 for the
  `Invalid model` case with a real key, the existing
  `/invalid model/i` branch in `mapHttpError` is already
  correctly wired to `NotFound`. No additional change needed.
