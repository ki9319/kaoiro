# P3 case migration ledger

Part of [P3 design](issue-709-p3-completion-retirement.md). Source coordinates
are fixed to `2d3040de0b5213a622df6b5c75f64ba49325f1d3`; line numbers identify
cases, not ranges. A template title denotes every generated leg of that
declaration. Reconcile this ledger with P2 and issue #695 before implementation.

- R1: retired completion/attempt/history/fact/acknowledgement contract.
- R2: retired enrollment/authority/reconciliation/admission contract.
- R3: retired pinned-tool/proof/dedicated retained-worker contract.
- R4: retired automatic publication/landing/receiver contract; P2 ownership
  is called out where it deletes the entrance first.
- K1–K5: retained invariants, destinations and required mutations in section 4
  of the design. A mixed row retires only its R assertions; migrate its K
  assertions before removing the case. These are implementation obligations,
  not claims of an already-passing replacement test.

## Files deleted after the retained assertions move

### `scripts/test/production-release.test.mjs`

| Baseline line | Case | Disposition |
| --- | --- | --- |
| 117 | activation binds both mandatory gates to the actual reviewed control commit | R4 (P2) |
| 136 | a bounded completion requires all independently completed legs | R1 |
| 160 | stable attempts publish once outside ordinary transaction retention | R1 |
| 230 | the execution card requires Codex acceptance only on its fixed selected hosts | R1 |
| 292 | the workflow audits all tags before returning an existing claim | R4 (P2) |
| 374 | a redeploy with a new UUID reuses the immutable first release tag | R4 |
| 398 | only remote tag and claim read-back acknowledges a durable completed attempt | R1/R4 |
| 444 | an atomic release publication cannot leave only its public tag | R4 |
| 471 | forced/deleted and untrusted origins never become original landing records | R4 (P2) |
| 509 | receiver authorization covers original and rerun actors | R4 (P2) |
| 543 | host authority requires an array instead of substring matching a string | R1 |
| 558 | fake dependencies cannot record a production completion | R1 |
| 574 | the operator card binds the fixed workflow/ref and audit reports omitted publication | R4 (P2 card) / R1 (completion audit) |

### `scripts/test/production-release-authority.test.mjs`

| Baseline line | Case | Disposition |
| --- | --- | --- |
| 140 | default authority constructor reaches the real verified endpoint and first history snapshot | R2 |
| 179 | the real exporter refuses a request root different from its fixed command argument | R2 |
| 187 | verified launcher refuses missing or extra fixed authority root arguments | R3 |
| 198 | endpoint itself refuses missing, relative and noncanonical fixed roots | R2 |
| 211 | complete CLI carries fixed enrollment inventory to the server collector | R1 |
| 232 | snapshot warning and administrative diagnostics have bounded safe grammar | R2 |
| 248 | missing descriptor is generic, but enrolled missing authority and another root cannot silently pass | R2; generic operation without descriptor → K1/K3 |
| 287 | SSH argv fixes the identity and host key options without agent or expansion fallbacks | R2/R3; shared closed-child environment → K4 |
| 329 | closure is derived from actual first-party sources; linked or changed modules fail before endpoint import | R3; source traversal for surviving checker → K4 |
| 358 | the launcher independently rejects foreign ownership of its manifest, module and actual deploy file | R3 |
| 387 | SSH authority checks private key metadata without reading the key bytes | R2 |
| 408 | the tooling verifier rejects foreign ownership of the actual updater independently of the launcher | R3 |
| 428 | the server audit constructor excludes ambient Node injection from its exporter child | R2; shared loader-injection exclusion → K4 |
| 444 | fixed importer keeps an identical retry idempotent while refusing changed bytes and stale new writes | R1 |
| 532 | the shared skip guard preserves an exact UUID set rather than a global waiver | R2 |
| 555 | server prepare refuses its enrolled history before Docker or transaction creation, including dry-run | R2 (enrollment refusal before side effects); ordinary refusal controls → K3 |
| 603 | server repeats its audit under the deployment lock before prepare observes Docker | R2 (audit under lock); ordinary deployment lock → K3 |
| 651 | only snapshot_changed retries; malformed projections, missing authoritative root and expiry refuse | R2 |
| 707 | real owned shell lineage seals and consumes the local switch proof without calling its unavailable exporter | R3 (lineage/proof); update-lock cleanup and successful switch → K1 |
| 858 | the native update entrance cannot bypass an enrolled server activity lock | R2 (release activity lock); ordinary deployment lock → K3 |
| 906 | the real exporter projects enrollment aliases and digest without private host IDs or install paths | R2 |
| 933 | default preflight uses three real endpoint reads through the verified launcher | R2 |
| 961 | preflight refuses a 15001 ms successful read and never starts another sample | R2 |

### `scripts/test/production-release-state.test.mjs`

| Baseline line | Case | Disposition |
| --- | --- | --- |
| 128 | production-default start through first history read uses real ownership, durable writes and grammar | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 137 | grammar coverage rejects old-class unknown lock and new-class unknown quarantine independently | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 157 | coverage checker self-test detects an observed name missing from the source table | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 197 | recognized stale root lock is diagnostic; unknown entry is a refusal | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 209 | quarantine closes known corruption without claiming publication and preserves bytes | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 243 | corrupt quarantine record has a resumable evidence-preserving exit | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 268 | empty legacy UUID is known-invalid and can quarantine using the enrolled inventory | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 283 | quarantine refuses valid in-progress and unknown identity records | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 295 | ordinary abandonment refuses each applied/live/activity condition | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 335 | lock grammar rejects an unescaped separator independently for every lock class | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 346 | retire-deployed refuses when the ${leg} leg remains at the target | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 361 | unused idle attempt abandons; terminal bytes are immutable and archivable | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 371 | archive refuses active state, existing destination and unsafe type | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 392 | own context, exact skip set and Unicode reasons fail closed | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 418 | completion independently rejects a missing server or runner enrollment proof | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 494 | archival keeps incident warnings and refuses an unresolved entry moved into the archive | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 515 | the actual lifecycle CLI inspects and preserves ownerless locks and staged files | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 577 | terminal transitions exclude an enrolled server prepare even while its healthy revision is old | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 590 | the enrolled server activity constructor uses the fixed server descriptor and contends with terminal commands | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |
| 646 | the operation state table is generated from the source grammar without documentation drift | R1/R2/R3 (release-history grammar/lifecycle only; not the ordinary deploy/update locks) |

### `scripts/test/production-release-native.test.mjs`

| Baseline line | Case | Disposition |
| --- | --- | --- |
| 53 | an owned real retained worker connects native invocation, updater proof, imported completion and exact cleanup | R1/R3 (retained unit/import/cleanup); actual updater target switch → K1; independent worker execution → K2 |

### `scripts/test/production-release-review.test.mjs`

| Baseline line | Case | Disposition |
| --- | --- | --- |
| 20 | public alias refuses a raw runtime ID and its dictionary-checkable host hash | R2 |
| 29 | completion and lifecycle resolve their health URL from the fixed inventory before external reads | R1/R2 |
| 43 | the queue JSON envelope accommodates 100 UUID skips while each updater value remains bounded | R3 |

### `scripts/test/production-release-unit.test.mjs`

| Baseline line | Case | Disposition |
| --- | --- | --- |
| 14 | typed unit verification distinguishes argv boundaries and requires the actual expansion flag | R3 (typed reader); literal argv / no expansion → K2 |
| 24 | the production reader verifies its own real timer-shaped units through ExecStartEx | R3 (retained timer lifetime/reader); ordinary launch expansion flag → K2 |

### `scripts/test/production-runner-worker.test.mjs`

| Baseline line | Case | Disposition |
| --- | --- | --- |
| 213 | the default queue constructor reaches the real canonical importer before submitting a fake manager command | R1/R3 (canonical baseline/intent); no credential forwarding / submission is not completion → K2 |
| 255 | uncertain submission remains reserved and canonical intent is not silently idle | R3 (reservation); queue failure must not report success → K2 |
| 268 | invalid queue arguments and a unit collision refuse before submission | R3 (dedicated queue validation); manager refusal before work → K2 |
| 288 | a queue UUID skip for A does not cover an older in-progress B | R2 |
| 317 | cleanup cannot use a runner-local fabricated completion as authority | R1/R3 |
| 335 | completion rejects a worker without the independently enrolled baseline | R1 |
| 361 | the real plan-transfer constructor commits only bytes that match the canonical private plan | R1 |
| 413 | the collection CLI freezes the fixed enrollment and refuses arbitrary output paths | R1/R2 |
| 473 | native activity inspection closes uncertain intent only after exact units are idle | R3 |
| 533 | a planless lifecycle event uses the full fixed enrollment instead of a damaged plan | R1/R3 |
| 576 | the default quarantine CLI resolves empty, corrupt-plan and corrupt-terminal records through native inventory evidence | R1/R2 |
| 685 | queue rejects Unicode control values before manager submission | R3 |
| 693 | the actual queue CLI accepts a JSON envelope larger than 4096 bytes before checking each value | R3 |
| 705 | retained listing checks raw names and keeps corrupt working attempts visible | R1/R3 |
| 722 | lifecycle context rejects changed damaged bytes before its native activity can be imported | R1 |

### `runner/test/releaseReconciliation.test.ts`

| Baseline line | Case | Disposition |
| --- | --- | --- |
| 65 | the real enrolled updater audits, seals its proof, switches, and releases its lock | R2/R3 (audit/proof); update ordering/current/lock cleanup → K1 |
| 76 | own X continues through the actual worker, and the post-stop switch needs no exporter | R2/R3 (own attempt); worker succeeds without publication exporter → K1 |
| 84 | an enrolled updater exempts its own X and refuses a different in-progress Y before stop or detach | R2 |
| 96 | the actual worker repeats its audit under the update lock before preparing an archive | R2; ordinary update-lock exclusion → K1 |
| 110 | ordinary enrolled detach captures the launcher, authority and closure before its worker can execute | R3 (launcher/closure); physical argv / no expansion / no stop before worker → K2 |
| 129 | a late proof refusal restarts the unchanged source | R3 (proof refusal); post-stop switch failure restarts unchanged source → K1 |
| 138 | a direct enrolled switch cannot use an exact UUID skip for A to cover unfinished B | R2; ordinary link-lock exclusion → K1 |

## Cases rewritten in surviving files

Every case changed to remove enrollment-specific assertions is listed here.
Cases that only use an updated shared fixture retain all their assertions;
the recovery phase-table and fault-schedule suites are not candidates for deletion.

| File / baseline line | Case | Retire / preserve and transfer |
| --- | --- | --- |
| `server/deploy/test/recovery.test.mjs:109` | rendered commands carry the recorded repo, config and release context | R2 release argv; K3 repo/config/target/transaction/restore rendering. Add old-to-new ignored-metadata and new-to-old discovery cases; the new writer keeps release_authority: null. Malformed retained fields still fail. |
| `server/deploy/test/recovery.test.mjs:151` | a malformed recorded target or invocation is refused, never tolerated as an extra field | R2 validation of release_authority; K3 target/repo/config validation. Relative release_authority becomes ignored extra metadata, while relative repo/config stays rejected. |
| `server/deploy/test/recovery.test.mjs:173` | the release module's held-lock message is the one the lock refusal reads | R2 only; delete with RELEASE_LOCK_HELD_RE. Ordinary lock diagnostics remain K3 in the property case below. |
| `server/deploy/test/recovery-property.test.mjs:574` | recovery property: an enrolled server killed mid-rollback leaves both locks, and the printed steps recover it | R2 descriptor, second lock and release lifecycle recovery commands; K3 actual CLI kill, ordinary lock refusal, status/printed recovery and completed rollback. Rewrite in place with the ordinary fixture. Keep the landed L1b schedule. |
| `server/deploy/test/recovery-property.test.mjs:631` | recovery property: an enrolled update resume runs as printed with its release context, and is refused without it | R2 audit binding and refusal when release argv are omitted; K3 executable printed repo/config/target/transaction. Rewrite in place: old release metadata does not produce obsolete argv and ordinary resume succeeds. Keep landed L4/L5 conditions and negative controls. |
| `scripts/test/child-process-environment.test.mjs:34` | each operation's explicit keys preserve only its intended authority | R3 forwarding of KAOIRO_RELEASE_RETAINED_UNIT; K4 all other per-profile authority limits. Add the retired key to input and require it absent; restoring that one allowlist member must turn the assertion red. |
| `scripts/test/child-process-environment.test.mjs:58` | existing authority and new repair SSH launches both exclude ambient secrets | P2 retires repair SSH; P3 retires authority launch (R2/R4). K4 shared environment isolation remains in the real-child cases at lines 23, 34, 45 and 108; move any distinct forbidden-key assertion there before deleting this entrance-specific case. |
| `scripts/test/child-process-environment.test.mjs:83` | coverage check rejects separate existing and new bypasses and its own disabled guard | K4. Replace deleted source targets with build-identity / with-build-identity and retain the disabled-guard mutation. Recompute counts from the integrated tree, not an assumed constant. |
| `scripts/test/child-process-environment.test.mjs:95` | coverage pins import-only, spawn/fork, exact legacy count and both scope-presence checks | K4. Retain every rejection; include a new scanned file and imported dependency to pin replacement enumeration. |
| `runner/test/releaseCleanup.test.ts:10` | update cleanup retains recoverable ownership after $failRemoval removal failure and gate $gateStatus (five it.each legs) | R3 release-gate failure legs; K1 build/Codex-owner removal failure, link-lock release and update-lock/owner retention, plus successful cleanup. Rewrite in place without release-owner/gate stubs; see the leg mapping below. |
| `runner/test/releaseUpdate.test.ts:205` | independent detached argv and no work in caller | K2. Absorbs the retained detach/env assertions; keep ordinary no-descriptor setup and add descriptor-ignored variants separately. |
| `runner/test/releaseUpdate.test.ts:425` | stop → switch → start | K1. Absorbs successful ordinary worker / lock cleanup assertions from deleted reconciliation cases. |
| `runner/test/releaseUpdate.test.ts:599` | failed switch restarts the old release | K1. Absorbs late proof-failure recovery intent using a retained failure trigger. Assert source remains current and is restarted; deleting that restart must turn the test red. |

The cleanup parameter table is split by assertion, not deleted wholesale:

| Baseline input | Disposition after release cleanup retires |
| --- | --- |
| gateStatus 0 / none | K1: successful cleanup removes build and both locks. |
| gateStatus 1 / none | R3: failure caused only by release cleanup; remove. |
| gateStatus 0 / build | K1: build removal fails, cleanup is nonzero, links lock is released, update lock and Codex owner remain. |
| gateStatus 1 / build | R3: gate failure is removed; its K1 build-failure assertions consolidate into the preceding row. |
| gateStatus 0 / owner | K1: Codex-owner removal fails, cleanup is nonzero and the update lock/owner remain. |

Remove the gateStatus dimension and the release-owner file/stub. Keep the
three ordinary success/build-failure/owner-failure scenarios in
`releaseCleanup.test.ts`. Suppressing cleanup's failure status or releasing
its update lock despite failed cleanup must make the corresponding case red;
restore and rerun. Do not remove the Codex-owner cleanup contract before N2.

Existing runner queue-failure, caller-death, link-lock, artifact verification,
attestation and native-state tests remain. Existing recovery-table/property
tests remain, including newly landed issue #695 tests. New ignored-descriptor,
retired-flag, old-journal and tarball checks are specified in the main design;
they supplement the retained cases rather than replacing their negative controls.

## Integration accounting

At implementation review, attach the integrated-base inventory and a mapping
from each K row to its final test name plus its red mutation result and restored
green result. R-only cases need no artificial successor. P2-owned rows must be
accounted for as already retired or split; do not resurrect them to satisfy this
baseline. New or rewritten cases from L1b/L4/L5 must be classified before editing.
Do not delete a source file or CI entry while any K assertion has no destination.
