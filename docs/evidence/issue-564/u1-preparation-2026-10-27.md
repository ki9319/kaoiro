---
title: "Issue 564 preparation evidence"
status: implemented
last_updated: 2026-10-27
---

# Issue 564 preparation evidence

This record covers the read-only observations and preparation command
introduced for issue 564, which pins an omitted backend to the existing `exec`
selection. It does not cover changing the omitted-setting default, pin removal,
or fresh restore.

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

## Recorded test evidence

The following hakoniwa runs use the pinned Node runtime image
`sha256:56cfd9fbe740e78f5d6d219772b6f5f7ba08424bf449f688b1a2597eebd469b8`
or Elixir image
`sha256:431e47077ade55b2acf621898f653451f542de12a51ffe538c3c5e69b8fbccc9`.
The code and test source was commit `03fba43f3a5def81d4f08a9924e0464dc358615c`;
the later candidate changes described in the runbook and this record are docs-only.

- Runner version probe: `momo-c079cb4-564u1vr2-1027190808-13b3.20d0f2609e0289ac`.
  The built public runner's JSON `revision` matched its build commit, and
  `dirty` was the JSON boolean `false`.
- Isolation and Node tests: `momo-03fba43-564u1iso-1027191033-2e60.2bbff6b6c282187a`.
  The checker found 25 entries and 0 problems; 200 tests passed and 0 failed.
- Node mutations: `momo-e075569-564u1mutn3-1027192503-05b0.8ce72c642b5a7ba0`.
  Six code mutations were caught; each ran 34 tests, with 9, 3, 11, 1, 3, and
  3 failures respectively. Removing the first-import guard yielded 25 entries
  and 3 problems. Restored checks: 34/34 tests passed; 25 entries, 0 problems.
- Default-store mutations: `momo-bc6699c-564u1msv4-1027191939-2aa3.be8431057d915eb8`.
  Hiding engine extraction: 4 tests, 3 passed / 1 failed. Hiding pending
  transition: 4 tests, 2 passed / 2 failed. Restored suite: 4/4 passed.

The Node entry test exercises the default `localAdapters` with a command-boundary
stub and real temporary-file operations. Its responses follow the public runner
diagnostic, journal JSON, and server projection shapes. The server shape was
checked against a real default-store projection. These runs do not claim live
systemd, journal transport, Docker Compose, production, or account-backed
behavior.

## Scope and limits

No production inventory, account-backed run, or native Codex lifecycle test is
claimed here. The preparation command makes no exec-to-app-server or
app-server-to-exec session compatibility claim. The preparation still requires
complete, private origin-evidence supplied by the operator; public test
fixtures and this record do not establish a real host's inventory or session
origin.
