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
| Runner startup diagnostic (`runner/src/runner-cli.ts:363`) | (a) real built process | `runnerIdentity` in the U1 preparation command | Searches the complete selected systemd invocation for one `runner: host=… rev=… connecting to …` record; checks its host and full release SHA against the command arguments. CI starts the built runner and checks the line against `git rev-parse HEAD`. | CI observes the real built process on stderr, but not journald or systemd filtering. A missing or ambiguous retained record is unknown and stops with `runner-start-record-unavailable`. |
| Runner reload diagnostic (`runner/src/runner-cli.ts:548`) | (c) product-shaped command response | `waitForAppliedBackendExec` and `readLocalRunner` | Reads `runner: codex backend=exec for subsequent wrappers` after the captured journal cursor; the post-write receipt must be from `reload` and later than the saved config mtime. | Journal cursor and message records use command-boundary responses in tests; actual service journal transport and retention are not exercised. |
| Wrapper backend diagnostic (`wrapper/codex/src/cli.ts:188`) | (c) product-shaped command response | `readLocalRunner` | Reads `codex: backend=exec` from invocation-scoped JSON journal rows and retains its timestamp and PID. The config file must remain unchanged while the observation is collected. | The backend line and journal fields are exercised through a product-shaped command boundary; a live wrapper journal is not part of U1. |
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

The golden was captured from the real default-store observation produced by
candidate code commit `ebff0d0a8e3100f57998b41c2f54e059c6ebb432`. A temporary
measurement snapshot printed the test's `Jason.encode!/1` bytes; hakoniwa run
`momo-b1277ce-goldencap-1027212236-0449.5b926ca9adb06a60` captured 1,037 bytes,
which matched the fixture byte-for-byte. The output marker was removed after
capture. The fixture SHA-256 is
`018a936bd545927d5b590735abbe07dedff365eb22c3643057d7616feba4cd1d`.

## Runner identity stop path

Runner identity searches the entire current invocation and requires one
well-formed startup record. It does not read only the last N journal lines. If
the record is absent, ambiguous, or malformed, U1 stops with
`runner-start-record-unavailable` before server observation or configuration
write. The command does not restart the service.

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
| Candidate `ebff0d0a`: Node compatibility, isolation suite, and workflow checker | `momo-ebff0d0-u1node-1027211138-77ca.a6e516e86c1ef058` | pass; 205 tests, 25 checker entries, 0 checker problems |
| Candidate `ebff0d0a`: server compatibility ExUnit suite and format check | `momo-ebff0d0-u1count-1027212450-672d.61a07927db1f3362` | pass; 4 tests |
| Mutation: tail-limit the journal read and hide an earlier runner startup record | `momo-6ba5f5f-m1tail-1027211720-4770.7b685e88f27d1356` | expected fail; 2 test failures |
| Mutation: remove the named missing-startup stop code | `momo-cdc2e4d-startcode-1027212124-b5b9.e3559de093b51bfd` | expected fail; 2 test failures |
| Mutation: suppress `ext.engine` in the server projection | `momo-a0d8b0c-m2exteng-1027211849-a387.43b2e6a74ec7940e` | expected fail; default-store golden test failed |
| Mutation: drop the compatibility test from the workflow entry | `momo-8da3eb7-m4workflow-1027211937-bbc3.33786e60d20b8b64` | expected fail; workflow assertion failed |
| Mutation: remove the post-write reload-receipt requirement | `momo-09e8ff7-s2reload-1027211748-54e1.7059a60d069bb573` | expected fail; 1 test failure |
| Mutation: remove the pre-write stability comparison | `momo-4d8af34-s3stable-1027211819-bfd3.25b6fda733ee1b3d` | expected fail; 3 test failures |
| Mutation: remove the initial positive-pending gate | `momo-a248c6e-pendgate-1027212019-638a.2205eb6c894e48f4` | expected fail; 1 test failure |
| Mutation: ignore a failed applied-selection acknowledgement | `momo-3dcd21a-ackgate-1027212045-8341.4355271493dab4b8` | expected fail; 1 test failure |
| Mutation: treat an unavailable host observation as an empty observation | `momo-e20b37a-obsfail-1027212156-2f14.9b0ff96047e5ab94` | expected fail; 3 test failures |

The broad `CI` test-file registration follow-up is outside U1; this evidence
records only the approved per-file workflow-entry assertion.

## Limits

The tests do not measure live systemd/journald transport, Docker Compose RPC,
operator-selected files, production host membership, Codex account behavior,
or native session migration. Missing startup records, stale journal retention,
and unavailable invocation metadata remain fail-closed conditions. A planned
service restart to obtain a new record has the wrapper interruption impact
described above.
