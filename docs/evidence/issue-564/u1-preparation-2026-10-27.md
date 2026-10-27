---
title: "Issue 564 U1 preparation evidence"
status: implemented
last_updated: 2026-10-27
---

# Issue 564 U1 preparation evidence

This record covers U1's read-only observations and the `prepare` action that
pins an omitted backend to the existing `exec` selection. It does not cover
U2's omitted-setting default change, pin removal, or fresh restore.

## Artifact and observation contract

The server projection joins the host-scoped union of directory rows, session
pointers, live state, reset locks, and pending transitions. A pointer can supply
an engine for an offline row. For a live row, the engine is read from the
wrapper envelope's `ext.engine`. The persistent directory stores identity
metadata only, so a directory-only row has an unknown engine and preparation
stops before routing evidence, acknowledgement-cursor capture, or a config
write. Conflicting pointer and live-envelope engines make the observation
invalid.

The runner release identity is read from the current service invocation's
public startup diagnostic:

```text
runner: host=<host-id> rev=<40-character-release-sha> connecting to ...
```

This format is emitted by the runner startup path in
[`runner/src/runner-cli.ts`](../../../runner/src/runner-cli.ts#L363). The check
requires the observed host and full release SHA to match the requested values;
the hostname and connection target are not included in the preparation result.
The runner's public `--version --json` output also exposes its release SHA.

## Gate coverage

The product entry rejects a positive reset or transition-pending row before
reading origin evidence or capturing the journal cursor. It repeats the full
observation immediately before the write and rejects changed state. An
unavailable server observation stops before the write; a missing applied
selection acknowledgement stops before any post-write observation, restore,
or second config write. The explicit `exec` write can remain after an
acknowledgement failure, which requires operator review.

The default server composition is covered by
`CodexBackendCompatibilityDefaultStoreTest`: it uses a real wrapper channel,
the default directory/pointer/state/reset/transition stores, and
`observe_host/1` with no injected source options. The server observation fixture
is asserted against that real projection. The preparation entry is covered by
`scripts/test/codex-backend-compatibility.test.mjs`; its default-adapter cases
leave adapter injection unset and retain real temporary-file reads, writes,
atomic rename, pre-write stability checks, and acknowledgement handling. The
command boundary supplies only product-shaped systemd and server command
responses.

Relevant cases include:

- `the default local adapter observes positive pending state and refuses before preparation`
- `the default local adapter rejects unknown runner identity and unknown engine before mutation`
- `the default local adapter keeps unavailable observations and failed acknowledgements fail-closed`
- `the pre-write stability gate rejects host and runner changes`
- `the default host observation uses real wrapper, directory, pointer, and pending stores`

The `scripts/test/codex-backend-compatibility.test.mjs` suite is part of the
test-isolation CI job. Its first import is covered by the isolation guard.

## Scope and limits

No production inventory, account-backed run, or native Codex lifecycle test is
claimed here. U1 makes no exec-to-app-server or app-server-to-exec session
compatibility claim. The preparation still requires complete, private
origin-evidence supplied by the operator; public test fixtures and this record
do not establish a real host's inventory or session origin.
