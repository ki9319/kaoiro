---
title: "Issue #604: Grok kaoiro tools over an authenticated HTTP MCP transport"
status: in_progress
last_updated: 2026-10-14
---

# Issue #604: Grok kaoiro tools over an authenticated HTTP MCP transport

Plan for [issue #604](https://github.com/sakuraiyuta/kaoiro/issues/604), a
work unit 1 defect of [phase 36](phase-36-grok-acp-adapter.md) found while
designing [issue #591](https://github.com/sakuraiyuta/kaoiro/issues/591).
Basis: `develop` db2dd406. `wrapper/grok`, `runner` and `docs` are identical
to c95e4aca, where the measurements below were taken. Grok Build 1.0.52 on
Linux, ACP SDK 1.8.0, MCP TypeScript SDK 1.29.0.

Operator decision D3 = A: land this issue first, with HTTP and a per-run
token. Issue #591 then handles every permission pair, including read-only.

Revision r2 answers design review r1 (must 2, should 2):

- M1: the Host and Origin checks are now part of the HTTP contract.
- M2: the stream and file searches are redone and their scope is narrowed.
- S1: added a test that unauthenticated bodies are never read.
- S2: the generation-guard claim is limited to MCP, with a token-rotation
  test.

## Problem

Under `GROK_SANDBOX=read-only`, seccomp denies `connect(2)` on `AF_UNIX` for
grok's child processes (`EPERM`). The kaoiro MCP bridge (`dist/bridge.js`) is
such a child. It cannot reach the ToolHost unix socket and exits, so a
read-only grok peer has no kaoiro tools. This happens on `session/new` and
on `session/load`. ACP session creation still succeeds, so nothing reports
the failure.

## Measured premises

All measurements use the production `GrokProcess`, `connectAcp` and
`childEnvironment` from `wrapper/grok`. The listener is the MCP SDK `Server`
with a stateless `StreamableHTTPServerTransport` and JSON responses, bound to
`127.0.0.1` on port 0. Token values were never recorded; the records say
which test token arrived, by label. Run records stay with the design review
artifacts and are not committed.

| Id | Premise | Result |
|---|---|---|
| H1 | Grok advertises HTTP MCP | `initialize` returns `mcpCapabilities: {http: true, sse: true}` |
| H2 | Grok reaches a 127.0.0.1 HTTP MCP server under every profile | `server/discover`, `initialize`, `notifications/initialized`, `tools/list` arrive and `tools/list` returns 200 under `workspace`, `read-only` and `off` (`off` from the token runs). This holds for `session/new`, for `session/load` of a session from the same profile, and for `read-only` loading a session created under `workspace`. Two runs of the 8-case matrix gave the same result |
| H3 | The arrivals come from grok's own connection | With nothing listening on the given port, no request arrives and grok logs `tcp connect error` (connection refused) under both profiles |
| H4 | `tools/call` works under `read-only` | One model turn: grok called `kaoiro__probe_marker`. The listener received `tools/call` with the token, and grok reported the call completed. A second run's turn ended without a tool call, so tool selection by the model is not deterministic. The transport is |
| H5 | Grok sends the ACP `headers` on every MCP request | Every request in H2 and H4, including `tools/call`, carried `Authorization: Bearer <token>` |
| H6 | `session/load` uses the headers passed with the load | New session with token T1, then load with T2: every request carries T2 and none carries T1 |
| H7 | Grok does not keep or reuse old headers | Load with no headers after T1 and T2: requests carry no `Authorization`. Load with the old token after rotation (`off`): requests carry the old token and are rejected |
| H8 | Rejection behaviour of grok | On 401, grok sends `server/discover` and `initialize`, then stops: no retry, no `tools/list`. Its stderr has no line naming the server URL or kaoiro, and ACP reports nothing. Session creation succeeds |
| H9 | No test token was detected in the searched outputs (r2 measurement, scope below) | Six runs without a model turn: `read-only` and `workspace`, each with `session/new`, `session/load` with a new token, and `session/load` with a stale token (rejected). No test token in grok's ACP stdout or stderr, or in the searched files |
| H10 | Another local process cannot use the listener | curl and a raw socket, each in a separate process, against a listener that applies the r2 request order. Missing, wrong (32-byte) and 1-byte tokens get 401 for `tools/list` and `tools/call`. Any `Origin` (an external value or `null`) and any `Host` other than the listener authority (`evil.example` and `localhost:<port>`) get 403, even with the correct token. Without a token, a foreign `Origin` gets 403, so 403 takes precedence. With headers sent and the body left unfinished, an unauthenticated request gets 401 in 1 to 2 ms with no body parsed. The old token against a new listener gets 401. Closed ports refuse. Every rejected case has zero handler invocations. The correct token without `Origin` gets 200 |
| H11 | Connection timing | 0.3 to 1.1 s from spawning grok to the first `tools/list` (11 runs with a listener, all profiles) |
| H12 | What grok's MCP client sends | Every grok request had no `Origin`, and `Host` equal to the listener authority `127.0.0.1:<port>`. This holds for `read-only` and `workspace`, `session/new` and `session/load`. Header names: `accept`, `authorization`, `content-length`, `content-type`, `host`, `mcp-method`, `mcp-protocol-version`, `user-agent`. Grok passes the r2 Host and Origin rules unchanged |
| H13 | Grok persists MCP server URLs | A canary placed in an MCP server URL path appeared in the session's `events.jsonl` under `~/.grok/sessions`, and in grok's ACP stdout and stderr. The URL must therefore never carry a secret |

Scope of H9 (r2):

- Streams: each of grok's stdout and stderr is captured whole and searched
  after the run, so a token split across chunks is still found.
  - Synthetic positive control: a 43-character canary split at each of its
    42 positions is found 42 times by the same capture code, in every run.
  - Real positive control for stdout: a canary in the cwd path, which grok
    echoes. It was found in every run.
  - Real positive control for stderr: a canary in the URL of a second MCP
    server on a closed port. Grok logs that URL, and it was found in every
    run.
- Files searched:
  - all of `~/.grok`: 5,106 files read;
  - the probe root: 19 files;
  - files under `$HOME` modified during the runs: 476 read;
  - files under `/tmp` modified during the runs: 11 read.
- Files not searched:
  - Not opened, by constraint: `auth.json` and `settings_cache.json`.
  - Skipped: symlinks (2 under `~/.grok`, 1,381 under `$HOME`, 84 under
    `/tmp`).
  - Over 64 MiB: one file, the grok binary under `~/.grok/downloads`.
  - Unreadable: 153 mode-000 `sandbox-blocked.*` marker files under
    `~/.grok`, and 6 files under `$HOME`.
  - The synced share folder.
- Positive controls for the files:
  - A canary planted in the probe root was found.
  - The cwd and URL canaries were found in grok's own session files and
    logs.
- What this shows: within these files and streams, at the end of these
  runs, no test token was present. It is not proof that grok can never
  write one elsewhere or later.

Which measurements are r1 and which r2:

- r1, with two model turns: H1 to H8, H10 for the token cases, and H11.
- r1's H9 searched the streams per chunk, which misses split tokens. r1's
  H9 is superseded by the r2 measurement above.
- r1's model-turn run (H4) is not re-measured. Its stream search was the
  per-chunk kind, and r2 does not claim it.
- r2, without a model turn: H9, H10 extended with Host, Origin, the
  unfinished body and rotation, H12 and H13.

Not measured, and not relied on: HTTP behaviour on other platforms (the OS
sandbox pairs are Linux-only, ADR-0067), SSE-type MCP, and an `Mcp-Session-Id`
stateful session (grok works with the stateless transport).

## Design

### Transport

`ToolHost.listen()` starts a Node `http` server on `127.0.0.1`, port 0. The
literal IP avoids name resolution and IPv6 differences. The host passes one
ACP MCP server:

```ts
{ type: "http", name: "kaoiro", url: `http://127.0.0.1:${port}/mcp`,
  headers: [{ name: "Authorization", value: `Bearer ${token}` }] }
```

Each authorized POST is handled by a fresh MCP SDK `Server` and a stateless
`StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`,
`enableJsonResponse: true`), the pattern measured in H2. The two handlers
keep the current ToolHost semantics:

- `tools/list` returns the descriptors (name, description, inputSchema).
- `tools/call` looks up the descriptor and runs it with the call signal. The
  call signal combines the active turn signal (unchanged: no active turn
  means an already-aborted signal) with a per-request controller. That
  controller aborts when the HTTP response closes before it finishes,
  replacing the per-socket controller. `params._meta` is still passed to
  `resolveOrigin`, which grok does not set (H4 saw only `progressToken`).
- Stale results keep the existing rules: an aborted `send_to_agent` call is
  discarded and answered `stale_tool_call`. `handoffToolResult` runs at the
  handler's return boundary with a no-op write, as the Claude in-process
  MCP server does (`claude-code/src/inter_agent_sdk.ts`). If the request was
  already aborted, the result is discarded instead.

### Request validation order

Every request goes through these steps in order. Steps 1 to 4 and the
`Content-Length` test of step 5 use only the request line and headers, so no
rejected request has its body read. The first failing step decides the
response.

1. Host: the `Host` header must equal the listener authority,
   `127.0.0.1:<port>`, as an exact string. Otherwise 403. This rejects any
   DNS name, including `localhost`, and any other port.
2. Origin: a request that carries an `Origin` header with any value,
   including `null`, gets 403. Grok's MCP client sends no `Origin` (H12),
   so no value is legitimate. The MCP Streamable HTTP specification
   requires 403 for a present, invalid `Origin`. Here every present
   `Origin` is invalid.
3. Bearer token: see Authentication. Otherwise 401.
4. Method and path: only `POST /mcp`. Otherwise 405 or 404.
5. Size: a `Content-Length` over 1 MiB (the current `MAX_LINE_BYTES`) gets
   413. A body that grows past 1 MiB while it is read is cut off with 413.
6. Only then is the body read, parsed and handed to the SDK transport.

403 comes before 401 because the Host and Origin checks need no secret. A
browser or DNS-rebinding request is refused the same way whether or not it
guessed a token.

The SDK's own `enableDnsRebindingProtection` stays at its default (off). The
check is ours, in one place, for two reasons. The SDK treats an empty
`allowedOrigins` as "skip the check", not "allow none" (review r1, M1). And
one explicit check is simpler to pin with tests than an SDK option plus our
own token check.

`ToolHost.close()` stops listening, calls `closeAllConnections()` and aborts
every in-flight request controller. This keeps the issue #347 property that
no handler result is delivered after shutdown.

### The stdio bridge is removed

`src/bridge.ts`, its `dist/bridge.js` runtime asset and the unix socket are
deleted. The `KAOIRO_BRIDGE_SOCKET` and `KAOIRO_BRIDGE_STDERR_PATH` variables
go with them. Reasons:

- The unix path is the defect: it cannot work under `read-only`.
- The HTTP path works under all three profiles (H2).
- Two transports would double the test matrix and the attack surface for no
  supported case.
- A fallback to the bridge when H1 is missing would start a read-only peer
  without tools again, silently. This design fails closed instead (below).

The Codex and Antigravity bridges are separate packages with their own
`toolhost.ts` and `bridge.ts`, and the Claude host uses the in-process SDK
server. None of them changes. The grok `ToolHost` is private to
`@kaoiro/grok`.

### Authentication

- Token: `randomBytes(32).toString("base64url")`, generated in
  `ToolHost.listen()`. It lives as long as that ToolHost instance and
  is never persisted.
- Lifetime and rotation: one token per ToolHost. In this issue the host
  creates one ToolHost per `run()`, so each run has its own token. Issue
  #591 restarts the grok child and loads the session again. It must create
  a new ToolHost, with a new port and token, for each child generation, and
  close the old one before spawning. H6 and H7 show that `session/load`
  takes the new headers and that grok does not fall back to old ones. A
  late MCP request from the old child then fails at the closed port. If a
  port is reused, it fails with 401, because the old token is refused by
  the new listener (H10).
  - This covers MCP requests only. The issue #591 design review r1, M2,
    also asks for more, and none of it passes through HTTP authentication:
    - The old child's ACP `closed`, `exited`, update, permission and vendor
      notification callbacks must not touch the new generation's state.
      Today `connection.closed` and `process.exited` close the whole host
      (`host.ts` 267-274 and 311-318).
    - Restart and close must be serialized.
  - Those stay in issue #591. This issue adds no restart logic.
- Check: parse `Authorization: Bearer <value>` and compare
  `timingSafeEqual(sha256(value), sha256(token))`. Hashing first gives
  equal-length buffers, so a wrong-length token neither throws nor returns
  early. A missing or malformed header fails the same check.
- Rejection: HTTP 401 with `WWW-Authenticate: Bearer` and the JSON-RPC
  error body `{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"unauthorized"}}`.
  This applies to every method, including `tools/list` and `tools/call`,
  before the MCP layer sees the request. The descriptor handlers are not
  invoked (H10).
- The token travels only in the `session/new` (later also `session/load`)
  params, over the ACP stdin pipe to the wrapper's own child. It is not in
  argv, the environment, the URL, the ACP metadata tee (which keeps only
  allowlisted fields), status, logs or envelopes. Within the scope of H9,
  no token was detected in grok's output or files. The URL must stay free
  of secrets, because grok persists MCP server URLs (H13).

Threat model:

- Before: the unix socket sat in a 0700 directory, so only same-uid
  processes could connect.
- Now: a 127.0.0.1 TCP port is open to every local user and to any local
  client, including browser pages.
- What closes it:
  - The token restores the boundary. A client without the token gets 401
    before any handler runs.
  - The Host and Origin checks refuse browser-originated and DNS-rebinding
    requests independently of the token.
- Out of scope, as before: same-uid processes that can read another
  process's memory.
- Not measured: real browser CORS and preflight behaviour. The design
  relies on the header checks, not on browser behaviour.

### Startup fails closed

Two checks are added to `run()`:

1. After `initialize`, require `agentCapabilities.mcpCapabilities.http ===
   true`. Otherwise fail startup with "grok does not support HTTP MCP
   servers". `AcpSession.open` currently discards the initialize result;
   it returns it instead.
2. After `session/new`, wait until the ToolHost has answered one
   authenticated `tools/list`. Do this inside the existing 30 s startup
   deadline, which already bounds the race (H11 measured at most 1.1 s).
   Otherwise fail startup with "kaoiro MCP server did not connect". H8
   shows why: on any transport or token fault, grok degrades silently, and
   only the listener can tell.

`waiting_input` is reported only after both checks pass. Issue #591 applies
the same wait after each `session/load`.

This changes visible behaviour on one path: a grok peer whose kaoiro MCP
cannot connect used to start without tools. It now fails to start with a
reason. The wrapper's existing startup error path reports the failure.

## Out of scope

- Permission switching and the child restart (issue #591).
- Any change to the server, protocol, dashboard or other engines.
- Model behaviour when choosing tools (H4's second run).

## Verification plan

Tier: code committed to the repo, so the project review flow applies.

### Unit tests (fake grok, `pnpm --filter @kaoiro/grok test`)

The fake agent `test/fixtures/grok.mjs` switches from `StdioClientTransport`
to `StreamableHTTPClientTransport`. It takes the URL and headers from
`mcpServers[0]`. Fixture modes: drop the headers, send a wrong token, never
connect, and omit `mcpCapabilities.http`.

1. A tool round-trips through HTTP. This replaces "round-trips a tool
   through the production stdio bridge", with the same assertions.
2. Startup reaches `waiting_input` only after an authenticated `tools/list`.
   The never-connect, drop-headers and wrong-token modes each fail startup
   with "kaoiro MCP server did not connect" before the deadline.
3. A missing HTTP capability fails startup with its reason.
4. Request validation from another process. A `child_process` sends raw
   HTTP to the ToolHost URL for `tools/list` and `tools/call`. To send the
   correct token, the test reads it through the fixture's side channel
   (unit 10). Each case expects a status, and an invocation count of 0
   unless noted.
   - Correct token, no `Origin`, exact `Host`: 200, one invocation. This is
     the positive control, so a reject-everything ToolHost fails.
   - Correct token with `Origin: https://untrusted.invalid`: 403.
   - Correct token with `Origin: null`: 403.
   - Correct token with `Host: evil.example`: 403.
   - Correct token with `Host: localhost:<port>`: 403.
   - No token, no `Origin`: 401.
   - No token with a foreign `Origin`: 403, which pins the precedence.
   - Wrong token of the same length: 401.
   - Wrong token of a different length: 401.
   - After `close()`: connection refused.
5. Unread body: an unauthenticated request sends its headers with
   `Content-Length: 1000` and leaves the body unfinished. It gets 401 within
   500 ms, with no body read or parsed and no handler. A wrapped body reader
   counts reads, so "not read" is asserted, not inferred. The same applies
   to a foreign `Origin` (403). Measured in H10: 1 to 2 ms, while an
   auth-after-body variant gave no response within 1000 ms.
6. Token rotation: close ToolHost A and open ToolHost B. A's token sent to
   B's URL gets 401 with no handler. B's own token gets 200 (positive
   control). A's port refuses connections.
7. Body over 1 MiB: 413, no handler, in two ways. (a) A `Content-Length` over
   1 MiB: the head alone is sent and the answer comes before any body is read.
   (b) No `Content-Length` (chunked): the body is read and passes 1 MiB while it
   is read. A body longer than its declared `Content-Length` is not a third
   case: Node's HTTP parser rejects the excess itself (measured in design
   review r2).
8. `close()` during an unanswered call aborts the handler's signal, and no
   result is written. This adapts the issue #347 regression test.
9. Turn signal: a call outside a turn sees an aborted signal, and a stale
   `send_to_agent` is answered `stale_tool_call` (existing tests, adapted).
10. Token secrecy. Run a full fake session and capture four surfaces:
    - wrapper stderr: whole byte stream, joined before the search;
    - every envelope sent to the ServerLink;
    - `statusExtSnapshot()` at each state;
    - every metadata-tee record.

    The fixture reports the token it received through a test-only side
    channel file. Assert the token occurs in none of the four. Each surface
    has its own positive control: a canary injected through that surface's
    real path is found by the same search. For stderr, the canary is written
    in two chunks split inside the canary. For envelopes, status and the
    metadata tee, it is a canary value placed in a field that the surface
    carries. A search that misses split values, or skips a surface, fails its
    control.

### Mutations

Run each alone, then run the named tests. Each must turn red. Record the
results.

| Mutation | Expected red |
|---|---|
| T1: pass the stdio-style entry or a wrong port in `mcpServers` | unit 2 and the native test below |
| T2: omit `headers` | unit 2 and the native test |
| A1: authorization check always true | unit 4, unit 6, and the native test's negative controls. Unit 4's positive control keeps a reject-all variant from passing |
| A2: compare only when lengths match, otherwise accept | unit 4 (different-length case) |
| O1: Origin check removed | unit 4 (both Origin cases) and the native Origin case |
| O2: Host check removed | unit 4 (both Host cases) and the native Host case |
| O3: Host check also accepts `localhost:<port>` | unit 4 (`localhost:<port>`) |
| O4: token check before Host/Origin | unit 4 (no token + foreign Origin expects 403) |
| B1: body read before the Host/Origin/token checks | unit 5 |
| K1: one token shared across ToolHost instances | unit 6 |
| R1: readiness wait resolves immediately | unit 2 (never-connect mode) |
| R2: capability check removed | unit 3 |
| L1: body limit removed | unit 7 |
| C1: `close()` without `closeAllConnections()` and aborts | unit 8 |
| LK1: write the token to stderr at startup | unit 10 |
| LK2: test-side stderr search done per chunk | unit 10's split-canary control |

The constant-time comparison itself is not observable in a functional test.
Review checks it.

### Native test (`KAOIRO_LIVE_GROK=1`)

Add `test/native-mcp.test.ts`. It launches the production `GrokHost`
through `nativeRun` with `sandbox: "read-only"`, `network_access: false`,
and without a model turn.

- The host reaches `waiting_input`.
- A test-only getter shows the ToolHost answered at least one authenticated
  `tools/list`. The getter exposes the URL and counters, never the token.
- That `tools/list` passed the r2 Host and Origin rules, which shows grok
  still satisfies them (H12).
- Negative controls from the test process, which has no token, each with
  no handler invocation:
  - No token: 401.
  - A wrong token: 401.
  - No token with `Origin: https://untrusted.invalid`: 403.
  - No token with `Host: evil.example`: 403.
  - After the host closes, the port refuses connections.
- The same case runs under `workspace-write` as the control.

T1, T2, A1, O1 and O2 must turn this test red. The existing live
"native entry" test continues to exercise `tools/call` through a model turn
under the default pair. Read-only `tools/call` is not asserted live, because
model tool choice is not deterministic (H4). The transport is the same
process-level connection in every profile (H2, H5).

### Gates and who runs them

- Implementer:
  - `pnpm --filter @kaoiro/grok typecheck` and `test`
  - the runner release tests (`releaseInstall`)
  - the mutation table
  - the native tests with `KAOIRO_LIVE_GROK=1` on a host with grok signed in
- Implementation reviewer: the full suite in their own worktree, and the
  native read-only test.

## Files and docs to change

- `wrapper/grok`:
  - `src/toolhost.ts`: HTTP and token.
  - `src/host.ts`: the `mcpServers` entry, the capability check and the
    readiness wait.
  - `src/acp/session.ts`: return the initialize result.
  - Delete `src/bridge.ts` and the `dist/bridge.js` entry in
    `package.json` `kaoiro.runtimeAssets`.
  - Tests and `test/fixtures/grok.mjs`.
- `runner/test/releaseFixture.ts` and `runner/test/releaseInstall.test.ts`:
  - Drop the grok `dist/bridge.js` stub.
  - Point the grok row of the runtime-asset test at `dist/build-info.json`,
    which stays declared.
  - Leave the codex and antigravity rows unchanged.
- `docs/reference/engines/grok-acp.md`: replace "stdio MCP bridge" with the
  HTTP transport, the request validation order (Host, Origin, token), the
  fail-closed startup, and the rule that the MCP URL never carries a secret
  (H13). Move the reply-basis
  sentence from "the bridge" to "the MCP server".
- `docs/adr/0067-grok-resident-acp-host.md`: add an amendment. The tool
  transport is now authenticated HTTP MCP, because of the read-only seccomp
  finding. Link this plan.

## Risks

- A future grok that drops HTTP MCP fails startup with a clear reason. It
  does not start without tools.
- Grok could start opening the MCP connection lazily instead of at session
  start. The readiness wait would then fail startup. H2 and H11 show eager
  connection on every path today. The error message names the check, so a
  regression is diagnosable.
- Same-uid memory readers can obtain the token. This is unchanged from the
  unix socket, which any same-uid process could also open.
- The Host and Origin rules are exact. If a future grok sends an `Origin` or
  a different `Host`, its requests get 403 and the readiness wait fails
  startup with its reason. The rules are not loosened silently. The native
  test notices such a change (H12).
