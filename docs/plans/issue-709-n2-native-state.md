---
title: N2 — minimal native-state transactions and recovery
status: proposed
last_updated: 2026-10-22
---

# N2 — minimal native-state transactions and recovery

Tracking: [issue #709](https://github.com/sakuraiyuta/kaoiro/issues/709).
Parent: [release reduction, sections 4 and 7](issue-709-release-reduction.md).
Baseline: `8986936d9136fb7c7c7545f808543ceffe91dffd`.
This is a design submission, not implementation or deployment approval.
N1 and P3 must land before implementation is integrated. N3 owns the final
recovery-table renderer and exhaustive phase property test; N2 must already
provide working recovery commands and interruption tests.

## 1. Fixed guarantee boundary

Keep B1–B9 of the parent design: a usable home; native-hash-aware switching;
credential exclusion and move-only restore; classification; stopped-writer
checks; verified snapshots; resumable replacement; agreement of the actual,
next-start and requested home paths; and retention of required releases.
Snapshots remain, as the operator decided on 2026-10-22.

Do not retain acceptance, completion receipts, an ordered history of accepted
homes, latest-snapshot-only restore, lineage, legacy repair, barriers, or
retirement evidence. A completed forward proves the updater's post-start
checks, not a Codex model turn or thread resume. Those checks remain manual.

The maintenance contract is cooperative: the updater exclusively owns the
managed service's stop/start and managed home mutations until recovery ends.
Independent Codex writers, manual starts during maintenance, modifications
of an operation's files, and concurrent use of an old tool are unsupported.
An empty managed cgroup does not establish absence of independent writers.
The existing warning and fresh-setup exit remain. No new launch barrier,
distributed lock, compatibility orchestrator, or credential backup is added.

Classification for the subsequent implementation: **L**. Schema and
release/deploy paths change; concurrency, credentials and destructive
operations are safety-sensitive, and recovery commands change observable
behavior. Protocol, authentication authority, shared harness and dependency
locks need no production change. Expected total diff exceeds 200 lines and
is predominantly deletion. This submission changes documentation only.

## 2. Record and locking model

Use `codex-state/v2/records/<uuid>.json`, private directories (0700) and
regular, single-link, owner-private records (0600). One record owns one
forward snapshot and its subsequent explicitly selected restores. There is
no second backup registry and no acceptance registry. Restoring an older
retained snapshot is allowed when no other operation is unfinished.

| Field | Meaning |
|---|---|
| `schema: 2`, `uuid`, `root`, `service`, `home` | Record identity; canonical installation and home paths, installed unit ID |
| `source`, `target` | Original forward release IDs and native SHA-256 values; immutable, including after a restore |
| `phase` | One of the eight states in section 4 |
| `snapshot` | `{path, staging, status, manifestHash}`; status `planned`, `retained`, `prune-intent`, or `retired`; hash absent until published |
| `tool`, `updaterPid`, `created` | Physical tool release for in-flight protection; PID/timestamp are diagnostic, and PID never authorizes recovery |
| `returnToPreV2` | Whether the invoking command explicitly authorized retiring this operation's snapshot for a pre-v2 source return; no evidence document |
| `cleanup` (optional) | Exact staging path, logical bytes counted, and whether its removal remains pending |
| `replacement` (only for restore) | `{attempt, from, priorPhase, staging, aside, credentials, promoted, stateDigest, startRequested}` |
| `prune` (only during/after prune) | Exact snapshot path and its root device/inode, pre-removal size, removal result |

`replacement.from` is the release at restore admission. Its target is always
`source`, the snapshot's original release. `attempt` gives each restore new
sibling staging/aside names, so repeated restores do not reuse a quarantine.
`credentials` contains only the names present before replacement, never
contents, hashes, or sizes. `stateDigest` hashes the normalized manifest's
state entries, excluding credentials. `promoted` is a durable checkpoint of
filesystem completion, not a second lineage history. `startRequested` is
saved before starting the restored release; it prevents a retry from
replacing state again after that native may have written it.

Reuse the existing snapshot manifest classification and payload format;
write minimal metadata (UUID, canonical home, source/target native identity).
Remove unit/config identities and receipt material from new manifests. A
manifest's old `source` object shape may remain readable, but device/inode
is not compared for B8. Deletion ownership in `prune` is separate: it
prevents deleting an unrelated directory subsequently created at that path.

Use the existing `atomicJSON` write/fsync/rename/parent-fsync primitive.
Before publishing `snapshot-verified`, sync copied state files, the manifest,
and containing directories, then the snapshot-parent rename. Before a
replacement checkpoint, sync both parents affected by each rename. A failed
sync refuses the next destructive/start step. This requires ordinary local
filesystem rename/fsync semantics; it does not promise survival of storage
failure or provide a power-loss test result.

`.lock.update` remains the mutually exclusive directory, with the existing
manual stale-lock inspection. Acquire it for a whole updater/recovery/prune
operation; do not acquire it recursively in helper subprocesses. Keep
`.lock.links` for current/previous changes, record publication that changes
release protection, install replacement, and release pruning. Order is
update then links whenever both are needed. Installation keeps its existing
install lock and narrow links-lock section; it does not wait for an update
lock held by its caller. Every deletion under the links lock re-reads the
protected release set. Remove `codex-owner.json` and PID/start-tick proofs;
the updater PID in the operation record is diagnostic only.

Public commands acquire their own locks. Updater-internal helper calls run
inside the updater's locks, with the transaction UUID as the operation
selector, not an authority token. A stale lock is never silently stolen.
After an operator proves the old worker gone and removes its stale locks,
a new worker resumes solely from the persisted phase and filesystem state.

Scans validate only the fields needed to identify unfinished operations and
protected releases. Fully validate the selected record before acting on it.
A malformed optional historical diagnostic does not stop another update.
An unreadable/unknown phase or retention field cannot safely be classified;
it refuses mutation with the record filename, without dumping its contents.
This replaces registry-wide receipt/binding validation, not error checking.

## 3. Home agreement and switching

Replace `staticShape`, `checkBinding` and full-binding equality with a small
path check in `codex-service.mjs`:

1. Compute the next-start home from the installed unit environment and the
   launch shim's `runner.env` resolution, using the existing literal parser.
   Keep the supported-unit restrictions required to compute that path,
   private ownership, and `KillMode=control-group`. Drop recorded fragment
   hashes, environment-file hashes/inodes, manager-environment snapshots,
   and `ExecStart` text equality. Still require the supported launch shim.
2. While active, read only `CODEX_HOME` and `HOME` from the actual MainPID's
   environment. If `CODEX_HOME` is empty/unset, resolve its default from that
   process's `HOME`, not from the possibly edited next-start environment.
   Bracket that read with MainPID and process-start-time checks. These are
   read-consistency checks, not durable transaction-owner proofs.
3. Resolve all present paths to canonical absolute paths and compare paths.
   Before stop, live = next-start = requested. After stop, next-start =
   recorded. A stopped restore also requires snapshot home = requested.
   During the home-absent replacement interval, resolve its existing parent
   plus basename; only this recorded interval may omit the leaf directory.

Same-path environment edits and inode replacement pass B8. A different home
refuses before stop. Unknown unit/environment syntax still refuses: removing
identity checks does not make shell evaluation a safe path resolver.

`guard` without a transaction still requires equal native hashes. Retained
snapshots alone no longer force a state-aware same-pin update; an unfinished
operation does. With a transaction, the guard recognizes only safe forward,
never-started return, and verified restore. No general cross-pin bypass is
introduced. Historical completed/failed records cannot authorize a new
code-only native downgrade.

## 4. Phases and commands

Retain normal updater options. Add mutually exclusive
`--resume-codex-transaction <uuid>` and
`--recover-codex-transaction <uuid>`, usable with `--detach` and the same
physical tool-path pinning. Resume continues the chosen operation; recover
returns a never-started forward to its source or restores its snapshot when
start was requested. They never reinstall or build an artifact. The helper's
`summary` shows phase, snapshot retention and the operation UUID only.

| Durable state | May have happened | Resume / recovery exit |
|---|---|---|
| `prepared` | Stop, partial copy, or complete snapshot publication; candidate never started | Resume snapshot while stopped, or recover unchanged source; remove only owned partial staging and record `failed` |
| `snapshot-verified` | Snapshot durable; links may name source or target; candidate never started | Resume checks stopped state against snapshot, switches target, writes `start-intent`; recover restores source link on untouched home, writes `failed`, then starts source |
| `start-intent` | Candidate start may or may not have happened | Resume only the recorded target and post-start checks, then `completed`; recover performs snapshot restore; code-only source return refuses |
| `completed` | Forward post-start checks passed | No acceptance step; new update allowed; explicit restore or prune allowed |
| `failed` | Forward ended before any candidate start request | Does not block another update; pending staging cleanup warns. Recover may retry the unchanged source start only if current still equals source; no historical downgrade authorization |
| `restore-prepared` | Restore admitted; old home untouched; staging absent/partial/complete | Resume rebuilds/verifies only the owned staging and enters `replace-intent`; cancellation before replacement returns to `priorPhase` and restarts unchanged `replacement.from` if appropriate |
| `replace-intent` | Some/all home and credential renames, and possibly source start | Resume the same replacement using section 5; once promoted, start only snapshot source and check it, then `restored` |
| `restored` | Restored source passed post-start checks | Snapshot remains retained until explicit prune; new update, another explicitly named restore, or prune allowed |

`failed` is written only from the two pre-start forward phases. For source
return, restore the source link and save `failed` **before** requesting its
start; a crash after the start must not leave `snapshot-verified` eligible
for a later forward using a stale snapshot. A failed source restart is an
error, with `recover` retry available and no false success report.

`prepared` is published before staging creation. Snapshot publication is
ordered: create/copy/sync stage, verify, rename to destination, publish the
manifest hash plus `retained` and `snapshot-verified` in one record write.
After a crash with a complete destination but a `prepared` record, compare
its manifest UUID, source/target and home with the selected record, verify
the payload, and adopt it. If invalid, keep the candidate unstarted and
offer unchanged-source recovery; do not silently adopt or delete it.
If the destination is missing although the record says verified, continuing
forward refuses, but pre-start source recovery still works. Mark the missing
snapshot retired when explicitly resolving that recovery. A directory with
no operation record is not adopted or recursively deleted: report the path
for operator disposition, while leaving ordinary source start available.

A snapshot failure removes its UUID-owned staging, with path and logical
size recorded before removal. If removal fails, persist `cleanup.pending`
and `failed`; a later update warns, and `prune <root> <uuid>` retries exactly
that cleanup. It does not scan and delete arbitrary sibling directories.
These are R1–R3 exits, including the two record/publication crash windows.

The updater's post-start check must read active service state, a positive
MainPID, current/target agreement and the existing artifact attestation;
re-read live home agreement too. A successful `--version` subprocess alone
is insufficient. `started` becomes this completion step, replacing the old
transition into `awaiting-acceptance`. A failed start or check leaves
`start-intent`, or `replace-intent` on restore, and exits nonzero.

## 5. Restore interruption exits (R4)

Admission takes an explicitly named retained snapshot. Verify it and the
original source release/native before stopping anything. No newest-snapshot
or intervening-release restriction remains. If a forward is already
unfinished, only recovery of that record may proceed; selecting an unrelated
snapshot waits until the existing operation is resolved. This is exclusion
of overlapping mutations, not historical lineage.
Recovery from a pre-start forward uses the never-started source-return path,
not restore admission. Thus cancellation of `restore-prepared` cannot
restart an unstarted candidate while reverting its record to a pre-start
phase. For `priorPhase=start-intent`, cancellation may restart only that
recorded candidate; for a terminal prior phase it may restart only the
unchanged `replacement.from`. It never selects a new release on cancellation.
Cancellation records the owned restore-staging path and size, removes it
using the same retryable cleanup rule as a failed forward, clears the
cancelled replacement fields, then restores `priorPhase`. It is unavailable
after `replace-intent`; credentials may already have moved at that point.

Save `restore-prepared`, the previous phase, the current release, and new
attempt-specific sibling paths. Stop and assert B5. Prepare/verify state-only
staging. Record the present credential names, `stateDigest`, and
`replace-intent` durably before renaming the live home. All paths must be
private, owned, disjoint from releases/snapshots and siblings on one
filesystem. Preserve the original home as `aside`; never delete it.

Let H = configured home, S = restore staging, Q = aside. With
`startRequested=false`, the following observations determine the next step:

| H | S | Q | Action on the same record |
|---|---|---|---|
| present | present | absent | Verify S's state; rename H to Q and sync parent |
| absent | present | present | Finish credential moves below; rename S to H and sync parent |
| present | absent | present | Promotion already happened; verify restored state and required credential locations; save `promoted=true` |
| any other combination | | | Refuse further changes; preserve all objects and report fresh setup/manual repair as the remaining exit |

For each recorded credential name, exactly one of Q/name and S/name must
exist before promotion: Q-only → rename to S; S-only → already moved.
Both or neither refuses without overwrite. A name not recorded must be
absent from both. After promotion the same check uses H instead of S, and Q
must contain none of the moved names. Directories are moved intact; contents
are not read. Snapshot and stage payload verification exclude credentials.

After promotion, save `promoted=true` before switching to snapshot source.
Switch using the N2 tool, verify state once more against `stateDigest`, and
save `startRequested=true` before the service start. If that flag is true,
resume does not compare mutable live contents to the old snapshot or repeat
credential/home moves: finish/retry only that source's startup checks. This
handles a crash after source startup but before saving `restored`. To perform
a second restore after a successful one, create a new `attempt` in the same
record with fresh paths; do not re-enter the old replacement.

The managed service remains stopped throughout renames. B1 already refuses
an explicitly configured missing home; it is not a transaction-aware launch
barrier and is not claimed as one. Starts before the home disappears or
after it reappears still rely on the maintenance contract in section 1.
At this baseline `codexHomeProblem` also returns no problem when `CODEX_HOME`
is unset/empty; it does not refuse a missing default home. Therefore the
parent's statement that the runner refuses launches "meanwhile" must not be
read as coverage of every replacement interruption. See decision 4 below.

## 6. Prune and release protection (R7)

Expose `prune <root> <uuid>`, with no evidence file. No-op on an already
retired snapshot except retrying recorded partial staging cleanup. Normally
require a terminal phase and no replacement using that snapshot. Under both
locks, record `prune-intent` with the exact snapshot path, size and root
device/inode before deletion. Initial pruning checks path ownership and
disjointness; it does not require an intact payload to relinquish a corrupt
backup. On retry, an absent directory completes retirement, a partial
directory with the recorded identity is removed, and a changed identity or
symlink refuses. Do not call `verifySnapshot` after deletion has begun.
Only after removal and parent sync save `retired`. Record files remain.

`protected` lists source releases of `retained` and `prune-intent` snapshots.
An unfinished operation additionally keeps the releases needed to finish its
current replacement (source, target/from and physical tool). Once terminal,
the tool and target cease to be state-derived protection. Current/previous
protection remains the install/updater's independent rule. Do not protect
every release ever mentioned by a historical record.

Record publication and removal of protection happen under `.lock.links`,
the same lock held by install replacement and release prune. Exercise two
real concurrent contenders, including install versus snapshot publication,
before landing; single-threaded mocked lock calls are not sufficient.

The explicit pre-v2 return in section 7 is the only exception to terminal
phase admission: it may prune its own pre-start forward snapshot, or its own
fully promoted restore snapshot. It holds both locks across pruning and
activation and must leave the saved recovery exit usable if interrupted.

## 7. Cutover and returning to old tools

Before every mutating state action and `protected`, project only old
`transactions/*.json` phase and `backups/*.json` retired status. Allow old
transaction phases `completed`, `restored`, `retired`, with every backup
explicitly `retired: true`; missing/unreadable/unknown values refuse. Do not
validate old acceptance fields, edit old records, or convert them to v2.
An old unresolved record prints: "Resolve old Codex state records with the
previous tool release" and names the pre-N2 procedure. Read-only inventory
must still work so the refusal can be diagnosed. Ignored `barriers/` neither
authorize nor block an operation.

Use the last deployed pre-N2 physical tool release for those old records,
before any v2 operation. The deployment release note must name its immutable
SHA and verified tool path; this cannot be a guessed future tag in this
design. U3 remains a deployment check, not an agent production probe. The
operator's one-installation statement removes the unknown fleet count; it
does not replace checking that installation's records at cutover.
The old tool still has the interrupted-restore and partial-staging defects
listed in issue #695. If its existing recovery/accept/retire/abandon commands
cannot resolve a record, cutover remains refused: preserve the old state and
request operator recovery/fresh setup under the old runbook. N2 does not
pretend that its new exits repair old schema-1 records or rewrite their phase
to bypass admission. The known all-retired installation needs no migration.

N2 adds a literal exported `CODEX_STATE_SCHEMA = 2` to its helper. Read that
capability from the verified target deploy file without executing arbitrary
target code. Missing marker means pre-N2. This narrowly distinguishes tools
that can protect v2 records; native hash equality alone cannot do that.

| Return path | Executing tool | Rule |
|---|---|---|
| Automatic never-started recovery | Pinned N2 physical updater | Source N2-aware: ordinary recovery. Pre-N2 source: use only the explicitly authorized selected-snapshot retirement below; otherwise refuse activation |
| Automatic/explicit snapshot recovery | Pinned N2 physical updater | A pre-N2 target cannot be started while any v2 snapshot is retained or a home replacement is incomplete; explicit return retires the selected snapshot first |
| Manual `switch --rollback` | N2 switch | Equal native hash plus no unfinished operation; if target is pre-N2, also require no retained/pruning v2 snapshot |
| Source-code revert / reinstall old tarball | N2 installation and switch tools until transition ends | Same conditions; never invoke old install/prune on a v2-bearing installation |
| Old-record recovery | Last deployed pre-N2 physical tools | Only before v2 creation; old directories remain untouched by N2 |

**Proposed explicit exit for the first N2 update's pre-N2 source:** add
`--return-to-pre-v2` to a state-aware forward, named `recover`, or restore
command. It authorizes
discarding that operation's snapshot after its recovery has made the home
safe, not discarding other rollback points. First explicitly prune other
retained snapshots. For a never-started return, prune its snapshot under
the locks before switching back. For restore, finish promotion and save
`promoted=true` and `stateDigest`; only then permit pruning its own snapshot
while source startup is still pending. At that point no filesystem
replacement remains in flight, even though the phase is `replace-intent`.
Recheck that no retained/pruning snapshots or incomplete replacements remain,
then use the N2 tool to switch/start pre-N2 source. Keep the N2 tool until the
operation ends, using the unfinished-operation protection above. No tool
copy or second installation is required. This option is never inferred or
enabled by default. When a state-aware forward has a pre-N2 source, require
the option and zero pre-existing v2 snapshots **before stop**; otherwise
refuse while the source is still running. Persist the explicit choice in
`returnToPreV2`, so an interrupted or failed forward can use the same selected
snapshot retirement for automatic recovery. A successful forward keeps its
snapshot. This preserves B9 instead of discovering after stopping the source
that its restart needs a new decision. An ordinary same-pin update that
creates no v2 record needs no such option.
Clear this choice on terminal settlement. A later independently requested
restore takes its choice from that command, never from an earlier successful
forward's permission. Resuming an unfinished operation preserves its saved
choice; it cannot grant itself permission to discard other snapshots.

A crash during this exit resumes with the same N2 tool and option. Before
`startRequested`, verify the promoted home against the saved state digest
even if the snapshot has already been pruned. Afterwards only the recorded
source startup is resumed. The old code cannot recover an interrupted v2
operation; removing a stale lock is not permission to use it. Explicit
snapshot loss on this path is a decision for design review, listed below.
For a never-started return, leave `prepared`/`snapshot-verified` unchanged
while pruning, then switch source, save `failed`, and start it. Resume-forward
with the now-retired snapshot refuses, but recover-source remains valid;
neither snapshot existence nor a live former owner proves never-started.

Every resumable switch accepts only its recorded before/after release IDs
as current; a third release refuses. Switching to an already-current ID is
idempotent and does not rewrite `previous`. Source-return holds the links
lock through recording `failed` and the source-start check, so temporary
tool protection cannot disappear while the worker still uses that tool.

## 8. Helper rewrite, deletion map and implementation checks

| Area | N2 change |
|---|---|
| `kaoiro-runner-codex-state.mjs` | Replace dual registries with v2 records and the eight phases; keep selected-record checks, snapshot guard, summary/target/protected; implement resume/recover/prune and old-record refusal |
| Same helper | Delete `staticShape`, `validateReceipt`, `validateTransactionState`, `acceptedEvents`, `acceptedHome`, `recoveryLineage`, `liveOwner`, `lockOwner`, `accept`, `retire`, `abandon`, `acceptedForwardTransaction`; remove legacy repair and acceptance exports after P3 consumers are gone |
| `codex-service.mjs` | Path agreement of section 3; retain installed-unit interpretation, private ownership and `assertStopped`; N1 already removes the foreign-UID walk |
| `codex-snapshot.mjs` | Retain classification/manifest verification/capacity; reduce binding metadata; durable copy publication; replace phase-per-credential callbacks with resumable replacement observation |
| `kaoiro-runner-update.sh` | Resume/recover options, durable start ordering, source-restart settlement, active/MainPID post-check, remove acceptance guidance and owner-proof cleanup |
| `kaoiro-runner-switch.sh`, `kaoiro-runner-install.sh` | v2 switch authorization and old-tool refusal; projection-based protection under links lock |
| `codexReceipt`, `codexLineage`, `codexLineagePending`, `codexLegacy` tests and lineage harness | Delete after reference sweep; keep minimal old-record cutover tests in `codexState` |
| `codexStateWorkflow`, `codexState`, snapshot/home classification tests | Replace retired-contract cases with the retained invariants and interruption exits; keep tests independently of the eventual N3 table |

Update only affected sections of `runner-update-and-rollback.md`,
`codex-home.md`, `runner-install.md`,
`reference/deployment/transactions-and-identity.md`, and ADR-0069. Remove
acceptance/receipt/lineage/abandon/evidence-retirement instructions and inbound
links. N2 documents its recovery commands; N3 consolidates their hints/table.
No server recovery, publication workflow, enrollment, native pin, package
lock or production configuration is changed by N2.

Implementation acceptance, run on the exact committed candidate through the
project's runner typecheck and full test suite in the remote test environment:

- Real shipped updater through its physical/symlink entry, disposable
  installation/home: cross-native forward, post-start completion, restore,
  same-pin update with a retained snapshot, and explicit old-tool return.
  Keep service-manager fakes for deterministic faults, and separately run
  disposable real-systemd start/stop/cgroup/path agreement controls before
  deployment. Never count synthetic service replies as systemd evidence.
- Kill the owned worker before/after snapshot rename and record publication;
  before start intent, after intent but before start, and after start but
  before completion. Dead-owner recovery must not depend on the original
  PID. At every cut, assert actual current link, service calls, record, home,
  snapshot/staging presence, and a completing recovery command.
- Interrupt before/after every home/credential rename and source-start
  request. Resume twice; no old credential bytes appear, current credential
  file/directory identities are preserved, and aside state is untouched.
  Missing/both credential locations refuse without overwrites.
- R2: partial staging, complete snapshot with `prepared` record, verified
  record without snapshot, and orphan snapshot. R7: kill during recursive
  deletion, retry after root disappearance, and reused root/symlink refusal.
- B2/B5/B6/B8 controls: unbacked cross-pin switch, populated cgroup after
  stop, corrupted snapshot, live home A versus next-start B, and next-start
  path changed after preparation. Refuse in the actual control flow and
  count zero subsequent switch/start/replacement calls where applicable.
- Same-path environment edit and inode change pass; real child `/proc`
  environment supplies the live path and fallback HOME, not fixture data.
  Defaults receive a production-composition lifecycle test as well as
  injected deterministic tests.
- Cutover: every old unfinished phase/unretired reference refuses; all
  terminal/retired old records pass despite obsolete receipt metadata.
  Legacy and v2 directories' bytes stay unchanged on refusal.
- Protected-release concurrency: two contenders, install replacement and
  snapshot publication, no protection gap; completed target/tool becomes
  prunable but snapshot source does not. Pre-N2 tool capability must refuse
  with a retained snapshot even when native hashes match.
- Mutate one new guard/phase-ordering branch or caller wiring at a time;
  corresponding tests must fail, then restore and rerun. At minimum remove
  the durable-intent write, the path comparison, the prune identity guard,
  and the pre-v2 activation check separately. Run mutations remotely.

## 9. Observation and limits

Measured on 2026-10-22 with the appendix recipe, using the production
`codex-snapshot.mjs` functions and the real shell `kaoiro_lock_acquire` from
baseline `8986936d9136fb7c7c7545f808543ceffe91dffd`. A disposable remote
`test` run reported **pass, exit 0**, no warnings/unhandled errors,
822 stdout bytes and 0 stderr bytes. The container image was
`sha256:ca00bbbd878662d0fec8acd87fffe50384a04aa93e25f4e0bcf7f6b3673296b4`.
The one-off probe is verification tier (c): actual product verification plus
a corrupt-payload negative control, rather than a new maintained checker.

| Observed event | Actual result | Design consequence |
|---|---|---|
| Snapshot published before phase save | Phase file still `prepared`; snapshot exists; staging absent; credentials omitted | A complete snapshot can precede its record checkpoint; R2 must reconcile it |
| Corrupt payload control | Production `verifySnapshot` threw | Hash verification is an effective check, not just metadata inspection |
| Two lock attempts with owner alive | Both exited 75; lock still exists | Directory exclusion works against a simultaneously alive owner; the two contender attempts were sequential |
| Owned child killed after credential move | Saved `credential-moved:auth.json`; H absent, S/Q present; credential only in S; lock remains; child signal `SIGKILL` | Process death neither rolls back renames nor releases directory locks |
| Old restore and lock retried | Both refused | New resume logic and explicit stale-lock handling are needed |
| Remaining promotion done with filesystem primitives | H present, S absent, Q preserved; credential inode unchanged; old snapshot history in H and newer history in Q | The observed interrupted layout has a non-copying completion path; this is not proof of the future v2 handler |
| One payload file removed after prune intent | Snapshot root still exists; old verification refuses | Prune retry must not require an intact manifest/payload |
| Prune completed | Snapshot absent; phase file says retired | Retirement can follow confirmed removal |
| Cleanup | Probe root absent | Probe-owned home, records, snapshot and locks were removed |

The appendixed source SHA-256 is
`bc2261f9b0bbddb71f30de793b7ab28c9743d832122ce372c276c5b5d3c907ed`;
the exact stdout SHA-256 is
`8f41ae9d0c03163fc7b13c484bde30f55b673a36ea578c4c347ce1a56d6fb3ec`.
Run it by saving the appendix body and passing it to the remote test helper
as `node --input-type=module -e <body>` against the clean baseline checkout;
no dependency preparation is needed. The appendix also accepts a checkout
argument when saved as a file.

These are observations of real record writes, snapshot verification,
directory locks, renames and process death. The v2 schema/phase logic is
proposed, not tested. Real systemd and Codex are not exercised here; their
existing stopped-service/path contracts are retained, and integration checks
remain implementation/deployment acceptance work. No claim about power-loss
survival follows from a process-kill experiment.

## 10. Decisions for review

1. **Explicit old-tool return:** prefer `--return-to-pre-v2`, required before
   a state-aware forward from a pre-N2 source, permitting retirement of only
   that operation's snapshot if source recovery is needed. Alternative: no
   automated pre-N2 return while v2 state exists and documented manual
   recovery; that would weaken B9 for the first N2 transition and must not be
   adopted implicitly. A mixed-code/native bridge release would add a new
   deployment topology and is outside N2. The preferred option needs the
   director's acceptance before implementation.
2. **One record per snapshot:** prefer replacing its restore-attempt fields
   for a new explicit restore, preserving earlier aside directories.
   Alternative: a separate restore record referring to the snapshot record;
   that needs cross-record settlement and buys history this scope retires.
3. **Temporary release protection:** keep physical tool/from/target only for
   an unfinished operation; retain only source for an idle snapshot. This
   interprets S16's in-flight replacement protection to include a forward
   operation's executing tool. If S16 is intended to exclude that lifetime,
   the director must settle the discrepancy before implementation.
4. **B1 during replacement:** prefer explicitly retaining the cooperative
   stopped-service contract, with the B1 limitation above corrected in the
   parent text. Alternative: require an explicit `CODEX_HOME` for state-aware
   operations (still not a full launch barrier). A new transaction-aware
   launch barrier would enlarge N2 and reintroduce a retired mechanism; do
   not silently add it. Resolve this wording/guarantee boundary before
   implementation.

None of these provisional choices authorizes new guarantees or production
changes. The director owns review dispatch and the eventual landing.

## Appendix: disposable primitive observation

This is a one-off observation recipe, not a shipped test or a prototype of
the v2 state machine. Save the fenced body as `lifecycle.mjs` and run
`node lifecycle.mjs <checkout>` against the baseline named above, inside the
disposable remote test environment. The phase file is deliberately minimal;
it observes `atomicJSON` persistence and the existing restore callback, not
the schema reader. No service manager or Codex native is started.

```js
import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const repo = process.argv[2] || '/w/repo';
const modulePath = join(repo, 'runner/deploy/codex-snapshot.mjs');
const s = await import(modulePath);
const dir = fs.mkdtempSync('/tmp/kogane-n2-lifetime-');
const home = join(dir,'home'), backup = join(dir,'backup'), stage = join(dir,'restore'), aside = join(dir,'aside'), record = join(dir,'record.json'), lock = join(dir,'.lock.update');
const emit = (event, data) => console.log(JSON.stringify({event,...data}));
const exists = p => fs.existsSync(p);
let child;
try {
 fs.mkdirSync(home,{mode:0o700}); fs.mkdirSync(join(home,'sessions'));
 fs.writeFileSync(join(home,'sessions/thread.jsonl'),'old-history');
 fs.writeFileSync(join(home,'auth.json'),'synthetic-credential');
 const authIno=fs.statSync(join(home,'auth.json')).ino;
 const uuid=randomUUID();
 s.atomicJSON(record,{phase:'prepared',uuid});
 const result=await s.snapshot(home,backup,{uuid,staging:join(dir,`.staging.codex-${uuid}`)});
 assert.equal(s.verifySnapshot(backup,result.sha256).uuid,uuid);
 assert.equal(exists(join(backup,'state/auth.json')),false);
 emit('snapshot-before-phase-save',{phase:JSON.parse(fs.readFileSync(record)).phase,snapshot:exists(backup),staging:exists(join(dir,`.staging.codex-${uuid}`)),credentialsOmitted:true});
 s.atomicJSON(record,{phase:'snapshot-verified',uuid});
 const payload=join(backup,'state/sessions/thread.jsonl');
 fs.writeFileSync(payload,'bad');
 assert.throws(()=>s.verifySnapshot(backup,result.sha256),/Snapshot payload mismatch/);
 fs.writeFileSync(payload,'old-history');
 emit('corrupt-payload-control',{refused:true});
 fs.writeFileSync(join(home,'sessions/thread.jsonl'),'new-history');
 s.prepareRestore(backup,result.sha256,home,stage);
 s.atomicJSON(record,{phase:'restore-prepared',uuid});
 const program=`import {promoteRestore,atomicJSON} from ${JSON.stringify(modulePath)}; import fs from 'node:fs';
fs.mkdirSync(${JSON.stringify(lock)},{mode:0o700});
promoteRestore(${JSON.stringify(home)},${JSON.stringify(stage)},${JSON.stringify(aside)},phase=>{atomicJSON(${JSON.stringify(record)},{phase}); if(phase==='credential-moved:auth.json'){process.stdout.write('ready\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}});`;
 child=spawn(process.execPath,['--input-type=module','-e',program],{stdio:['ignore','pipe','pipe']});
 await new Promise((ok,fail)=>{child.stdout.once('data',ok);child.once('error',fail);child.once('exit',c=>fail(new Error('child exited early '+c)));});
 const contender=()=>spawnSync('/bin/sh',['-c','. "$1"; kaoiro_lock_acquire "$2"','probe',join(repo,'runner/deploy/kaoiro-runner-common.sh'),lock],{encoding:'utf8',env:{PATH:process.env.PATH}});
 const a=contender(), b=contender(); assert.equal(a.status,75);assert.equal(b.status,75);
 emit('contenders-while-owner-alive',{exit:[a.status,b.status],lock:exists(lock)});
 const exited=new Promise(ok=>child.once('exit',(code,signal)=>ok({code,signal})));
 child.kill('SIGKILL'); const death=await exited;child=undefined;
 const state={phase:JSON.parse(fs.readFileSync(record)).phase,home:exists(home),stage:exists(stage),aside:exists(aside),credentialInStage:exists(join(stage,'auth.json')),credentialInAside:exists(join(aside,'auth.json')),lock:exists(lock),...death};
 assert.equal(state.home,false);assert.equal(state.credentialInStage,true);assert.equal(state.credentialInAside,false);
 assert.equal(fs.statSync(join(stage,'auth.json')).ino,authIno);
 emit('after-owner-death',state);
 assert.equal(contender().status,75);
 assert.throws(()=>s.promoteRestore(home,stage,aside,()=>{}));
 emit('old-restore-rerun',{refused:true,staleLockStillRefuses:true});
 fs.rmdirSync(lock);assert.equal(contender().status,0);
 fs.renameSync(stage,home);
 s.atomicJSON(record,{phase:'restored',uuid});
 assert.equal(fs.readFileSync(join(home,'sessions/thread.jsonl'),'utf8'),'old-history');
 assert.equal(fs.statSync(join(home,'auth.json')).ino,authIno);
 assert.equal(fs.readFileSync(join(aside,'sessions/thread.jsonl'),'utf8'),'new-history');
 emit('manual-finish-primitives',{phase:'restored',home:true,stage:exists(stage),aside:exists(aside),credentialInodePreserved:true});
 fs.rmdirSync(lock);
 s.atomicJSON(record,{phase:'restored',uuid,prune:'intent'});
 fs.rmSync(payload);assert.throws(()=>s.verifySnapshot(backup,result.sha256));
 emit('partial-prune',{recordedIntent:true,snapshot:exists(backup),oldVerificationRefuses:true});
 fs.rmSync(backup,{recursive:true});s.atomicJSON(record,{phase:'restored',uuid,prune:'retired'});
 emit('pruned',{snapshot:exists(backup),phase:JSON.parse(fs.readFileSync(record)).prune});
} finally {
 if(child){const exited=new Promise(ok=>child.once('exit',ok));child.kill('SIGKILL');await exited;}
 fs.rmSync(dir,{recursive:true,force:true});emit('cleanup',{remaining:exists(dir)});
}
```
