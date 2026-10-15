---
title: Phase 36 — Grok Build adapter (fourth engine, resident ACP host)
description: Add Grok Build as engine `grok` — wrapper/grok package hosting a resident `grok agent stdio` child over the Agent Client Protocol, kaoiro tools through an authenticated HTTP MCP server, persona through `_meta.rules`, a declared permission projection with display-only policy details, and the closed-set wiring across protocol, runner, server and dashboard.
status: in_progress
phase: 36
depends_on: [phase-34-antigravity-adapter]
related: [issue-589, issue-590, issue-591, issue-592, issue-593, issue-594, issue-597, issue-604, issue-628]
last_updated: 2026-10-15
---

# Phase 36 — Grok Build adapter (fourth engine, resident ACP host)

Tracking: [issue #589](https://github.com/sakuraiyuta/kaoiro/issues/589)
(work units [#590](https://github.com/sakuraiyuta/kaoiro/issues/590) to
[#593](https://github.com/sakuraiyuta/kaoiro/issues/593)). Basis: kaoiro
`develop` 64aa00ae. Grok Build 1.0.52. The premise measurements are summarised
in the issue #589 comment "Premise measurements"; work unit 1 moves them to
`docs/evidence/grok/` in general form.

## Problem and rationale

Grok Build speaks ACP natively (`grok agent stdio`). Unlike `grok -p`, ACP
keeps one resident session with multi-turn, cancel, permission requests, MCP
injection and resume in one protocol. Its stream-JSON headless output is the
same ACP session update stream, so nothing is gained by spawning `-p` per
turn.

## Options

| Option | Decision |
|---|---|
| A. `grok -p --output-format streaming-json` per turn, `--resume` between turns | Rejected. Process start per turn (MCP init about 1 s plus session setup), no permission round trip, interrupt only by killing the process |
| B. Resident `grok agent stdio`, one ACP session | Chosen. Measured: multi-turn, `session/cancel` about 5 ms, MCP tools, `_meta.rules`, OS sandbox via `GROK_SANDBOX`, SIGTERM cleanup |
| C. Generic ACP engine first, Grok as a profile | Deferred. One ACP engine does not tell us which parts are generic. Keep the ACP client a separable module and extract it when a second ACP engine arrives |
| D. `@agentclientprotocol/sdk` instead of a hand-written JSON-RPC client | Chosen: the SDK, pinned to 1.8.0. A compatibility probe against grok 1.0.52 passed all six items without raw JSON-RPC (`session/new` with `_meta`, prompt result `_meta`, `_x.ai/session_notification` through `onNotification`, `session/set_config_option` with a plain string, `session/request_permission`, `session/cancel`). Use the `acp.client(...)` API; `ClientSideConnection` is deprecated in 1.8.0. Constraint: a `session/update` variant unknown to the SDK's zod schema is dropped with only a console error, so the transport stream gets a tee that parses each line and records only bounded metadata (JSON-RPC method, `sessionUpdate` variant name, counts), never message content. The SDK's own diagnostic for a dropped variant prints the whole notification, so the wrapper routes SDK console output through a filter that drops it and keeps only the metadata count (check first whether the SDK accepts an injected logger) |

## Scope (work unit 1, issue #590)

Package `wrapper/grok` (`@kaoiro/grok`), engine id `grok`, plus every closed
engine set (protocol `EngineKind`, delivery policy, runner spawn and session
dispatch, config and behaviour registries, supervisor checks, server channel
sets, release manifest and verifier, package test registry). The implementer
enumerates them from the Antigravity landing and reports the list before
editing.

Module layout:

| Module | Responsibility |
|---|---|
| `acp/connection.ts` | `@agentclientprotocol/sdk` client over the child's stdio, with a stream tee that records method and variant metadata only (no content) and counts SDK-dropped variants; lines above the 4 MiB metadata limit pass through without metadata, under the SDK's own message limit. Engine-neutral: vendor behaviour enters only through the `AcpExtension` argument of `connectAcp` (extra `_`-prefixed notifications and a wire-metadata field extractor) |
| `acp/session.ts` | `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/set_config_option`; engine-neutral ACP only. `open` takes the `session/new` `_meta` as an injected value |
| `grok/process.ts` | Spawn `grok --no-auto-update agent --no-leader stdio` in its own process group with the env below; SIGTERM, grace, SIGKILL of the owned group only |
| `grok/events.ts` | ACP `session/update` to common `AdapterEvent`, log and result; `turnCompletion` (the `_x.ai` `turn_completed` match), `promptIdOf` and `cancellationKind` (Grok's `_meta` keys) as pure functions |
| `grok/wire.ts` | Everything Grok injects into `acp/`: the `_x.ai/session_notification` registration, the `session/new` `_meta` value (`{ rules }`), and the extractor for the Grok wire-metadata fields (`vendor_kind`, `prompt_id`, `request_id`, `hook_event`) |
| `host.ts` | `EngineAdapter`, turn queue, state, capability flags |
| `cli.ts` | Composition root (config, server connection, persona wait, brokers, ToolHost, shutdown), following the Antigravity package |

Child environment: `GROK_SANDBOX` from the sandbox axis. The inherited
`GROK_CLAUDE_{SKILLS,RULES,AGENTS,MCPS,HOOKS}_ENABLED` variables are removed
from the child env, so grok's own `config.toml` alone decides which Claude
assets grok loads (env would otherwise override it; measured with
`GROK_CLAUDE_HOOKS_ENABLED=false`). `GROK_CONFIG` may carry model and effort
defaults. `HOME` is not changed: grok's shell tools inherit it, and git, ssh
and gh need the real one.

Mapping:

| kaoiro | grok / ACP | Evidence |
|---|---|---|
| `run(prompt?)` | spawn, `initialize`, `session/new` with `cwd`, `mcpServers: [kaoiro HTTP MCP server]`, `_meta.rules` = server-composed persona and footer | measured |
| `send(text)` | queue, then `session/prompt`; resolve the turn on the response `stopReason` | measured |
| `interrupt()` | `session/cancel`; the pending prompt resolves with `cancelled` | measured, about 5 ms |
| turn outcome | `stopReason: "cancelled"` is returned both for an interrupt and for a rejected permission; the wrapper distinguishes them by `_meta.cancellationCategory` (`MidTurnAbort` / `PermissionRejected`) and reports an operator reject as a rejection, not an interrupt | measured (SDK probe) |
| `close()` / SIGTERM | close stdin, SIGTERM to the process group, SIGKILL after a grace below the runner's 5000 ms reset escalation | measured: tool child gone within 5 s after SIGTERM |
| kaoiro tools | the wrapper's ToolHost, served as an authenticated HTTP MCP server on `127.0.0.1` ([issue #604](https://github.com/sakuraiyuta/kaoiro/issues/604)), as `mcpServers[0]`; the model reaches it via grok's `search_tool` and `use_tool` as `kaoiro__<tool>` | measured with a probe server under every sandbox profile; the production ToolHost path is acceptance item 2 |
| state | `session/update` chunks and tool calls to running states; `_x.ai/session_notification` `turn_completed` to `waiting_input`; `pending_interaction` kind `permission` to `waiting_permission` only when a `session/request_permission` is actually outstanding | observed; acceptance item 1 records it |
| turn identity | `session/prompt` result `_meta.promptId` (equal to `requestId`); the matching `_x.ai/session_notification` `turn_completed.prompt_id` | measured: equal on all 16 recorded turns |
| tool-call origin | grok's MCP `tools/call` carries only `_meta.progressToken`; no turn or session identity | measured |
| model / effort | catalog from `initialize` `_meta.modelState`, selection from `session/new` and `session/load` `configOptions`; live switching through `session/set_config_option` (work unit 4) | measured, see the [unit 4 evidence](../evidence/grok/2026-10-15-unit4-premises.md): the switch applies at once, also inside a running turn, and the selection lives in the session |
| context | `ext.context` from the last `response_completed` prompt size (work unit 4) | measured against the TUI `/context`, same evidence |
| cold resume and session discovery | `session/resume` in the wrapper's first lane; the runner pages `session/list {cwd}` in a short-lived grok (work unit 3a) | measured, see the [resume evidence](../evidence/grok/2026-10-15-resume-and-discovery.md) |
| rate limits, attachments, history replay | capability false or field omitted | — |

### Unsupported operations

Each is declared, not silently defaulted, and has a negative control:

- `setPermissionMode` rejects. Unit 2 applies `setPermission` through a child
  restart and `session/load`; the result supplies the observed turn id.
- `setModel` and `setEffort` reject only when Grok lists no configuration
  options (work unit 4 supports them otherwise).
- `send(text, attachmentIds)` with attachments rejects.
- `delivery_modes`: `early: "none"`, `yield: "none"`, stated explicitly
  (absence would mean unknown).
- Inter-agent reply basis: the wrapper does not request `v1`. The MCP call
  carries no turn origin, so binding a `send_to_agent` call to a live turn
  would rest on wrapper inference only. The reply-basis contract allows no
  protection claim from ToolHost-only measurement (same stance as Antigravity,
  which also stays `legacy`). Normal peer delivery and delivery confirmation
  still work and are acceptance item 7.

## Permission

Operator decisions (2026-10-14): grok's permission display meets the same
standard as the existing engines; grok loads the Claude hooks through the
operator's settings, not through kaoiro; the upstream gaps below are kept as
notes in the engine reference. Enabling a grok peer in production waits for
the operator.

### Measured permission layers

Measured with a Claude Code settings file in effect (`defaultMode: "auto"`,
allow and deny rules) and Claude hooks off at measurement time.

| Layer | Result |
|---|---|
| Import | grok reads `permissions` and `defaultMode` from `~/.claude/settings.json`; `grok inspect` shows it as the permission source. No `[compat.claude]` cell turns it off |
| `permissions.deny` | Enforced for `read_file` and for shell commands whose arguments show the path (`cat .env`, `head ./.env`: "Denied by permission policy"). Not enforced when the path is assembled at run time (`python3 -c` with `os.path.join`, `F=.en; cat "${F}v"`): the dummy value was printed |
| `defaultMode: "auto"` | grok has its own classifier. It blocked a pipe-to-shell and `rm -rf` of a cwd directory before execution. Blocked calls fail back to the model; no `session/request_permission` is sent, also with `clientInfo` set |
| Escalation | When the policy asks, `session/request_permission` reaches the client with `allow_always / allow_once / reject_once / reject_always`. Measured with `HOME` pointed at an empty directory: `reject_once` ended the turn `cancelled` and the target file did not exist afterwards. Also seen with `--always-approve` and with the settings file above for writes and network |
| Claude hooks | Work when enabled (a `PreToolUse` guard denied `cd ..`); with hooks disabled the same command ran |
| Git deny rule | A deny rule for a force push was enforced for the literal command before execution, and the bare repository ref did not change. Control: a plain push ran and updated the ref. No `session/request_permission` in either case. Like the `.env` rule, the match is on the command text, so other spellings are not covered by this measurement |

### Display contract

The standard, as kaoiro already applies it:

- `ext.permission` axes are the adapter's declared projection of the engine's
  permission posture, with `enforcement` naming the mechanism. A Claude Code
  peer in `auto` mode is shown as `on-request` through the same kind of
  projection (`dashboard/src/lib/protocol.ts:1097-1106`, ADR-0033 F2).
- Engine behaviour that the projection does not express is documented in the
  engine reference and in dated evidence, not asserted field by field at run
  time.

For grok:

1. `ext.permission`: `approval: "on-request"` (the Claude `auto` projection:
   grok's inherited policy decides, and asks for some calls),
   `enforcement: "os"` (the `GROK_SANDBOX` profile is enforced by the kernel:
   Landlock and seccomp, measured on 1.0.52), and the sandbox axis from the
   supported pair. The approval axis is launch-fixed and absent from
   `permission_switch_axes`. No closed value set changes.
2. `ext.permission_policy` (display-only, operator-only, outside every
   permission code path; the server relays `ext` minus `delivery_policy`,
   `wrapper_channel.ex:631-638`, and strips `ext` for viewers):

   ```ts
   interface PermissionPolicyCommon {
     /** The `GROK_SANDBOX` profile the wrapper set. */
     grok_sandbox_env: "read-only" | "workspace" | "off";
     /** Literal `grok --version` output, or null when that call failed. */
     grok_version: string | null;
   }

   /** `grok inspect --json` succeeded with the known shape (recorded for
    *  1.0.52: `permissions.sources: string[]`, `permissions.loaded: number`,
    *  `permissions.skipped: {rule, reason}[]`,
    *  `permissions.managedSettingsActive: boolean`,
    *  `externalCompat.cells: {vendor: string, surface: string,
    *  enabled: boolean, source: string}[]`). Exactly one `claude`/`hooks`
    *  cell with these types is required; a missing, duplicated or mistyped
    *  cell makes the whole payload `inspect: "unavailable"`. */
   interface PermissionPolicyObserved extends PermissionPolicyCommon {
     inspect: "ok";
     sources: string[];
     managed_settings_active: boolean;
     rules_loaded: number;
     rules_skipped: number;
     /** The `claude`/`hooks` cell of `externalCompat.cells`. */
     claude_hooks: { enabled: boolean; source: string };
   }

   /** inspect failed, timed out, or had an unknown shape: no
    *  inspect-derived field is sent and nothing is defaulted. */
   interface PermissionPolicyUnknown extends PermissionPolicyCommon {
     inspect: "unavailable";
   }

   type PermissionPolicyExt =
     | PermissionPolicyObserved
     | PermissionPolicyUnknown;
   ```

   The wrapper neither sets nor passes through the `GROK_CLAUDE_*_ENABLED`
   variables. Which Claude assets grok loads, hooks included, is owned by the
   operator's grok configuration, and the display reports what grok loaded.
   `grok inspect --json` runs in the agent cwd with exactly the env the child
   gets, so the displayed values describe that child.
3. Dashboard text for grok, next to the permission axes: "Approval decisions
   are made by grok from the Claude settings it loads; kaoiro receives the
   requests grok sends." For `inspect: "ok"` it lists the sources,
   managed-settings state, rule counts and the Claude hooks cell; for
   `"unavailable"` it says "permission sources unknown". It ends with the
   grok version and a link to the grok engine reference.
4. Engine reference `docs/reference/engines/grok-acp.md` (new) describes the
   behaviour behind the projection, in general form: deny rules match command
   text (a path or command assembled at run time is not matched), the auto
   classifier can block a call without asking a generic ACP client (source:
   escalation after 3 consecutive or 20 total denials, unmeasured on 1.0.52),
   sandbox profiles keep `/tmp`, `/var/tmp` and `~/.grok` writable, and the
   permission import has no compat switch. The same page keeps the upstream
   gaps as notes: no compat cell for the permission import, no way for a
   generic ACP client to declare that it can present prompts, no per-session
   permission mode for ACP. Dated results go to `docs/evidence/grok/` in
   general form only (no host names, paths, rule contents or per-host
   results).

Validation boundaries: `ext.permission_policy` is a sibling of the permission
fields. A `requested` permission payload that carries it is not rejected; the
existing parsers rebuild the configuration from known keys and drop the extra
field (`dashboard/src/lib/protocol.ts:399-420`,
`wrapper/core/src/transport.ts:616-643`). A top-level unknown key in
Before unit 2 permission-sync negotiation, `set_permission` is rejected by the server
(`agents_channel.ex:2673-2707`).

### Sandbox and network

Writes go to `$HOME/.cache` (outside cwd and outside the temp directories),
network to `https://example.com`.

| `GROK_SANDBOX` | write outside cwd | write inside cwd | child network | `/proc/self/status` |
|---|---|---|---|---|
| `workspace` | denied (`Permission denied`) | allowed | allowed (http 200) | `NoNewPrivs 1`, `Seccomp 2` |
| `read-only` | denied | denied with cwd under `$HOME` (allowed under `/tmp`, which the profile always grants) | blocked (resolve failure) | `Seccomp 2`, 2 filters |
| `off` | allowed | allowed | allowed | `Seccomp 0` |

The seccomp state is observed from inside the tool process. Landlock is
inferred from the `EACCES` failures and grok's docs, not observed directly.
`enforcement: "os"` is reported on that basis.

Supported pairs in work unit 1: on Linux, (`read-only`, network off) to `read-only`;
(`workspace-write`, network on) to `workspace`. These OS sandbox pairs are
rejected on non-Linux platforms with a reason: their enforcement has only
been measured on Linux. (`danger-full-access`, network on) maps to `off` on
every platform. macOS remains unmeasured until work unit 2 or later.
Every other pair is rejected at spawn with a reason. The
`ext.permission` axes keep their existing meaning; the grok profile name the
wrapper set is shown next to them (`grok_sandbox_env`). What a profile permits
beyond the axes (all profiles keep `/tmp`, `/var/tmp` and `~/.grok` writable;
under `read-only` child name resolution failed) is stated in the engine
reference and the evidence document, not asserted by the dashboard.

`read-only` with a cwd inside `/tmp`, `/var/tmp` or `~/.grok` is rejected at
spawn, because the cwd would stay writable while the axis says read-only.
Acceptance item 6 measures the supported pairs, including a direct connection
to a literal IP address under `read-only`, and its results go to the evidence
document.

### Isolating grok from the Claude permission policy (not chosen)

This needs a mechanism that keeps the real `HOME` for tools. Source survey
(grok-build 2bdd1d6, crate version 1.0.45, older than the 1.0.52 binary, so
behaviour still needs measurement on 1.0.52):

- `[claude_compat] imported = true` in grok's `config.toml` is the marker that
  `/import-claude` writes. It stops the Claude permission import
  (`permission-rules/src/resolution.rs:511`), but also Claude-origin skill
  discovery (`shell/src/extensions/skills.rs:271`), `.mcp.json` MCP servers
  (`config/src/mcp_servers/json_config.rs:33`), hooks
  (`shell/src/claude_import.rs:52`) and the Claude env
  (`permission-rules/src/claude_settings.rs:409`). It fits only if the
  operator's settings register those assets natively in grok (for example
  `[skills] paths` and grok MCP entries) before setting the marker.
- `_GROK_CLAUDE_MARKER_OVERRIDE=1` does the same per process but is an
  underscore-prefixed internal switch; not used.
- Why blocked calls never ask: an ACP client whose identifier is not one of
  grok's own (`grok-pager`, `grok-code-extension`, `grok-desktop`,
  `grok-web`, `nebula`) is `ClientType::Generic`, and
  `can_present_permission_prompt()` is false for it
  (`workspace/src/permission/types.rs:91`). A classifier block then becomes a
  deny returned to the model, until 3 consecutive or 20 total denials
  (`permission/manager/request_classification.rs:7`), after which grok asks.
  kaoiro does not impersonate a grok client identifier to change this.

This would be a settings change (native registration plus the marker), not a
kaoiro change.

## Persona and footer

`_meta.rules` on `session/new` works. It does not update on `session/load`:
the session keeps the rules it was created with. This matches the resume
limitation recorded for the other engines (ADR-0065). Work unit 1 creates a
fresh session per wrapper start; a cold resume (work unit 3a) keeps the
rules given at creation, which the unit 3 design review measured. grok also loads the operator's `CLAUDE.md` and rules
through compat, so the persona footer and the operator's footer rules
coexist, as for a Claude Code peer.

With Claude hooks enabled, the operator's hooks also run inside a grok peer,
including blocking ones (`PreToolUse` guards, `Stop`). A hook that blocks turn
completion would keep a grok turn from reaching `waiting_input`. Acceptance
items 1 and 7 therefore run with hooks enabled, so such an interaction turns
them red; fixing a hook itself belongs to the operator's settings. Under that
configuration, without any env override, a probe turn emitted
`hook_execution` for `session_start`, `user_prompt_submit`, `pre_tool_use`
(a guard denied `cd ..`) and `stop`.

## Out of scope

- Verifying each Claude hook under grok (operator's settings)
- Changing grok's telemetry or compat settings from kaoiro
- Moving existing engines onto ACP

## Verification plan

Native acceptance through the real `runGrokCli` entry point (skipped unless
`KAOIRO_LIVE_GROK=1`, like the Antigravity test), in a namespace that cannot
signal other processes:

1. With Claude hooks enabled in grok's configuration and no `GROK_CLAUDE_*`
   env in the child: `grok inspect --json` reports the `claude`/`hooks` cell
   `enabled: true`, and the turn emits `hook_execution` for `session_start`
   and `pre_tool_use`. Text returned; the state is running while the turn and
   a tool call run, and `waiting_input` after the turn; the second turn
   remembers the first. The `session/prompt` result `_meta` ids and the
   `_x.ai/session_notification` kinds are recorded as metadata
2. A kaoiro tool call goes through the production HTTP MCP server to the
   ToolHost handler with the right arguments, and its result reaches the model
3. `interrupt()` during a foreground long tool: verify the actual
   `tool_call.rawInput` command and `block_until_ms: 120000`, then assert
   the turn ends `cancelled`, the state leaves running and the known tool
   child disappears. Background-task survival is documented as an observed
   vendor behavior, not asserted because the model chooses backgrounding.
   Close/SIGTERM must remove an active tool child (item 4)
   Background-task cancellation is tracked in
   [issue #594](https://github.com/sakuraiyuta/kaoiro/issues/594).
4. `close()` and SIGTERM: no owned process remains after the grace period
5. Permission: a policy-escalated `session/request_permission` reaches the
   PermissionBroker; the state is `waiting_permission` only while that request
   is outstanding and returns afterwards; an operator reject ends the turn
   (reported as a rejection via `cancellationCategory`) and the file does not
   exist afterwards (asserted by the test, not read from logs). Negative
   control: a `pending_interaction` notification without an outstanding
   `session/request_permission` does not produce `waiting_permission`
6. Sandbox: each supported pair behaves as in the sandbox table (write
   outside and inside cwd under `$HOME`, child network), and each unsupported
   pair is rejected at spawn
7. Peer delivery: an inbound peer message starts a grok turn; grok replies
   with `send_to_agent` through the production MCP server; the delivery is
   confirmed (ack) to the sender; a failed delivery notifies the sender;
   `delivery_modes` reports `none` / `none`
8. `ext.permission` (`on-request`, `os` for Linux restrictive profiles;
   omitted enforcement for `off`) and `ext.permission_policy` go from
   the wrapper through the server to the operator dashboard and are rendered.
   Each displayed value is checked against its own source: `sources`,
   `managed_settings_active`, `rules_loaded` and `rules_skipped` against the
   raw `grok inspect --json` output captured in the same test; `claude_hooks`
   against the `externalCompat.cells` entry in the same inspect output;
   `grok_sandbox_env` against the env the wrapper passed; `grok_version`
   against `grok --version`. The fixed text and the engine-reference link are
   rendered. Negative controls: an inspect that fails, times out, or returns
   an unknown shape yields `inspect: "unavailable"` and the dashboard shows
   "permission sources unknown" with no source list, managed state or counts;
   a trusted project with its own `.claude/settings.json` shows that layer in
   `sources`; a second live run with `GROK_CLAUDE_HOOKS_ENABLED=false` in the
   wrapper's own environment still shows `claude_hooks.enabled: true` (the
   child env strip works); captured inspect outputs with the `claude`/`hooks`
   cell set to false, missing, duplicated or mistyped are fed to the parser
   and yield `enabled: false` or `inspect: "unavailable"` respectively
9. A `session/update` variant unknown to the SDK, injected into the same
   transport stream the adapter uses, is counted by the tee and its variant
   name appears in diagnostic metadata. A marker in the unknown variant body
   appears nowhere. Markers in normal prompts and tool results appear in no
   ACP tee metadata, filtered SDK console diagnostics or wrapper stderr;
   protocol display logs and results intentionally carry normal content

Negative controls (each turns its check red):

- the MCP server never answers: the turn ends with an error within a bounded
  time, and ToolHost and the child are closed
- a tool returns an error, the model gets the error
- the `grok` binary is missing: spawn fails with a clear error
- an unsupported permission pair, `setPermission`, `setModel`, `setEffort`
  and attachments are rejected and nothing falls back to a default
- the child exits mid-turn: the turn fails and the state leaves running
- a child (and its process group) that ignores SIGTERM is SIGKILLed within
  the grace, below the runner's 5000 ms reset escalation, and no process
  outside the owned group is signalled (run in an isolated namespace)

Gates: wrapper `pnpm typecheck/build/test`, runner `pnpm typecheck/test`,
server `mix test` for the channel sets, dashboard check for the engine label,
and the release manifest verifier with the new entry package.

## Docs to update

`README.md`, `wrapper/README.md`, `docs/architecture/overview.md`,
`docs/reference/engines/` (new `grok-acp.md`, including the upstream-gap
notes), `docs/evidence/grok/` (general form), the protocol capability and
permission pages, the runner configuration page, and an ADR for the engine
(numbered at landing).

## Tasks

| Unit | Issue | Status |
|---|---|---|
| 1. Registration, launch and minimal ACP host | [#590](https://github.com/sakuraiyuta/kaoiro/issues/590) | ✅ landed 3364c0e8 |
| 1b. Keep vendor extensions out of `acp/` (before unit 2) | [#597](https://github.com/sakuraiyuta/kaoiro/issues/597) | ✅ landed 0ad1ee5b |
| 1c. Serve the kaoiro tools over authenticated HTTP MCP (before unit 2) | [#604](https://github.com/sakuraiyuta/kaoiro/issues/604) | ✅ landed 8011fb0e |
| 2. Permission and sandbox enforcement | [#591](https://github.com/sakuraiyuta/kaoiro/issues/591) | ✅ landed 6e7f7b7b |
| 3. Resume, history replay and catalog probe | [#592](https://github.com/sakuraiyuta/kaoiro/issues/592) | split: 3a [#644](https://github.com/sakuraiyuta/kaoiro/issues/644) in review (after unit 4), 3b [#645](https://github.com/sakuraiyuta/kaoiro/issues/645) ⏳, 3c [#646](https://github.com/sakuraiyuta/kaoiro/issues/646) ⏳ |
| 4. Context usage, live model and effort switching | [#593](https://github.com/sakuraiyuta/kaoiro/issues/593) | in review |
| 5. Parity as a delegated peer (rate limits, early delivery, reply basis, attachments) | [#628](https://github.com/sakuraiyuta/kaoiro/issues/628) | ⏳ |

### Unit 2 verification

The resident adapter keeps separate current/loading/retired generations and
server-owned next selections. Its state transitions are compared with the
actual server `PermissionSettings.State` through committed fixtures under
`protocol/fixtures/permission-differential/`. Generate scenarios with
`KAOIRO_GENERATE_DIFFERENTIAL=1 pnpm -C wrapper/grok exec vitest run test/differential/generate.test.ts`,
then run `MIX_ENV=test mix permission.differential` in `server/`. The Elixir
drift test and the Grok differential test verify both halves.

The wrapper never originates `rolled_back_to`. A control adopted through
sync is reported intact, including a server-derived `rolled_back_to`.
The differential tests compare the whole adopted control and reject rollback
fields invented during final-gate refusal or lane failure.
Rejoin rows carry an adopted-control marker, resolved by the real server
state. Echo idempotency is checked for failed controls with `rolled_back_to`
and for unknown controls. Pending controls are excluded and counted because
the server can restore `submitted` after its sync projection removed it
([issue #618](https://github.com/sakuraiyuta/kaoiro/issues/618)). Removing
`rolled_back_to` and adding `submitted` is the server-side negative control.

The bounded prefix tree covers all valid sequences through five events and
at most three operator selections for both launch pairs. Six events exceed
the 2 MB fixture limit. The fixtures use parent references and compact arrays;
rows are scenarios, including intermediate prefixes. Codex's sync function is
compared from the same translated pre-state at each sync. A sync beyond Grok's
ceiling is excluded and counted because Codex does not enforce that ceiling.
Native tests measure writes, literal-IP connectivity, HTTP MCP after load,
and readiness after a history of 30 shell-and-MCP turns. Model text and
credentials are not evidence outputs.
