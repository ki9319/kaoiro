---
title: Grok Build ACP engine
description: Resident ACP host, tools, permissions and unsupported operations.
status: accepted
last_updated: 2026-10-14
---

# Grok Build ACP engine

The `grok` engine requires Grok Build on `PATH`. The wrapper launches
`grok --no-auto-update agent --no-leader stdio` once, initializes one ACP session and
uses `session/prompt` for each queued turn. It does not launch `grok -p`
per turn. The ACP SDK is pinned to 1.8.0.

`--no-leader` overrides `cli.use_leader`: the wrapper must own the backend
whose sandbox environment it sets and whose process group it terminates.
Connecting to a shared leader would break those ownership assumptions.

The server-composed persona and common footer are sent in `session/new`
`_meta.rules`. The kaoiro tools are served by the wrapper's ToolHost as an
HTTP MCP server on `127.0.0.1` and passed as `mcpServers` with a per-run
bearer token (see [Tool transport](#tool-transport)). Grok discovers tools
through its `search_tool` and `use_tool` interfaces.

## Tool transport

`ToolHost` listens on `127.0.0.1` at a free port, one host per `run()`, and
serves the MCP Streamable HTTP protocol statelessly (a fresh MCP server per
request, JSON responses). The `mcpServers` entry is
`{ type: "http", name: "kaoiro", url: "http://127.0.0.1:<port>/mcp",
headers: [{ name: "Authorization", value: "Bearer <token>" }] }`. Grok
connects from its own process, so a sandbox profile that blocks `connect(2)`
on `AF_UNIX` for its child processes (`read-only`) does not stop it; the
earlier stdio bridge was such a child and could not reach the ToolHost under
that profile.

Every request passes these checks in order, using only its request line and
headers, so a rejected request has its body unread. The first failing check
decides the response:

1. `Host` must equal the listener's authority, `127.0.0.1:<port>`, exactly
   (so `localhost` and any other port are refused): 403.
2. A request that carries an `Origin` header, with any value including `null`,
   gets 403. Grok's MCP client sends none.
3. `Authorization: Bearer <token>` must match the token of this ToolHost,
   compared as a constant-time comparison of SHA-256 digests: 401, with
   `WWW-Authenticate: Bearer`.
4. Only `POST /mcp`: 404 for another path, 405 for another method.
5. A `Content-Length` over 1 MiB gets 413 before the body is read; a body
   that passes 1 MiB while it is read (chunked) also gets 413.

The token is 32 random bytes (base64url), created when the ToolHost starts,
held in memory, and used only for that host. It travels in the ACP request's
`headers`, never in the URL: Grok stores MCP server URLs in its session files
(measured), so the URL must not carry a secret. The token is not in the
child's argv or environment, the diagnostic records, status or envelopes.
Closing the ToolHost stops listening, severs every connection and aborts every
call in flight.

Startup fails closed with a reason. After `initialize` the agent must report
`mcpCapabilities.http` ("grok does not support HTTP MCP servers" otherwise).
After `session/new` the host waits until Grok has made one authenticated
`tools/list` call, because on a transport or token fault Grok carries on
without the server and reports nothing ("kaoiro MCP server did not
connect" after 15 s). `waiting_input` is reported only after both.

## ACP module boundary

`wrapper/grok/src/acp/` is engine-neutral so that it can move to
`agent-common` when a second ACP engine arrives. It refers only to ACP
methods and `@agentclientprotocol/sdk` types. Vendor behaviour reaches it
through injection points; Grok's side of each lives in `src/grok/wire.ts`
and `src/grok/events.ts`.

| Injection point | Where | Grok's value |
|---|---|---|
| `session/new` `_meta` | third argument of `AcpSession.open`, passed by value (the host already holds everything it needs; no builder function) | `grokSessionMeta(rules)`, that is `{ rules }` |
| Extra notifications | `AcpExtension.notifications` of `connectAcp`: method, parser and handler per entry. The method must start with `_` (ACP's extension-name convention); any other name, including every ACP method, makes `connectAcp` throw | `_x.ai/session_notification`, handled by the host's turn-completion match |
| Wire-metadata fields | `AcpExtension.wireFields` of `connectAcp` and `metadataTee`: a function from one parsed JSON-RPC line to extra fields, merged after `variant` | `grokWireFields`: `vendor_kind`, `prompt_id`, `request_id`, `hook_event` |

`acp/` itself records `direction`, `method`, `variant`, `sdk_diagnostic` and
`oversized_lines`. With no extension it registers ACP methods only and adds
no vendor fields: an unknown notification is dropped by the SDK. The
extractor must not throw; if it does, that line's metadata is dropped and
the transport is not interrupted. Grok's reads of a prompt result `_meta`
(`promptId`, `cancellationCategory`) are the pure functions `promptIdOf` and
`cancellationKind` in `grok/events.ts`, called by the host, so `acp/` never
sees them.

`test/acp-boundary.test.ts` fails when any file under `src/acp/` names
`_x.ai`, `GROK_`, `grok`, a Grok `_meta` or wire-metadata key
(`promptId`, `requestId`, `prompt_id`, `request_id`, `cancellationCategory`,
`vendor_kind`, `hook_event`), uses `rules` as code, or has a module specifier
that resolves outside `acp/`. The specifiers read are those of imports,
re-exports, `import x = require()`, import types, and `import()` and
`require()` calls; each relative one is resolved from its own file's
directory, and one that is not a string literal counts as outside.

## Capabilities

The adapter supports text turns, conversation continuity while the wrapper
is resident, cancellation, operator permission requests, user questions,
normal peer messages and dispatch confirmation. Early and yield delivery
are explicitly `none`. Reply-basis v1 is not negotiated: Grok MCP calls do
not carry turn-origin identity, so the MCP server cannot prove it.

The launch catalog contains only `default` (account default). Model and
effort switching, attachments, cold resume, history replay, context usage
and quota reporting are unsupported. Unsupported controls reject explicitly.

## Permission projection

Approval decisions are made by grok from the Claude settings it loads;
kaoiro receives the requests grok sends. The launch-fixed approval axis is
projected as `on-request`, as with Claude Code auto mode. This is a declared
projection, not a promise that every call asks the operator.

On Linux, read-only maps to `read-only` and always has effective network
access false, regardless of the raw toggle. Workspace-write with network on
maps to `workspace`; network off is unsupported. Danger-full-access maps to
`off` with effective network true, regardless of the raw toggle. Restrictive
profiles report enforcement `os`; `off` omits the observation's enforcement.
Only `off` is accepted off Linux, where permission switching is unavailable.

Grok's profiles grant temporary directories and Grok state storage writes;
read-only launch rejects a cwd under `/tmp`, `/var/tmp` or the Grok home,
including aliases. The sandbox axis does not promise every system directory
is immutable. See the [dated evidence](../../evidence/grok/2026-10-14-premises.md).

`ext.permission_policy` carries only spawn observations and the selected
profile. A successful inspect carries source names, managed-settings state,
loaded/skipped rule counts and Grok's Claude hooks compatibility cell. Failed,
timed-out or unfamiliar inspect output carries `inspect: unavailable` without
inventing empty sources, zero rules or disabled hooks. This metadata is
operator-only and does not participate in permission decisions.

The wrapper strips inherited `GROK_CLAUDE_*_ENABLED` variables and does not
change HOME or Grok config files. The user's Grok configuration owns Claude
compatibility, including hooks. Hooks can block tools or turn completion;
individual hook verification belongs to the settings repository.

## Permission switching

After the server accepts permission-sync negotiation, the Linux adapter
advertises sandbox and network axes bounded by its initial **raw** launch
pair. Approval remains `on-request`, and permission-mode switching rejects.
The raw ceiling is not widened by normalization: an `off` launch with the
network toggle false cannot switch to workspace-write with the toggle true.

`latest` is the newest operator control; `next` is the server-authorized
selection for the next execution. A turn captures `next` before any restart,
and publishes `applying` only immediately before sending its prompt. A newer
selection cannot relabel a captured execution. The result's native `promptId`
is the `permission_applied.turn_id`; a missing id yields `unknown` and blocks
later dispatch when that submission is still `next`.

When the profile changes, a serialized lane retires the current generation,
closes its ACP connection and HTTP ToolHost, and awaits its owned process
group's exit. It inspects the new policy, starts a loading generation, calls
`initialize` and `session/load` with the same session id and a fresh MCP URL
and bearer token, and waits for authenticated `tools/list`. The new generation
becomes current only after a synchronous failure/abort check. Load replay and
retired-generation callbacks cannot affect turns or permission observations.
Close aborts the lane and waits for every generation it created.

A pre-prompt lane failure leaves the head turn queued and unsent. If its
selection is still `next`, the adapter stops until a valid server relay or
sync supplies `next`; it never guesses a fallback or originates `rolled_back_to`.
It may echo that field as part of a server control adopted through sync.
A persisted unsupported pair is rejected before stopping the resident child,
with `unsupported_permission_pair`. Dispatch waits for an authoritative next
selection while the existing child remains alive.
A refused relay changes `latest` without replacing the previous `next`.
`ext.permission_gate` makes the stop visible. Blocked queued input expires
after 30 seconds with `permission_gate_blocked` and is not resent. A missing
observation requires a newer revision; rejoining with the same revision does
not lift that block.

Every Linux control, including an `off` baseline, has fixed constraints
`{approval: "on-request", enforcement: "os"}`. These constraints describe the
adapter, not an observed execution's badge. Off Linux, the adapter requests
no permission sync and retains its legacy permission/effective display.
Before the first observation, the running generation's profile supplies the
same permission/effective projection as at launch, including after sync
negotiation. This projection does not mark the control applied or create an
observation. After an observation is lost, it does not replace the unknown
execution with a launch projection.

The restart deadline is 30 seconds; authenticated MCP readiness also retains
its 15-second limit. Grok's stored session summary still names the creation
profile after load. The wrapper reports the current generation's profile
instead. Session rules are retained by load and are not resent.

## Upstream gaps and limits

- Claude permission import has no compat switch. Command-text deny matching
  does not cover paths or commands constructed at runtime.
- Generic ACP clients cannot declare permission-prompt capability. Grok's
  classifier can return a denial without asking the client. Escalation
  thresholds seen in older source are not verified against this CLI version.
- `session/set_mode` returned success for an unknown mode in the measured CLI;
  it cannot verify a permission-mode change and is never sent by the adapter.
- Rules supplied on session/load did not replace the original session rules.
- Rate and quota data are not exposed in ACP output.

These are reference notes; no upstream report is part of this work.

## Cancellation and background tasks

On Grok Build 1.0.52, `session/cancel` ends the turn with `cancelled` and
returns the wrapper to `waiting_input`. A foreground shell tool with actual
`block_until_ms: 120000` disappeared after cancel in all six controlled
trials, with and without `--no-leader`. Native acceptance verifies the actual
arguments and asserts foreground-child termination.

A tool moved to the background (`_x.ai/task_backgrounded`) can remain alive
after cancel. Close and wrapper SIGTERM remove active tool children.
The wrapper preserves the resident session and does not discover or kill
tool PGIDs. Background survival is recorded as a vendor behavior; tests do
not assert it because the model chooses whether to background a task.
Per-task cancellation through `_x.ai/task/kill` is tracked in
[issue #594](https://github.com/sakuraiyuta/kaoiro/issues/594).
See the [dated evidence](../../evidence/grok/2026-10-14-premises.md).

## Result text

A successful or interrupted turn's `result.text` is all message text of the
turn, clipped by `clipText` to the `MAX_LOG_BYTES` budget (16,384 bytes), as
Claude Code and Codex clip theirs; how a multi-byte character at the cut is
handled is `clipText`'s contract. A failed or permission-rejected turn has an
empty `result.text`, even when its text already reached the assistant logs.
The result payload has no `truncated` field, so the clip is silent. The
server rejects an envelope over 65,536 bytes without a reply the wrapper reads,
which would lose the whole result envelope. Nothing reads `result.text`; the
reply text reaches the dashboard through the assistant logs.

## State publication

The host sends a `state_change` envelope only when it differs from the last
one it sent in anything but `ts`: the state, the `ext` or the header fields
such as `display_name`. Streamed message and thought chunks keep updating the
machine state but no longer repeat the same `thinking` envelope. The first
`waiting_input` at startup is always sent. The server keeps the latest
`state_change` per agent and the transport re-sends the last one after a
rejoin, so the latest state is unchanged; only the repeats are gone.

## Diagnostics and shutdown

ACP diagnostic records contain bounded method, variant and identifier
metadata, never prompt or tool-result content. SDK diagnostics that include
raw messages are filtered. Unknown variants are counted without emitting
their bodies. Lines above the 4 MiB diagnostic-reader limit pass through
without parsing; only their count is recorded. The SDK owns the protocol
message limit. Normal protocol logs/results still carry display content.

Unexpected ACP closure fails the host and closes its owned child, allowing
the runner to recover the peer. Close aborts ToolHost handlers, closes ACP and stdin, sends SIGTERM to the
owned process group and escalates after 3000 ms, below the runner's 5000 ms
reset grace. Process-signal tests run in an isolated namespace.
