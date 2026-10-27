---
title: "Issue 564 U1 compatibility evidence"
status: implemented
last_updated: 2026-10-28
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
| Wrapper backend diagnostic (`wrapper/codex/src/cli.ts:188`) | (a) real built CLI seam | `readLocalRunner` | Runs `runCodexCli` with a temporary config and no `dependencies.backend`; both `exec` and `app-server` are selected through the config. The captured backend line itself passes to the default local reader as an invocation-scoped JSON message; the latter selection refuses preparation. | The CLI code is real, while system journal transport is represented at the command boundary. |
| Journal fields and cursor (`_SYSTEMD_INVOCATION_ID`, `_PID`, `__REALTIME_TIMESTAMP`, `--show-cursor`) | (c) product-shaped command response | `readLocalRunner`, `captureAckCursor`, and the applied-selection waiter | Invocation ID selects one service lifetime; the cursor separates records before and after the config write; timestamps bind receipts to config mtime. | These values are supplied by command-boundary fixtures in CI. Native journal behavior, cursor expiry, and retention remain unmeasured. |
| Systemd `InvocationID` | (c) product-shaped command response | `readInvocation` | Reads the selected unit's current invocation and verifies it is unchanged across the file observation and write boundary. | `systemctl` output and changes during observation are simulated at the command boundary; live systemd is not run in the isolated tests. |
| Release RPC output | (a) real inner projection; (c) RPC command boundary | `localAdapters.observeHost` and `parseJsonOutput` | The inner JSON bytes come from the real server projection captured in `server-observation.json`; the default adapter sends the RPC through the configured Compose command boundary. | The observation shape is tied to the real server producer. Compose execution and RPC transport remain represented by a command-boundary fixture. |
| `AgentDirectory` keys | (a) real default store | `CodexBackendCompatibility.observe_host/1` | A default-store ExUnit test records six synthetic rows and checks the sorted host union in the complete JSON golden. | The test uses the real in-process store; production store contents and host membership are not measured. |
| `SessionPointers` map keys and `engine` | (a) real default store | `CodexBackendCompatibility.observe_host/1` | Real nil-session and non-nil-session pointers are joined to the directory and compared byte-for-byte in the golden. | Only the product's in-process store is exercised; no production inventory is inferred. |
| `AgentStates.snapshot()` and envelope `ext.engine` | (a) real wrapper-channel join and store | `CodexBackendCompatibility.observe_host/1` | A real wrapper-channel join writes a pointerless live Codex state whose engine exists only at `ext.engine`; its projected row is in the golden. | The test proves the current producer and reader agree in-process; external socket delivery and production state are outside this measurement. |
| Reset and transition pending sets | (a) real default stores | `CodexBackendCompatibility.observe_host/1` | The default `SessionResets` and `AgentActivity` stores contribute pending rows to the same golden. Test-only timeouts are one day so elapsed test time cannot expire either row. | Only in-process store state is measured. The long timeouts apply only in test configuration; normal defaults are unchanged. |
| Synchronous child-process overflow | (a) real `execFileSync` | Default `run` and `runnerIdentity` catch branches | A real child writes 9 MiB under the production 8 MiB capture cap. The test asserts the emitted error code is `ENOBUFS`, preserves the original exception, and invokes `main` without a `runCommand` override. | The child replaces journal output at the process boundary; it does not measure a real journal. |
| Runner config file | (a) real temporary file | `readLocalRunner` and `writeBackendExec` | The default local adapter reads a real temporary config, checks its content hash and mtime, performs an atomic write, and rereads it. | Local filesystem behavior is exercised; the operator-selected file and filesystem are not. |

The golden contains directory-only, pointer-nil, pointer-non-nil, pointerless
live, reset-pending, and transition-pending rows. The server test calls
`observe_host/1` with no injected source options, serializes that real
observation using `Jason.encode!/1`, and compares the complete bytes with the
committed fixture. The Node default-adapter test sends those same fixture bytes
through `localAdapters` and verifies the lifecycle gate stops before a write.
The fixture uses synthetic identifiers and contains no operator environment
values.

The golden was captured from final implementation candidate
`cd81058c1e94024f5eee3008ea321f1a48cd29d3` in the final-candidate ExUnit run
`momo-cd81058-u1ecd810-1027231131-392f.e21515cfa77e42bd`. The real observer
returned 1037 bytes; the committed fixture SHA-256 is
`018a936bd545927d5b590735abbe07dedff365eb22c3643057d7616feba4cd1d`.

## Runner identity stop path

Runner identity searches the entire current invocation and requires one
well-formed startup record. It does not read only the last N journal lines. If
the record is absent, ambiguous, malformed, or cannot be read within the
8 MiB capture cap, U1 stops with `runner-start-record-unavailable` before
server observation or configuration write. A record with a `-dirty` suffix
stops with `runner-identity-dirty`. The command does not restart the service.
The synchronous `execFileSync` capture reports this overflow as `ENOBUFS`;
U1 preserves that error through the command boundary and maps it to
`runner-start-record-unavailable` when reading the startup record.

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

The remaining M3 and M6 corrections were measured on source candidate
`b8fb161645b29ee2ac9d905df14377e8ec115135`. Subsequent evidence-only edits do
not change the measured source or tests. The final pushed head is checked by
all seven CI jobs; its exact head SHA and run are recorded on the draft PR.
The isolated runs used pinned Node and Elixir images:

- Node: `sha256:56cfd9fbe740e78f5d6d219772b6f5f7ba08424bf449f688b1a2597eebd469b8`
- Elixir: `sha256:431e47077ade55b2acf621898f653451f542de12a51ffe538c3c5e69b8fbccc9`

| Check | Run | Result |
| --- | --- | --- |
| Node compatibility control, four mutations, restored control | `kogane-b8fb161-u1nodemut-1028001323-c9d6.a4bc7d7bef82f7c3` | Controls: 70/70. Removing the startup assertion fails `a copied startup line fails the provenance assertion` (69/70). Removing either ENOBUFS branch separately fails `real execFileSync overflow stops with runner-start-record-unavailable` (68/70, including the parent test). Ignoring wrapper config and rebuilding fails `configured app-server is emitted by the wrapper and read` (focused 2/4, including its parent); launcher identity still passes. |
| Server compatibility and format control | `kogane-b8fb161-u1exunit-1028001041-ff25.b82d17402126bea1` | Format passes; 7/7 tests pass. |
| ExUnit binding assertion mutation | `kogane-b8fb161-u1exmut-1028001230-e450.8a1aba0e9e0b72a2` | Control 7/7; removing the assertion fails only `a static golden fails the real-engine binding assertion` (6/7); restored 7/7. |

Both checker self-tests call the same assertion as their corresponding real
producer test. The startup negative input differs in its host ID; the static
server golden row is normalized to the expected synthetic ID but retains its
Codex engine, which must fail the distinct real-join engine assertion. These
are checker tests, separate from the existing reader rejection tests.

The ENOBUFS test preserves the real exception through both production catch
branches. Its other external commands remain simulated. Removing either
branch must fail the named overflow test, rather than merely fail an unrelated
startup or build-identity assertion. The wrapper-config mutation is verified
in the rebuilt output before its test runs. Each mutation is restored, and
both campaigns finish with a passing unchanged control.

Earlier mutation claims for the output cap used a handwritten error shape;
they did not establish the behavior of the synchronous Node API. Earlier
startup and distinct-engine passing tests also did not test removal of their
own assertions. The runs above supply those missing measurements. Other prior
producer/reader mutation campaigns are not repeated or newly attested here.
The first Node control attempt stopped before running tests because the
isolation checker needed dashboard dependencies; the successful run installed
them as CI does. Final CI additionally runs the full isolation checker and
all four Node suites in its `test-isolation` job.

The named checker self-test `rejects workflow without compatibility-test
entry` keeps the workflow-entry assertion active. Launcher identity requires
the expected revision and Boolean `dirty`, as specified by the design. The
real startup test still requires a clean checkout revision; source mutations
that rebuild a dirty runner can also fail that test, so producer mutations
must be judged by their intended named test rather than exit status alone.

## Limits

The tests do not measure live systemd/journald transport, Docker Compose RPC,
operator-selected files, production host membership, Codex account behavior,
or native session migration. Missing startup records, stale journal retention,
and unavailable invocation metadata remain fail-closed conditions. A planned
service restart to obtain a new record has the wrapper interruption impact
described above.
