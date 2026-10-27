---
title: "Issue 564 U1 compatibility evidence"
status: implemented
last_updated: 2026-10-27
---

# Issue 564 U1 compatibility evidence

This record covers U1's read-only compatibility observation and preparation
that pins an omitted Codex backend to the existing `exec` selection. It does
not change the omitted-setting default or remove a pin. No production, native
Codex session, or account-backed operation is claimed.

## Producer ledger

| Producer | Method | Reader | Input source and binding | Remaining risk |
| --- | --- | --- | --- | --- |
| Runner launcher `--version --json` | (a) real built artifact | Build identity assertion | Executes the built launcher with temporary HOME/TMPDIR values; compares `revision` with `git rev-parse HEAD` and requires `dirty` to be a JSON boolean. | CI checks the build artifact, not an installed host's launcher. |
| Runner startup diagnostic (`runner/src/runner-cli.ts`) | (a) real built process | `runnerIdentity` in the U1 preparation command | Searches the complete selected systemd invocation for one `runner: host=… rev=… connecting to …` record; checks its random test host ID and full checkout SHA. The test declares `capabilities: ["codex"]` and `codex.auth_mode: "chatgpt"`; an unknown revision fails. | CI observes a real process on stderr, but not journald/systemd filtering. Missing, ambiguous, malformed, or over-8-MiB invocation output stops with `runner-start-record-unavailable`; `-dirty` stops with `runner-identity-dirty`. |
| Runner reload diagnostic (`runner/src/runner-cli.ts:548`) | (a) real in-process producer seam | `waitForAppliedBackendExec` and `readLocalRunner` | Starts the built runner through `runRunnerCli`, changes a temporary config from `app-server` to `exec`, and captures the actual line only after the reload trigger. The same bytes pass through the journal JSON `MESSAGE` reader and `--output=cat` acknowledgement reader. The receipt must be `source=reload` and later than config mtime. | Journal cursor, filtering, retention, and service transport remain command-boundary behavior in CI. |
| Wrapper backend diagnostic (`wrapper/codex/src/cli.ts:188`) | (a) real built CLI seam | `readLocalRunner` | Runs `runCodexCli` with a temporary config and no `dependencies.backend`; the actual `codex: backend=exec` line is passed to the default local reader as an invocation-scoped JSON message. | The CLI code is real, while system journal transport is represented at the command boundary. |
| Journal fields and cursor (`_SYSTEMD_INVOCATION_ID`, `_PID`, `__REALTIME_TIMESTAMP`, `--show-cursor`) | (c) product-shaped command response | `readLocalRunner`, `captureAckCursor`, and the applied-selection waiter | Invocation ID selects one service lifetime; the cursor separates records before and after the config write; timestamps bind receipts to config mtime. | These values are supplied by command-boundary fixtures in CI. Native journal behavior, cursor expiry, and retention remain unmeasured. |
| Systemd `InvocationID` | (c) product-shaped command response | `readInvocation` | Reads the selected unit's current invocation and verifies it is unchanged across the file observation and write boundary. | `systemctl` output and changes during observation are simulated at the command boundary; live systemd is not run in hakoniwa. |
| Release RPC output | (a) real inner projection; (c) RPC command boundary | `localAdapters.observeHost` and `parseJsonOutput` | The inner JSON bytes come from the real server projection captured in `server-observation.json`; the default adapter sends the RPC through the configured Compose command boundary. | The observation shape is tied to the real server producer. Compose execution and RPC transport remain represented by a command-boundary fixture. |
| `AgentDirectory` keys | (a) real default store | `CodexBackendCompatibility.observe_host/1` | A default-store ExUnit test records six synthetic rows and checks the sorted host union in the complete JSON golden. | The test uses the real in-process store; production store contents and host membership are not measured. |
| `SessionPointers` map keys and `engine` | (a) real default store | `CodexBackendCompatibility.observe_host/1` | Real nil-session and non-nil-session pointers are joined to the directory and compared byte-for-byte in the golden. | Only the product's in-process store is exercised; no production inventory is inferred. |
| `AgentStates.snapshot()` and envelope `ext.engine` | (a) real wrapper-channel join and store | `CodexBackendCompatibility.observe_host/1` | A real wrapper-channel join writes a pointerless live Codex state whose engine exists only at `ext.engine`; its projected row is in the golden. | The test proves the current producer and reader agree in-process; external socket delivery and production state are outside this measurement. |
| Reset and transition pending sets | (a) real default stores | `CodexBackendCompatibility.observe_host/1` | The default `SessionResets` and `AgentActivity` stores contribute pending rows to the same golden. Test-only timeouts are one day so elapsed test time cannot expire either row. | Only in-process store state is measured. The long timeouts apply only in test configuration; normal defaults are unchanged. |
| Runner config file | (a) real temporary file | `readLocalRunner` and `writeBackendExec` | The default local adapter reads a real temporary config, checks its content hash and mtime, performs an atomic write, and rereads it. | Local filesystem behavior is exercised; the operator-selected file and filesystem are not. |

The golden contains directory-only, pointer-nil, pointer-non-nil, pointerless
live, reset-pending, and transition-pending rows. The server test calls
`observe_host/1` with no injected source options, serializes that real
observation using `Jason.encode!/1`, and compares the complete bytes with the
committed fixture. The Node default-adapter test sends those same fixture bytes
through `localAdapters` and verifies the lifecycle gate stops before a write.
The fixture uses synthetic identifiers and contains no operator environment
values.

The golden capture record for the final implementation candidate is recorded
with its source SHA, hakoniwa run, captured byte count, and fixture SHA after
the final-candidate ExUnit control passes.

## Runner identity stop path

Runner identity searches the entire current invocation and requires one
well-formed startup record. It does not read only the last N journal lines. If
the record is absent, ambiguous, malformed, or cannot be read within the
8 MiB capture cap, U1 stops with `runner-start-record-unavailable` before
server observation or configuration write. A record with a `-dirty` suffix
stops with `runner-identity-dirty`. The command does not restart the service.

The operator can schedule a controlled runner-service restart to create a new
startup record and repeat preparation. Runner shutdown stops all supervised
wrappers and interrupts their active turns; after the runner reconnects,
affected agents may need to be relaunched through existing controls. If that
impact is not acceptable, leave configuration untouched and postpone the
default-changing update until a planned verification window. The preparation
command does not invoke or depend on `kaoiro-prod`.

## Gate and CI coverage

The preparation entry rejects an actual positive pending observation before
reading origin evidence or capturing the acknowledgement cursor. It repeats
the full host and runner observations immediately before writing, and refuses
if either observation changes or becomes unavailable. A failed acknowledgement
does not cause a second write, post-write observation, rollback, or restore.
The post-write receipt requires the reload diagnostic after the saved config
mtime.

`scripts/test-isolation/check.mjs` asserts that
`scripts/test/codex-backend-compatibility.test.mjs` is listed in the
`test-isolation` workflow entry. The workflow builds the runner before the
Node suite. Its built-runner test uses a random test host ID, explicit
`capabilities: ["codex"]`, explicit `codex.auth_mode: "chatgpt"`, and a
test-owned loopback WebSocket endpoint. It derives the expected SHA from the
checked-out `HEAD`, fails on an unknown SHA, and asserts only the matched
startup line. No Codex process, external account, production service, or
`kaoiro-prod` command is used.

## Recorded checks

The focused checks below ran against the committed code candidate shown in the
table. Mutation runs use isolated snapshots of that commit. All hakoniwa runs use the pinned
Node runtime image
`sha256:56cfd9fbe740e78f5d6d219772b6f5f7ba08424bf449f688b1a2597eebd469b8`
or Elixir image
`sha256:431e47077ade55b2acf621898f653451f542de12a51ffe538c3c5e69b8fbccc9`.

| Check | Run | Result |
| --- | --- | --- |
| Final candidate no-defect control: Node compatibility, isolation, and checker | pending | pending |
| Final candidate no-defect control: server compatibility ExUnit and format | pending | pending |
| Required and adopted mutations | pending | pending |
| Final candidate CI | pending | all seven jobs pending |

The named checker self-test `rejects workflow without compatibility-test
entry` keeps the workflow-entry assertion active. The compatibility suite is
the Node test command in the `test-isolation` job after wrapper and runner
builds.

## Limits

The tests do not measure live systemd/journald transport, Docker Compose RPC,
operator-selected files, production host membership, Codex account behavior,
or native session migration. Missing startup records, stale journal retention,
and unavailable invocation metadata remain fail-closed conditions. A planned
service restart to obtain a new record has the wrapper interruption impact
described above.
