# Codex 0.164.0 compatibility evidence — 2026-10-27

Issue: [810](https://github.com/sakuraiyuta/kaoiro/issues/810).
[Design r2](https://github.com/sakuraiyuta/kaoiro/issues/810#issuecomment-6427627807)
uses pre-design measurements on `48d62b41503e6da9a423d2c7aa129b47a84c264a`.
The independent design review approved r2 with no remaining findings.
Historical adoption records and approval fixtures remain intact.

## Package and reader identity

Both exact pins are 0.164.0. The installed Linux x64 musl native reports
`codex-cli 0.164.0`, SHA-256
`b93f6811d3f653f0fb83be4050d857fb9abbb111dfa2ce160563327daff7f306`.
The [tagged release](https://github.com/openai/codex/releases/tag/rust-v0.164.0)
and actual installed npm artifacts identify the candidate.

The SDK reader patch has unchanged contents, SHA-256
`faafbd6188ec0466bd5d3dfd02ed642304b5e09be1986b58533577b8456dbd0c`,
under the 0.164.0 dependency key. The resulting SDK `dist/index.js` has SHA-256
`2597aa3b22fa8a1d7cbd4fa313a0f6a3cba006654f372458daf84aca501749da`,
byte-identical to the patched 0.161.0 SDK. Both versions' `dist/index.d.ts`
are byte-identical, SHA-256
`5b57ce417b5f6e608c8e52707761384be220ff27e0206e93e4c253e83f206a8f`.

On Node 24.3.0, the actual unpatched 0.164.0 SDK fails to parse a JSONL
command-output event containing literal U+2028/U+2029. The same failure occurs
through the default exec `runCodexCli()` factory with real native command
output. Applying the existing patch makes both cases complete. The app-server
factory succeeds with either reader variant. The patch remains necessary;
Node 22's different readline behavior cannot justify removing it.

## Schema and consumed fields

Both real natives exported stable and experimental JSON Schema and TypeScript.

| Export | 0.161.0 → 0.164.0 files | Added | Changed | Removed |
|---|---:|---:|---:|---:|
| Stable JSON Schema | 315 → 320 | 5 | 38 | 0 |
| Experimental JSON Schema | 445 → 458 | 13 | 47 | 0 |
| Stable TypeScript | 737 → 751 | 14 | 29 | 0 |
| Experimental TypeScript | 882 → 904 | 22 | 34 | 0 |

The stable v2 inventory contains 14 added definitions and 23 structurally
changed definitions; all changes were mapped to wrapper consumers. No removed
files does not mean no removed fields: `namespaceTools` and
`ThreadItem.imageGeneration.result` were removed, but neither is read by the
wrapper. New optional `parentTurnId`/`rootTurnId` request fields are omitted;
nullable returned `rootTurnId` is ignored. The existing projection handles
known display fields and leaves new read-state notifications and unused item
variants opaque. `partial_answer` is not selected as final-answer text.

Core request/settings definitions, including thread start/resume, `UserInput`,
`ConfigReadParams`, and `Model`, retain identical definition bodies. The wrapper
advertises `experimentalApi:false`; the experimental inventory is a comparison,
not an enabled-feature compatibility claim. No runtime wrapper change was
required by these measurements. The catalog order, plan policy, effort policy
and Terra's 0.161.0 minimum remain unchanged.

## Nonempty state, cold resume and rollback

Each backend created real state using native 0.161.0, completed a tool-bearing
turn, and used the existing `codex-snapshot.mjs` implementation to snapshot and
verify the private isolated home. The candidate resumed the same native thread.

| Point, both backends | State migration | History migration | Threads | Turns | Items |
|---|---:|---:|---:|---:|---:|
| Before snapshot, 0.161.0 | 58 | 7 | 1 | 1 | 3 |
| After candidate resume | 61 | 8 | 1 | 2 | 6 |
| Snapshot restored, before old binary starts | 58 | 7 | 1 | 1 | 3 |
| Old binary resumes restored state | 58 | 7 | 1 | 2 | 6 |

The added migrations are state 59 attachment reverse lookup, 60 guardian review
feedback, 61 thread read state, and history 8 thread turn root. Original turn
IDs and history remain present; the old history row's root ID can be null.
Tampering with a snapshot payload makes verification reject it; restoring its
original bytes makes it pass. Rollback prepares and promotes the snapshot at
the original home path before starting 0.161.0. The old binary is never opened
against a migrated DB. Its resumed request contains the old assistant nonce
and excludes the candidate turns' nonces.

Saved values were `gpt-6-luna/low`, workspace-write, network enabled. Current
native config selected `gpt-6.1-sol/medium` and danger-full-access. Explicit
resume settings selected `gpt-6-astra/high`, read-only, network disabled. Both
provider requests and native-written turn contexts carried the explicit values.
A real command received EROFS when writing an owned workspace file and EPERM
when connecting to an owned listener; the file remained absent and listener
hits stayed zero. Independent controls allowed writing while keeping network
denied, then allowed both with one listener hit. This establishes the tested
explicit-setting precedence and resumed enforcement, not every default rule.

## Fresh approval fixture and remaining acceptance gates

The new 0.164.0 fixture and sibling metadata are in
`wrapper/codex/test/fixtures/app_server_approval_decline_0.164.0.*`.
Its JSONL SHA-256 is
`66a4cd1772f468307bd189b6033d76a54af9fe58d10c1d786fb15b828ce65c4e`.
A real candidate app-server, local provider, workspace-write, and on-request
approval produce an explicit escalation request for an owned file outside the
workspace. `availableDecisions` omits `decline`, while a `decline` response yields
`serverRequest/resolved`, a declined command item, and a completed turn. The
outside file remains absent. Only the owned scratch prefix is normalized.
The capture enables experimental schema fields; production factories retain
their normal capability negotiation. The provenance regression rejects
internally consistent metadata claiming the old pin.

Final candidate acceptance retains the issue 539 gates in addition to the four
measurements above: approval, permission/network isolation, steer, interrupt,
resume/history, model/default-effort resolution, and tool-bearing turns through
`runCodexCli()` production factories. Existing native integration tests cover
these separately. Negative controls remove the fixture-version guard, install
0.161.0 for the bundled-version assertion, remove the SDK patch on Node 24,
and corrupt a snapshot. Final-SHA native results and full wrapper/runner CI
results are attached to the candidate PR and implementation review record;
pre-design results alone do not establish final-candidate acceptance.

## Scope of evidence

The four pre-design measurements used the real SDK/native and no injected
CLI construction dependencies; only the external Responses provider and
Phoenix peer were fixtures. Authentication was local and credential-free.
No operator home, credentials, sessions or databases were copied. No production
service was accessed. The original private report SHA-256 values are
`70a3667f5fd5df07ed60fa1417e255d13bc5b10ef0d24e2cec265f7ad45e5105`
and `2e0414921e275788414134d99a7e6dced57e2e3103b5c1d9a59d6a2509a7ce61`.

Signed-in remote entitlement, provider-specific default semantics, other
platforms, corrupt-database recovery, and production service/cgroup lifecycle
remain outside these measurements. Production adoption still requires the
existing candidate classification preflight and approved maintenance workflow.
The tested isolated homes' entries were accepted by the existing classifier;
this is not an inventory of every possible plugin/authentication tree.
