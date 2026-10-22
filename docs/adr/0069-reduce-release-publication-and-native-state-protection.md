---
title: Reduce release publication and native Codex state protection to what releases and wrapper start/resume need
status: proposed
date: 2026-10-22
opened: 2026-10-22
supersedes: []
superseded_by: null
related_specs: [deployment]
related_adrs: [53, 66]
---

# ADR-0069 — Reduce release publication and native Codex state protection

## Context

[ADR-0066](0066-tag-derived-lockstep-build-identity.md) derives build identity
from a landing tag issued for every develop push, and adds a production
completion receipt published through an operator-dispatched workflow. The
native Codex state layer
([issue #468](https://github.com/sakuraiyuta/kaoiro/issues/468)) grew
acceptance receipts, restore lineage, legacy handling and evidence-gated
retirement around its snapshot and restore. The runner's six Codex state test
files account for 90.2% of its accumulated test time
([issue #704](https://github.com/sakuraiyuta/kaoiro/issues/704)).

On 2026-10-22 the operator chose option A of
[issue #709](https://github.com/sakuraiyuta/kaoiro/issues/709) and asked that
native Codex state protection be reduced to what a wrapper needs to start and
resume. The receipt-to-dispatch path has never published (0 workflow runs, no
`release/*` tag, measured 2026-10-22).

## Decision

Proposed; the inventory, boundary, landing units and measurements are in the
[issue #709 plan](../plans/issue-709-release-reduction.md).

1. **Keep** lockstep updates (server and runner at one commit), full-SHA build
   identity with one frozen identity per coordinated build, reader-format
   compatibility checks, the exact-tag requirement for production builds and
   activation, and the immutable tag ruleset.
2. **Replace** the landing tag as the version source with a production
   release tag `vYYYY.MM.DD.N`, created at release time on the released commit
   with a schema-2 annotation and no claim ref. Historical schema-1 landing
   pairs stay valid. Release records are the release tag and the release note.
3. **Retire** per-push landing allocation, hourly reconciliation and landing
   repair; the completion receipt, enrolled release authority, canonical
   history, retained worker and lifecycle commands; the
   `production-release.yml` dispatch; and the `KAOIRO_*` repository-variable
   gates.
4. **Bound** native Codex state protection by nine invariants (plan section
   4.1): usable home at launch; no differing native binary on a home unless it
   was just restored for that binary or is fresh; credentials never rolled
   back; no credentials in snapshots and fail-closed classification; copy and
   replace only with the runner stopped and its cgroup empty; verified
   snapshots; resumable, non-destructive replacement; restore writes the home
   the runner will use; the snapshot's release is kept and a harmless failure
   restarts the unchanged source.
5. **Retire** outside that boundary: acceptance evidence and binding receipts,
   restore lineage, legacy and barrier handling, the pre-stop foreign-UID walk,
   migration diagnostics, file-identity binding of the unit and `runner.env`,
   and evidence-gated retirement and abandonment. The phase machine shrinks to
   six states and records move to `codex-state/v2/`; old records are never
   converted.

## Consequences

- Non-release develop builds are `untagged`. A production update first
  creates the release tag. Hand-made `v*` tags are the intended authority, so
  claim-based detection of them ends.
- No machine-checked completion evidence or unfinished-attempt admission block
  remains; deployments rely on the existing per-operation health, attestation
  and registration checks and on the release note.
- A pin update completes when the updater's own start check passes; the
  operator's first-turn and resume check becomes a runbook step, not a gate.
  Editing `runner.env` no longer strands rollback points. Restoring an older
  snapshot is allowed and quarantines newer threads.
- The six slow runner files are deleted or reduced to about 15 workflow
  cases; the CI effect is measured after the native units land.
- [Issue #707](https://github.com/sakuraiyuta/kaoiro/issues/707) is superseded.
  [Issue #695](https://github.com/sakuraiyuta/kaoiro/issues/695) L1b, L4 and L5
  are unaffected by the boundary; L2 and L3 are re-scoped to the smaller
  machine.
- Each landing unit is a separate issue. Disabling workflows, changing
  repository variables and production steps remain operator operations with
  their own approval.

## Status gates

This ADR stays `proposed` until the design review passes and the operator
records the decision points of plan section 8. Unit P3 additionally waits for
the server enrollment measurement (plan section 9, U2).
