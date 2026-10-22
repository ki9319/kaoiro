# P3: retire completion and enrollment

Status: proposed; design review r1. Implementation classification: L (server
and runner launch paths, shared safety checks and CLI/record consumers).
Source baseline: `2d3040de0b5213a622df6b5c75f64ba49325f1d3`.
Parent: [release reduction](issue-709-release-reduction.md), sections 3.4–3.6
and P3 in section 7. This document authorizes no production operation.

## 1. Contract and landing order

P3 removes the completion/enrollment system, including its admission checks,
receipts, retained workers and pinned tool copies. A release descriptor no
longer selects a different deploy/update path. The remaining commands deploy
and verify the chosen artifact through their ordinary paths.

Preserve ordinary deployment/update/link locks; prepare-before-stop ordering;
server health and complete SHA checks; runner artifact verification,
`--version --json` attestation and registration matching; source recovery on
failed switch; ordinary `--detach`; and all native Codex state protection.
In particular, do not remove a native-state guard merely because its caller
was near an enrolled branch. `acceptedForwardTransaction` loses its collector
consumer here, but its export and implementation retire in N2.

P1 is present at this baseline. The director reports C1 and C2 complete; this
design does not independently establish production enrollment or tag rules.
P3 implementation lands only after P2 and issue #695 L1b/L4/L5. Use their
integrated tree as the implementation base, or have the director transplant
the reviewed change onto it and reconcile the overlap before landing. Do not
reintroduce an old recovery table or replace the new L1b/L4/L5 tests with the
baseline versions. Re-enumerate affected cases on that tree and extend the
appendix for any new case. P2 owns workflow/landing/card deletion; P3 owns the
remaining completion consumers. P2 must split mixed test files as needed so
its own commit remains executable.

No deployment protocol, journal phase, service-manager lifetime or new lock
is introduced. Native-state reduction, allocation/tag policy, new child
environment profiles and unrelated deployment fixes are outside P3.

## 2. Delete the consumers and their implementation

Paths below are relative to the repository. Whole-file deletion includes all
private helpers; the named functions identify the responsibilities removed.
P2-owned `production-release-card.mjs`, `production-release-workflow.mjs` and
`release-automation-gate.mjs` are prerequisites, not additional P3 work.

| Delete file | Functions / entrance removed |
| --- | --- |
| `scripts/collect-production-release.mjs` | `collectRunnerBaseline`, `collectExecutedRunnerAudit`, `collectRunnerCompletion`, `collectServerCompletion`, `acknowledgeReleaseAttempt`, `enrolledCollectionContext`, `runCollectionCli` |
| `scripts/production-runner-worker.mjs` | `queueProductionRunner`, `cleanupProductionRunner`, `inspectProductionRunnerActivity`, `listRetainedProductionRunners`, `archiveRunnerWorkingCopy`, `runWorkerCli` |
| `scripts/production-release-authority.mjs` | `readReleaseAuthority`, `releaseSshArguments`, `releaseAuthorityRequest`, descriptor/path validation |
| `scripts/production-release-endpoint.mjs` | `validateReleaseRequest`, `validateNativeRunnerFact`, `importReleaseFact`, `releaseRequest`, `runReleaseEndpoint` |
| `scripts/production-release-files.mjs` | release-file IO, `acquireReleaseLock`, `releaseReleaseLock`, `withReleaseLock`, `withAsyncReleaseLock`, `releaseEntryInventory`, `recoverReleaseResidue`, `attemptDirectory` |
| `scripts/production-release-history.mjs` | evidence/row digests, `validateIncident`, `activityFor`, `readReleaseAttempt`, `readReleaseHistory`, `readArchivedReleaseIncidents`, `projectReleaseHistory` |
| `scripts/production-release-launcher.mjs` | `verifyLauncherClosure`, pinned CLI dispatch |
| `scripts/production-release-lifecycle.mjs` | `readLifecycleInspection`, `terminateReleaseAttempt`, `archiveReleaseAttempt`, `runLifecycleCli` |
| `scripts/production-release-plan.mjs` | runtime-host/authority/inventory/projection/plan validators, `enrolledHealthUrl`, `projectEnrollmentInventory`, `projectReleasePlan` |
| `scripts/production-release-reconciliation.mjs` | `validateReleaseSnapshot`, `selectOwnReleaseAttempt`, `assertReleaseUnresolved`, `preflightReleaseAuthority`, `reconcileProductionReleases`, `runReconciliationCli` |
| `scripts/production-release-record.mjs` | `receiptDigest`, `validateProductionRunner`, `validateProductionReceipt`, `startReleaseAttempt`, `assertCompletionEnrollment`, `completeReleaseAttempt` |
| `scripts/production-release-runner.mjs` | `resolveRunnerReleaseAlias`, `auditRunnerRelease`, `sealRunnerSwitch`, `verifyRunnerSwitch`, `cleanupRunnerRelease`, `runRunnerReleaseGate` |
| `scripts/production-release-runner-facts.mjs` | context/fact validators, `canonicalRunnerReleaseRow`, `recordExecutedRunnerRelease`, `runnerReleaseFact`, `importRunnerReleaseFact`, `recordRunnerReleaseActivity`, `installRunnerReleasePlan` |
| `scripts/production-release-state.mjs` | release grammar/constants, `releaseName`, `assertGrammarCoverage`, `classifyReleaseState`, `releaseStateTable`, `validateReleaseReason`, `validateReleaseContext`, `validateReleaseSkip`, `parseReleaseOptions` |
| `scripts/production-release-tags.mjs` | `readPublishedProductionRelease`, `publishProductionRelease` (completion publication, not build identity's retained schema-1 reader) |
| `scripts/production-release-tools.mjs` | `collectReleaseToolClosure`, `verifyReleaseToolClosure`, `stageReleaseTools`, `installReleaseTools`, `currentReleaseToolRoot` |
| `scripts/production-release-unit.mjs` | `unitSnapshot`, `unitCommandSnapshot`, `verifyRetainedUnitCommand` |
| `runner/deploy/release-gate.mjs` | descriptor-selected launcher CLI |
| `server/deploy/kaoiro-release-reconciliation.mjs` | `auditServerRelease`, `bindServerReleaseAudit`, `assertServerResumeContext`, `acquireServerReleaseActivity`, `releaseServerReleaseActivity` |

Change these surviving files narrowly:

| File | Removed branch / retained behavior |
| --- | --- |
| `runner/deploy/kaoiro-runner-common.sh` | Remove `kaoiro_release_gate` and `kaoiro_release_enrolled`; retain all ordinary and native-state helpers. Add the warning described below. |
| `runner/deploy/kaoiro-runner-update.sh` | Remove `release_audit`, release flag parsing/forwarding, both enrolled audits, pinned-launcher selection in detach, seal/proof reads and release-owner/runner-cleanup handling. Keep `.lock.update`, `.lock.links`, Codex owner/transaction cleanup and cleanup-failure lock retention. |
| `runner/deploy/kaoiro-runner-switch.sh` | Remove `release_manual`, release-only manual update-lock ownership/cleanup, audit/seal/proof verification before and after link-lock acquisition, and release flag parsing. Keep the link lock, artifact/identity/native-state guards and link ordering. |
| `runner/deploy/kaoiro-runner-bootstrap.sh` | Remove enrolled `runner-audit` before install; retain argument/config validation, dry-run, wizard/install and optional service setup. |
| `scripts/build-runner-tarball.sh` | Remove only release-tools staging. Keep CLI/shim checks, runtime `MANIFEST.json`, source identity check and archive/staging cleanup. |
| `server/deploy/kaoiro-server-deploy.mjs` | Remove the two deleted-module imports, release value flags, `runUpdate` admission/under-lock audit and resume/bind/context writes; remove release activity locking from `runBuild`, `runStart`, `acquireDeploymentLocks`/`releaseDeploymentLocks`. Simplify `heldLockSteps` to the deployment lock; remove `RELEASE_LOCK_HELD_RE`, descriptor error reporting, its `authorityError` result and `runStatus`'s `lockAuthorityError`. `invocationOf` records repo/config only. Drop `releaseReconciliation` dry-run output and new journal `release_context`/`release_reconciliation` fields. Retain ordinary locking and all phase/restore/health logic, including L1b/L4/L5. |
| `server/deploy/kaoiro-deploy-recovery.mjs` | `isInvocation` checks repo/config only; `baseArgv` and `renderRecovery` stop emitting release flags. Preserve target, transaction, config, refusal conditions, placeholders and explicit restore approval. |

Remove updater/switch options `--release-repo`, `--release-authority`,
`--release-attempt`, `--release-plan-sha256`, `--skip-release-reconciliation`,
`--skip-reason`, `--expected-authority-sha256`, `--release-target`,
`--release-alias`, and switch-only `--release-invocation` /
`--release-proof-sha256`. Remove the corresponding subset from the server
parser. Each retired option becomes an unknown-argument error before queue,
stop, Docker, link mutation or transaction creation. Do not silently discard
operator-supplied old flags. Ordinary `--repo`, `--target`, `--config`,
`--transaction`, `--detach` and native-state options retain their semantics.

### Keep the child-environment checker independent

`scripts/check-release-child-environments.mjs` still has consumers:
`scripts/test/child-process-environment.test.mjs`, `build-identity.mjs` and
`with-build-identity.mjs` checks. The parent's conditional deletion does not
apply. Keep its CLI/export and existing checks; replace its import of
`collectReleaseToolClosure` with local source-file enumeration. Enumerate the
same four directories (`scripts`, `scripts/lib`, `server/deploy`,
`runner/deploy`) and follow literal relative `.mjs` imports as today, within
the repository, with the existing file bound. Keep regular-file/no-symlink
checks for traversal; do not retain tool manifests, hashing, ownership-based
enrollment or pinned-copy installation solely for this checker.

Remove only deleted paths from `CHILD_ENVIRONMENT_SCOPE`. Retain the exact
legacy-call allowlist and checks for new raw imports/calls, helper import and
checked-call presence. Reconcile any already-landed child-environment change
before editing this table; never increase an allowance to make deletion pass.
Keep both shared child-environment modules and their profile semantics.

## 3. Remaining launch and recovery paths

| Entrance | Path after P3 |
| --- | --- |
| Server build/start | Parse/configure → ordinary deployment lock → existing build/start checks and action → release that lock. No history authority/exporter/second lock. |
| Server update/rollback | Existing validation/dry-run → ordinary lock → phase-table action → existing stop/restore/start/health/full-SHA handling → journal and recovery hints. Enrollment never vetoes or approves a phase. |
| Runner update | Validate → generic detach submission if requested; otherwise `.lock.update` → prepare/verify artifact and native state → stop → switch under `.lock.links` → start → attestation/registration check → existing prune/cleanup. |
| Runner switch/rollback | Validate → `.lock.links` → verify target and retained native-state permission → update current/previous. No release-proof bypass. |
| Runner bootstrap | Validate/configure → existing dry-run or install/service setup. No release exporter. |
| Detached runner worker | Queue the physical updater script with its ordinary argv/env. Keep `--user`, `--no-block`, `--expand-environment=no`, independent unit, queue failure behavior and the distinction between ENQUEUED and completed. No retained production-worker protocol. |

For server `runBuild`/`runStart`/`runUpdate`/`runRollback`/`runStatus` and the
three runner entry scripts, once the installation path is known, check only
the presence of the fixed legacy descriptor (server
`.kaoiro-release-authority.json`, runner `release-authority.json`). An existing
file, directory or dangling link produces one fixed stderr warning that
enrollment is retired and the descriptor is ignored. Do not parse it, follow
its link, reveal its contents, start its exporter, or consult its history.
A metadata-read failure also cannot revive admission refusal; warn that any
legacy descriptor is ignored. Keep stdout machine-readable. Each entrance
emits at most one line; a nested updater/switch may each emit it, without a
new deduplication flag or persistent record.

C1 handled old enrollment before cutover. P3 does not delete, archive, repair
or reclassify descriptors, `production-attempts`, completion receipts, release
locks or old release-tools directories. They are inert bytes to the new
code. A held legacy `.lock.server` does not block P3; the ordinary deployment
lock still does. There is no new cleanup command.

Old server journals remain readable. Unknown legacy `release_context`,
`release_reconciliation` and `invocation.release_authority` fields are ignored
for execution and left on disk; their contents must not invalidate an
otherwise valid repo/config invocation. New journals omit them. Recovery
from an old journal renders only current arguments and continues through the
unchanged phase restrictions. Missing invocation still renders placeholders;
malformed repo/config/target still refuses. Do not migrate phases or rewrite
journals just to remove unused fields. Old tools need no new P3 record
reader, but returning to old tooling with a restored descriptor can activate
old enrollment again; C1's archived state must stay out of its active paths.

## 4. Case migration and implementation checks

The [case ledger](issue-709-p3-test-cases.md) is part of this design. R means
the contract retires; K names a retained obligation and destination below.
A mixed case lists both. Move each K assertion to an ordinary-path test
before deleting its source; a replacement must test the retained mechanism,
not reproduce an enrolled fixture whose precondition disappeared. Record
final test names and mutation results alongside the implementation review.

| Group | Destination and required check | Negative control / mutation |
| --- | --- | --- |
| K1 runner lifecycle | `runner/test/releaseUpdate.test.ts` / `releaseSwitch.test.ts`: actual scripts, stop→switch→start, current/previous, `.lock.update` and `.lock.links`, failed post-stop switch restarts unchanged source. Existing ordinary cases can absorb assertions. | Bypass ordinary update/link lock guards separately; suppress source restart after a retained switch failure. Each corresponding test must fail. Never use removed proof validation as the failure trigger. |
| K2 ordinary detach | `releaseUpdate.test.ts`: physical script, literal argv (spaces, `$`, `%`), explicit safe env/no token leak, independent unit, submit failure has no ENQUEUED/no stop, caller death does not kill owned worker. | Remove `--expand-environment=no`, bypass queue error, or forward a forbidden ambient variable: matching tests fail. Keep the owned-child caller-death test; no host-wide PID enumeration. Typed retained-worker inspection and completion imports retire. |
| K3 server recovery | `server/deploy/test/recovery.test.mjs` and `recovery-property.test.mjs`: execute printed commands after actual owned CLI kill, ordinary held-lock refusal and status hints, update/rollback completion, old-journal extra fields ignored, repo/config/target/restore approval preserved. | Bypass ordinary deployment lock; omit recorded repo/config from rendered argv; weaken repo/config validation or a retained restore/phase refusal: corresponding tests fail. Keep L1b/L4/L5 fault schedules and archive/volume invariants from their landed tree. |
| K4 child environment | `scripts/test/child-process-environment.test.mjs`: retain default real-child and operation-profile tests. Retarget bypass probes to surviving checked sources, not removed authority/SSH code. Check directory enumeration plus a newly added relative-import dependency. | Raw import without call; spawn/fork; legacy count change; missing helper import/call; unchecked source in another scanned directory or imported dependency must each fail. Disable checker rejection/enumeration once in the test harness and confirm red. |
| K5 artifact/start boundary | `runner/test/releaseInstall.test.ts`, `releaseUpdate.test.ts`, `releaseBootstrap.test.ts` and an isolated real-artifact check: build a real runner tarball, assert no release-tools/release-gate, run its CLI and launch-shim validation and strict manifest verification; preserve machine identity and production activation checks. | Remove a required runtime module or mismatch the artifact's full SHA: reject before stop/link change. Remove the verifier invocation in the script: corresponding test fails. |

Add contract-removal checks using the actual entry scripts/functions and
isolated fake Docker/service-manager/registration endpoints:

1. All retired flags reject before side effects, with and without a legacy
   descriptor. Measure stop/start/queue/Docker calls and journal/link bytes;
   an unknown argument must not be accepted merely because its code vanished.
2. Without descriptor, exercise ordinary paths first with no enrollment
   dependency injected. Then repeat with invalid JSON, directory and dangling
   descriptor link; plant an exporter that fails/writes a marker if launched,
   unfinished history and a legacy release lock. Expect the same deployment
   decisions, fixed warning only, zero exporter calls and byte-for-byte old
   records. Pair with ordinary held-lock/invalid-artifact controls that still
   refuse; absence of enrollment must not imply unconditional success.
3. For server recovery, use a valid pre-P3 journal containing retired fields;
   execute printed update/rollback argv and verify no retired flags. Include
   malformed *retired* metadata as a positive ignored-field case and malformed
   repo/config/target as negative cases. New journal creation omits old fields.
4. Run an upgrade from a pre-P3 **not-enrolled** source using the actual newly
   built tarball, then an update launched through the new physical updater.
   This covers both the first rollout and the path after rollout; fake only
   external services, not the shell scripts or artifact verifier. Bootstrap
   dry-run/install/optional service paths must likewise need no release tools.
5. Confirm the warning test becomes red when its call is removed. Confirm a
   stale-descriptor test becomes red when old admission/exporter access is
   restored. Keep these mutations disposable; restore and rerun the final
   artifact. If any transferred guard remains unpinned, report it and do not
   count the migration as finished.

Run implementation checks on the integrated commit via the prescribed remote
test runner: runner build/typecheck/full tests; `node --test` in
`server/deploy`; surviving scripts tests; child-environment and test-isolation
checkers; actual tarball build/strict verification. Use the package/CI commands
from that tree, including prerequisite wrapper build. Mutations also run in
isolation. Real user-service behavior, if affected beyond ordinary argument
construction, needs an owned disposable unit outside production; a fake
manager is not evidence of real service-manager lifetime. No production unit
or host setting is changed for P3 validation.

## 5. Import closure, CI and documentation

Before deleting modules, enumerate tracked imports, dynamic imports, shell
calls and CI commands for every deleted filename. Afterward repeat the sweep:
executable consumers must be zero, while historical ADR/plan references may
remain. Load surviving checker and server modules in the isolated test run;
exercise actual runner entry scripts and the built artifact, rather than
relying on a text search to prove the graph is intact. Keep build identity,
schema-1 tag reading, runtime manifest tools, ordinary deploy lock/phase
modules and native-state helpers even if an exported function loses a P3
consumer.

Remove `server/deploy/test-support/fake-release-exporter.mjs` after its cases
move. Remove permissions for the deleted native/unit tests from
`scripts/test/fixtures/test-isolation-permits.cjs`. Remove CI's
`release-identity` job after P2's landing tests and P3's completion tests are
gone. Keep runner and server-deploy jobs, and ensure the surviving
child-environment/checker tests run in CI (add an explicit step to the
existing test-isolation job if no existing job runs them). Deleting the old
job must not delete a retained assertion's only execution path. In review,
check that the final workflow includes the exact surviving test command;
temporarily remove the step and confirm that this check fails. This can be a
disposable static check; P3 does not require a new permanent CI framework.

Update the parent's listed operations/reference pages: remove enrollment,
common production checkpoint, reconciliation/release-state table and removed
CLI recipes from `build-identity-and-release-tags.md`; adjust
`runner-update-and-rollback.md`, `server-update-and-rollback.md`,
`runner-install.md`, `reference/deployment/transactions-and-identity.md` and
`docs/README.md`. Also fix any live removed-command guidance in
`high-risk-change-release.md`. Explain the ignored-descriptor warning,
unchanged health/identity checks and ordinary recovery commands. Regenerate
the server recovery table from its current source; remove enrolled lock
instructions without weakening ordinary stale-lock ownership checks. Keep
ADRs and historical plans as history, linking the current runbook where
necessary. No production inventory or private paths belong in these docs.

Design evidence is source inspection at the baseline and the case ledger;
the implementation checks above are requirements, not claimed test results.
