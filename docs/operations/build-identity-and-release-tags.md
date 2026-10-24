---
title: Build identity and release tags
description: Immutable build identities (landing pairs and release tags), common production checkpoints and release recovery.
status: accepted
last_updated: 2026-10-25
related: [deployment, protocol]
---

# Build identity and release tags

[ADR-0066](../adr/0066-tag-derived-lockstep-build-identity.md) supersedes the
manual root VERSION/channel decision. Protocol version remains 0. Install the
reader bridge on server, dashboard, runner and every wrapper before starting a
new-format runner. Historical `YYYY.M.PATCH` artifacts remain readable.

## Identity

Production identity is an exact `v*` tag at HEAD. The reader accepts two forms:
a historical landing pair (an annotated `vYYYY.MM.DD.N` tag plus a same-object
`identity/landing/<full-SHA>` claim, issued for develop push tips by a retired
workflow) and a schema-2 release tag (see [Release tags](#release-tags)).
Landing pairs are immutable and stay readable; no new ones are issued.

`scripts/build-identity.mjs` is the only producer of version and branch. It
requires an exact HEAD tag (a landing pair or a release tag), not an ancestor. Tagged builds retain
the annotation's landed branch even on main or a detached ref. Untagged builds
use the build ref. Dirty, shallow, absent or inconsistent tag observations do
not claim a tagged production build. Labels are `vYYYY.MM.DD.N / branch / hash`
or `untagged / branch / hash`; the label hash has seven characters. Machine
records retain the full 40-character revision and dirty flag. `channel` remains
for old readers and does not authorize a production release.

## Release tags

A schema-2 release tag
([ADR-0069](../adr/0069-reduce-release-publication-and-native-state-protection.md))
is created at release time on the released commit and is the production version
source for commits released after the cutover recorded in the
[release notes index](../release/README.md).

A release tag is an annotated, unsigned `vYYYY.MM.DD.N` tag whose message is
exactly one compact JSON object with exactly these keys:
`{"schema":2,"kind":"release","repository_id":1343265983,"revision":"<40-hex>","branch":"develop","version":"YYYY.MM.DD.N"}`.
The tag object is at most 4,096 bytes, its `object` and `tag` header lines
must equal `revision` and `v<version>`, and no
`identity/landing/<revision>` claim may exist. The selection of tags at HEAD
is unchanged: only `v<YYYY.MM.DD>.*` names count, and two of them refuse.
A lightweight or signed tag, an unknown schema or kind, an extra or missing
key, or a claim beside the tag degrades the identity, so `--require-tagged`
refuses. `--require-tagged` also reads the tag back from origin and refuses if
a claim appears there. A commit that already has a landing pair is released
under that tag. Frozen identities carry `release` instead of `landing`, never
both; the version string and `build_identity_formats` are unchanged, so
runtime readers need no bridge.

Plan the next tag with the read-only helper. It never creates, pushes or
fetches; it refuses a dirty checkout, a commit that already has a calver tag
or a landing claim locally or on origin, and it prints the commands for the
release operator:

```sh
node scripts/release-tag.mjs plan [--revision <40-hex>] [--day YYYY-MM-DD]
```

`N` is one more than the highest number among origin's tags of that UTC day.
A local-only tag of the same name on another commit makes the printed
`git tag` fail rather than create a second tag; remove the stray local tag
after checking it.

## Coordinated production builds

From a clean, reviewed checkout, fetch the exact landing tag before downtime.
Freeze one JSON outside the checkout and consume it across the complete build:

```sh
node scripts/with-build-identity.mjs --require-tagged -- sh -c 'pnpm -C wrapper build && pnpm -C runner build'
./scripts/build-runner-tarball.sh --require-tagged --target linux-x64
```

The tarball builder coordinates its own fan-outs. For a pre-frozen identity,
pass `KAOIRO_BUILD_IDENTITY_FILE` and its SHA-256; consumers must not recompute.
The server deploy builder passes that same document as
`KAOIRO_BUILD_IDENTITY_JSON` and all five compatibility scalar fields into
Compose. The Docker Node stage writes `/app/build-info.json` with a JSON
serializer and Vite consumes the same document. The final image copies that
file rather than reconstructing it with shell interpolation. Source checks
before and after a coordinated build refuse a changed revision or dirty state.

Generated archive VERSION/revision files, manifests, physical release IDs and
Codex transaction IDs remain in use; the manually maintained repository VERSION
is removed. `--allow-dirty` explicitly selects development activation. Rollback
of an already retained release keeps its recovery contract.

Use `current/deploy/kaoiro-runner-launch.sh --version --json` for full-SHA
attestation. A legacy CLI may instead use the pinned physical release's baked
JSON and matching archive VERSION. A human label is never parsed as authority.
Health and register must independently match the target full SHA: running a
CLI subprocess alone does not prove the live runner registered.

## Reader compatibility and rollback

Health reports `build_identity_formats`. Before stopping the old runner, the
updater checks this server declaration for a new-format candidate. Deploy
checks the target image declaration against a fresh connected host/wrapper
snapshot before STOPPING and before each rollback path. Unknown/missing registered
versions refuse even if the target accepts both known formats. Refresh that
runner/wrapper's registration using a bridge-capable release, inspect the
reported machine identity and retry; do not relabel an unknown version as
legacy. If refresh is unavailable, stop and confirm the incompatible fleet
before explicitly using `--fleet-stopped`. The snapshot uses
bounded registry calls and an outer Docker timeout; failure releases the lock.

A server predating the bridge cannot be restored under incompatible live
runners/wrappers. `--fleet-stopped` is a separate explicit execution-card
statement: the operator must stop/revert the incompatible fleet first.
`--maintenance-approved` and `--confirm-restore` do not imply this permission.
Invalid target image identity is never waived. Restore known old artifacts;
do not move a landing tag to make rollback pass.

For the first bridge upgrade from a server without `ReleaseFleet`, the execution
card must order these steps: stop every required runner and confirm that their
cgroups contain zero wrappers and every dashboard tile is offline; update the
server with `--fleet-stopped`; update the runners; then run the canary. Use the
flag only after both stop observations pass. A missing legacy RPC fails closed
without the flag. Subsequent upgrades from a bridge server omit the flag and
must obtain the live compatibility snapshot. Never carry this first-upgrade
exception into ordinary execution cards.

## Enrolled production authority

Reconciliation applies only to physical install roots with a descriptor. A
missing descriptor preserves ordinary OSS/development behavior; a present bad
one refuses. Production assertions also refuse if their expected descriptor is
missing. The completion collector independently checks the enrolled server,
runner baselines and imported facts, so removing a descriptor cannot manufacture
a production completion.

The server descriptor is `realpath(serverDir)/.kaoiro-release-authority.json`,
independent of `backup_root`. The runner descriptor is
`realpath(installRoot)/release-authority.json`. Both are owned, regular 0600
files; links and unsafe parents refuse. Create and verify the canonical 0700
history root on the recording server *before* publishing a descriptor. A
missing existing root is an error, never permission to create empty history.
The runner reads this history through the fixed exporter; runner-local absence
never proves the canonical history empty.

Stage and install the reviewed first-party tool closure with
`scripts/production-release-tools.mjs`. Capture its full digest, physical Node
path/major and physical exporter path in the descriptor. Its schema is defined
by `production-release-authority.mjs`; local descriptors additionally fix
`node_path`/`node_major`, SSH descriptors fix `ssh_target`, `ssh_hostname`,
`ssh_user`, `ssh_port`, `identity_file`, `known_hosts_file`, `remote_node` and
`remote_node_major`. `install_root`, `root`, `recording_hostname`,
`tool_sha256` and `exporter_path` are mandatory. Only Node 22 or 24 is supported.
Use the kernel hostname for the recording role, not its FQDN.

The fixed private `<canonical-root>-inventory.json` is an owned 0600 file:
`{schema:1,health_url:"https://recording.example/health",runtime_hosts:[{alias,runtime_host_id}],authority:{server:{root,sha256},runners:[{alias,root,sha256}]}}`.
The server authority digest must match the fixed server descriptor. `health_url`
pins the complete recording-server endpoint for completion and terminal
transitions. An omitted CLI URL uses this value; a different URL is refused
before any external read. A legacy inventory without it remains usable for
admission but must be updated by the operator before completion, retirement,
abandon or quarantine. On each
runner, `release-host-aliases.json` maps its public alias to the real config
`host_id`. Freeze this full inventory into every attempt; neither a launch
option nor a corrupt plan may narrow it. Use arbitrary stable aliases, not
real IDs or their SHA-256 prefixes. GitHub allow-lists and public receipts use
those same aliases. The private mapping, health URL and authority are never dispatched. The
exporter/importer also compares the request root with its fixed command
argument; an input document cannot select a different history.

SSH uses a fixed `/usr/bin/ssh` command, fixed exporter operation, fixed canonical root argument and an
allow-listed PATH/HOME/LANG/LC_ALL environment. It supplies `-F none`, `-T`,
explicit user/port/HostName and key, `BatchMode=yes`,
`StrictHostKeyChecking=yes`, `IdentityAgent=none`, `IdentitiesOnly=yes`,
`UpdateHostKeys=no`, `ControlMaster=no`, `ControlPath=none`,
`ControlPersist=no`, `ClearAllForwardings=yes`, `ForwardAgent=no`,
`PermitLocalCommand=no`, `ProxyCommand=none`, `ProxyJump=none`,
`CanonicalizeHostname=no`, `ConnectTimeout=5`, `ConnectionAttempts=1`,
`ServerAliveInterval=5`, `ServerAliveCountMax=1`, `LogLevel=ERROR`, fixed
`UserKnownHostsFile` and `GlobalKnownHostsFile=/dev/null`. Verify the host-key
fingerprint out of band before installing the private known-hosts file; do not
learn or overwrite it from an unverified connection. Target/user tokens cannot
contain `@`, `:` or `/`; the exact grammar is in the descriptor reader.

The existing file key remains a general operator SSH key: these client options
constrain this command, not the credential's server-side powers. No new key,
agent identity or remote SSH policy is installed. An available gpg-agent socket
is deliberately ignored. Keep the pinned remote Node and exporter until every
queued worker/attempt using them is closed. Upgrade their descriptors and tool
packs together under the same release-control approval; an unavailable pinned
binary requires repair, not fallback to another Node.

Before the first production prepare after enrollment or a descriptor upgrade,
run its captured launcher
through an owned timer-started oneshot with the production retained shape
(`Type=oneshot`, `RemainAfterExit=yes`, `--expand-environment=no`). Use the
reviewed physical Node path and closure digest, then inspect the exact unit:

```sh
<physical-node> <tool-root>/scripts/production-release-launcher.mjs \
  preflight <tool-sha256> --install-root <install-root> \
  --expected-authority-sha256 <descriptor-sha256>
```

The command performs three independent verified exporter reads, reports each
elapsed time and refuses a successful read above 15 seconds (before the
20-second child bound). It also refuses any transport/decoding/binding failure;
do not continue to prepare after refusal. Re-run after
repairing the fixed connection. Preflight does not resolve or waive unfinished
attempts: every actual prepare and worker still performs its own reconciliation.
Stop/reset only the exact owned preflight service/timer after inspection.

## Common production checkpoint

Server DONE/stability, queue submission and source recovery are incomplete.
Create one enrolled attempt before either prepare. `codex_host_ids` is a fixed
subset; omission requires acceptance on every alias, while `[]` selects none.

```sh
node scripts/collect-production-release.mjs start \
  --server-dir <server-root> \
  --identity <deploy-root>/build-identity.json \
  --codex-hosts '[]'
```

Keep the returned UUID, canonical directory and SHA-256 of its exact
`attempt.json` bytes in the card. Copy that private file to each runner, then
install it through `install-plan`; this verifies the canonical digest,
unfinished state, authority, alias and actual runner config before committing
the fixed `production-attempts/<uuid>/attempt.json` working copy. Arbitrary
output paths and caller-selected updater files are unavailable.

```sh
node scripts/collect-production-release.mjs install-plan \
  --plan <private-copied-attempt.json> --host worker-a \
  --runner-root <install-root> \
  --config <runner-config>
node scripts/production-runner-worker.mjs queue \
  --attempt <fixed-runner-working-directory> --host worker-a \
  --runner-root <install-root> \
  --config <runner-config> \
  --update-args '["--tarball","<reviewed-tarball>","--release-repo","<repository-root>"]'
```

The dedicated unit is `kaoiro-release-<uuid>-<alias>.service`. The default delay
is 180 seconds, random delay zero, timer accuracy one second. A private baseline
and canonical intent precede submission; uncertainty is not idle and cannot be
submitted twice. Inspect/cancel that exact intent before abandoning an unused
attempt. The queue automatically captures own-X/digest/target/alias/authority
options. Every server prepare/resume must receive the same pair explicitly:
`--release-attempt <uuid> --release-plan-sha256 <64-hex>`.

End the agent turn after enqueue. If peer input arrives between reset and stop,
repeat idle/reset preparation or stop immediately after join. The dedicated
oneshot has `RemainAfterExit=yes`, no `PartOf`/`BindsTo`, and
`--expand-environment=no`. It runs the full-digest-pinned launcher and updater
closure. Both admission and the worker under `.lock.update` audit canonical
history before build/install/state snapshot/stop. Ordinary `--detach` also
freezes its launcher/authority; generic installs retain their prior behavior.

The worker records a lock-owner invocation, named PID/start ticks, physical
source/target, descriptor and full tool digest. Immediately before stop it seals
its audit into a same-boot proof. The switch accepts only the recorded updater's
direct child and a proof at most 900 seconds old in `/proc/uptime`; it repeats
local checks under `.lock.links`. No SSH or Git audit runs after stop. A late
refusal restores the old source through the existing recovery path. Bootstrap
and direct switches are enrolled-root entries too; genuine previous-release or
validated native-state recovery keeps its separate recovery contract.

Include the reviewed `--codex-home` and `--codex-backup-dir` pair only for a
selected Codex alias. After acceptance, collect the real retained invocation:

```sh
node scripts/collect-production-release.mjs runner-after \
  --attempt <fixed-runner-working-directory> --host worker-a \
  --runner-root <install-root> \
  --config <runner-config> \
  --codex-transaction <accepted-forward-UUID>
```

Omit `--codex-transaction` for an unselected host. The collector checks actual
success/exit code, InvocationID, timestamps, live service, baked full identity,
executed enrolled proof and selected modern acceptance. It reads *typed*
D-Bus `ExecStartEx` through `busctl`, including all argv boundaries and the
`no-env-expand` flag. `systemctl` and `busctl` must be available. Plain
`ExecStart` text and a queued command cannot substitute. The private fact is
imported by the fixed canonical endpoint; callers cannot supply a public runner
leg or choose its output file.

On the recording server, after native DONE and operator canary:

```sh
node scripts/collect-production-release.mjs complete \
  --server-dir <server-root> \
  --attempt <canonical-attempt-directory> \
  --health-url <reviewed-health-url> --canary <private-canary.json>
```

Canary JSON contains `passed`, `operator`, full target `revision`, UTC
`completed_at` and `evidence_sha256`. `complete` reads the fixed server audit,
DONE journal, actual live container/image, full health identity, live
registrations through the private alias map and canonical imported runner
facts/baselines. Simulated service or Docker dependencies cannot complete it.
The validated `completion.json` is private and write-once; its digest covers
compact JSON plus one newline. The dispatch projection contains bounded
success facts and public aliases, never private maps, paths, reasons or logs.

After canonical completion, clean only the verified dedicated pair on its
runner. Cleanup checks canonical receipt, actual invocation and typed complete
command before removal; repeats accept a pair already gone.

```sh
node scripts/production-runner-worker.mjs list \
  --runner-root <install-root>
node scripts/production-runner-worker.mjs cleanup \
  --attempt <fixed-runner-working-directory> --host worker-a \
  --runner-root <install-root> \
  --config <runner-config>
```

Never clear a failed, live or unidentified worker by broad unit/process matching.
After publication/ack and exact cleanup, `worker archive --uuid ... --host ...
--runner-root ... --config ... --repo ...` moves the completed working copy on
the same filesystem. Finish each runner's cleanup/working-copy archive before
archiving the canonical attempt. Incomplete/incident working copies remain for
explicit inspection/repair; they never receive a fabricated completion.

## Reconciliation and explicit recovery

Post-dispatch card verification and the next enrolled server/runner prepare
both require reconciliation. An unfinished or unnotified attempt blocks the
next update. A card has no own-X or skip exemption. An ordinary update also has
no own-X exemption; card-based prepare/queue/worker/switch bind the same frozen
UUID/digest. A skip is paired `--skip-release-reconciliation <UUID,UUID>` and
`--skip-reason <one-line-reason>`; only U contained in that explicit set passes.
The complete set is carried to delayed work and re-audited before stop. Unknown
identity, unavailable authority or timeout cannot be skipped. Dry-run writes
no transaction, refs or lock; a normal refused prepare may already fetch tags.

The whole audit has a 120-second monotonic bound, including at most two retries
of `snapshot_changed` (three attempts total, 100 ms delay). Other failures do
not retry. Git calls are at most 15 seconds, SSH children 20 seconds, connection
5 seconds, endpoint input/processing 15 seconds. Export is all-or-nothing and
bounded at 32 MiB. Warn at 900 active attempts and refuse admission at 1,000;
verified archive maintenance is not itself blocked by the admission cap.
Archives retain verified terminals, preserve permanent incident warnings and
refuse unknown/damaged history. Archive scanning is streamed, at most 100,000
entries and 15 seconds; incident projection is at most 8 MiB. Transport and
private-record bounds still apply. Non-card audits show the first 128 incident
UUIDs, total count and digest; inspect canonical/archived records for details.

For an uncertain or unused UUID, first refresh every runner's native activity:

```sh
node scripts/production-runner-worker.mjs inspect \
  --runner-root <install-root> --uuid <uuid> --host worker-a \
  --config <runner-config>
```

`cancel` with the same arguments permits only a verified never-started dedicated
timer. An active invocation refuses cancellation. Native idle results are
immutable ordered events imported under the canonical record lock. A stale idle
event cannot erase a newer intent. A broken plan uses the complete fixed
enrollment inventory and a separate lifecycle-evidence kind, not ordinary
rollout evidence. All enrolled aliases must provide fresh idle observations.

`production-release-lifecycle.mjs abandon|quarantine|retire-deployed --root
<canonical-root> --uuid <uuid> --reason <text> --health-url <reviewed-health-url>`
checks fresh runner activity and the recording server's live revision:

- `abandon`: valid unused unfinished plan, no completion, no bound DONE/after
  evidence, no healthy leg at the target and no queued/running/unknown work.
- `quarantine`: known UUID with invalid records; preserve every original in
  content-addressed incident evidence before committing a terminal incident.
  A corrupt quarantine/retirement file can be preserved and replaced resumably.
- `retire-deployed`: valid applied unfinished plan that cannot honestly complete;
  every leg must have left the target and no work may remain. Keep replacement
  evidence and a permanent accident warning. Create no public success/tag.

Reasons are one trimmed line, 1–512 UTF-8 bytes, without Cc/Cf/Zl/Zp controls.
Valid terminals are immutable; later import/worker/complete refuses. All
transitions share the record lock. `archive --root ... --uuid ... --repo ...`
requires a remotely published pair or a verified non-success terminal, no
existing destination, owned 0700 directories, no links and same-device rename;
fsync both parents. A skip never authorizes archive.

For stale registered residue, use `inspect-residue --root ... [--uuid ...]
--entry <exact-name>` to obtain its observed digest, then
`recover-lock|recover-staging` with the same selector, `--observed-digest` and
`--reason`. A named live PID/start-ticks owner refuses. Legacy ownerless locks,
unknown owners and staged files require `--writers-stopped confirmed`; age does
not prove death. Recovery preserves bytes in the adjacent private incident
area. Recovery of `.lock.maintenance` itself additionally requires that same
stopped-writer confirmation, so the maintenance lock cannot become immortal.

An unidentified entry cannot be skipped/quarantined. First inspect the exact
name reported by the grammar, its `attempt.json` UUID/full identity, the saved
card and its digest, `completion.json`, private baseline/after facts and any
`server-audit.json`-bound transaction journal. Compare against the original
private plan/card and a verified backup, including root/authority and alias
inventory. Stop release writers before repair. Restore the established bytes
and identity while retaining the damaged original; never invent a UUID, rename
an unidentified directory to a convenient UUID, or delete it merely to clear
U. `repair-history` is this operator procedure, not an automatic repair command.

<!-- release-state-table:start -->
| State | Disposition | Exit | Guards |
|---|---|---|---|
| unknown_identity | refuse | repair-history from verified original/backup; never invent identity | identity |
| invalid_quarantined | terminal-incident | archive; keep incident on cards | incident-manifest, idle-at-transition |
| deployed_uncompleted | terminal-incident | archive; keep incident on cards | retired-all-legs, idle-at-transition |
| invalid_completion | unresolved | quarantine known UUID or verified repair | identity, idle-at-transition, preserve-bytes |
| abandoned | resolved | archive | unused-at-transition, idle-at-transition |
| published | resolved | verified archive | completion, remote-pair |
| publication_missing | unresolved | dispatch and reconcile or UUID-bound update skip | completion, remote-pair |
| publication_unconfirmed | unresolved | repair remote/checkout and reconcile; bounded update skip only for known UUID | completion, remote-pair |
| rollout_active | unresolved | wait/inspect or verified not-started timer cancellation | activity |
| deployed_incomplete | unresolved | complete/repair or retire-deployed after every leg leaves target | applied, retired-all-legs, idle-at-transition |
| in_progress | unresolved | resume/complete or guarded abandon | unused-at-transition, idle-at-transition |
| authority_unavailable | refuse | enroll empty root or repair verified authority |  |
| empty_root | resolved | legitimate enrolled baseline |  |
| uncommitted_staging | diagnostic | dead-writer recovery or recover-staging |  |
| live_lock | diagnostic | owner releases normally |  |
| stale_or_legacy_lock | diagnostic | recover-lock; age never proves death |  |
| archived_terminal | resolved | inspection and retained incident reporting |  |
| capacity | refuse-at-1000 | verified archive; warn at 900 |  |
| switch_proof | current-child-only | owner cleanup or validated source recovery |  |
<!-- release-state-table:end -->

Enrolled server `build`, `start`, `update` and `rollback` hold the canonical
`.lock.server` for their native operation. Terminal lifecycle commands acquire
the same lock before inspecting or writing an attempt; an old healthy revision
alone cannot prove an idle server. The lock does not depend on `backup_root`.
Generic installs keep their existing behavior. A killed owner uses the same
explicit `inspect-residue` / `recover-lock` procedure, with preserved bytes.
The exporter exposes enrollment aliases and a digest with per-leg authority
digests, without real host IDs or install paths. The importer keeps and verifies
the complete private enrollment inventory locally. Once an attempt has a valid
immutable completion or terminal proof, pruning its native journal does not
reopen it; native journal observations are for unfinished attempts.

Known corrupt private facts and ordinary activity records use a separate
`runner-lifecycle-activity-*` stream for quarantine inspection. This stream is
bound to the fixed full enrollment inventory and the digest of the damaged row
(excluding only that stream); it cannot replace ordinary rollout evidence. Any
change to the damaged row invalidates the inspection and requires inspection
again. All original facts remain in the evidence manifest.

## Repairing a malformed reserved tag

Do not move a valid `v*`, `identity/landing/*`, `release/*` or
`identity/release/*` ref to another commit. Preserve `git ls-remote --tags origin`
plus the annotation of the exact bad ref, and compare it with the release note
before deciding whether it is malformed. A production build refuses a malformed
reserved ref rather than skipping it.

If a malformed ref must be removed, the operator first exports the active tag
ruleset and its bypass identities with `gh api repos/sakuraiyuta/kaoiro/rulesets`.
The operator temporarily excludes only the exact reviewed malformed ref from
the immutable tag rule, without adding a principal-wide bypass, then deletes
only that ref with
`git push origin :refs/tags/<reviewed-malformed-ref>`. Restore and independently
verify the original ruleset immediately. Record the old object ID, evidence,
approver and restored ruleset in the incident. A missing ruleset, ambiguous
identity or a valid ref stops this procedure; agents do not change rulesets or
delete public tags. Issue a new build only after the tags at HEAD read cleanly
again.
