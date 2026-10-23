---
title: Runner test tiers
description: The measurement behind the integration and native lists of the runner test tiers.
status: accepted
last_updated: 2026-10-23
related: [runner-development, test-isolation]
---

# Runner test tiers

Measured on 2026-10-23 at `5fdb79ef` for
[issue #706](https://github.com/sakuraiyuta/kaoiro/issues/706), in a disposable
test container (Node 22, Vitest 2.1.9, `pnpm install --frozen-lockfile` and the
wrapper and runner builds first). The manifest it supports is
`runner/test-tiers.json`; the rule is in
[Runner development](../contributing/runner-development.md#test-tiers).

## Method

A preload (not committed) wrapped `child_process.spawn`, `spawnSync`, `exec`,
`execSync`, `execFile`, `execFileSync` and `fork`, and `net.Server.prototype.listen`,
and appended one line per call to a per-file record. Each test file ran alone
(`vitest run test/<file>`), three at a time. Calls whose command is the esbuild
binary, a tinypool fork or the CPU-topology probe are Vitest start-up and are not
counted. A file is `integration` when the remaining count of process starts or
listens is above zero. The 64 probed files all exited 0.

Six long-running Codex state files were not probed; they were read instead
(their harness and fixtures start Node and shell processes). The files without a
process start were read for `skipIf`, `runIf`, platform and opt-in branches: only
the native file has them, so no dependency hides behind a skipped branch. A probe
shows what one run executed, not what another environment would.

Collected totals at the same commit, before this change added its own test file:
71 test files by listing the directory; 70 files and 1,389 cases in
`vitest list --json` (one project). The listing omits
`grok_sessions.native.test.ts` because all of its cases are skipped; a file
listing (`--filesOnly`) has all 71.

## Files

| File | Tier | Basis |
|---|---|---|
| `antigravity-catalog.test.ts` | fast | 0 process starts, 0 listens |
| `antigravity-cli-wiring.test.ts` | integration | 30 process starts, 0 listens (agy(18) second(6) first(4) node(2)) |
| `antigravity-version.test.ts` | integration | 3 process starts, 0 listens (agy(3)) |
| `args.test.ts` | fast | 0 process starts, 0 listens |
| `behaviour-default-composition.test.ts` | integration | 1 process starts, 1 listens (node(1)) |
| `behaviour-docs.test.ts` | fast | 0 process starts, 0 listens |
| `behaviour-flags.test.ts` | fast | 0 process starts, 0 listens |
| `behaviour-group3.test.ts` | fast | 0 process starts, 0 listens |
| `behaviour-relay-wiring.test.ts` | integration | 8 process starts, 0 listens (agy(8)) |
| `behaviour-settings.test.ts` | fast | 0 process starts, 0 listens |
| `behaviour-watchdog-permission.test.ts` | fast | 0 process starts, 0 listens |
| `buildIdentityScript.test.ts` | integration | 90 process starts, 0 listens (git(79) node(11)) |
| `buildIdentityScriptDegrade.test.ts` | fast | 0 process starts, 0 listens |
| `build_identity_bridge.test.ts` | fast | 0 process starts, 0 listens |
| `build_info.test.ts` | fast | 0 process starts, 0 listens |
| `claude_catalog_cache.test.ts` | fast | 0 process starts, 0 listens |
| `cli-entrypoint.test.ts` | integration | 15 process starts, 0 listens (node(7) git(6) sh(1) pnpm(1)) |
| `codex-auth.test.ts` | fast | 0 process starts, 0 listens |
| `codex-backend-wiring.test.ts` | fast | 0 process starts, 0 listens |
| `codex-home-wiring.test.ts` | fast | 0 process starts, 0 listens |
| `codexHomeClassification.test.ts` | integration | 26 process starts, 0 listens (node(26)) |
| `codexLegacy.test.ts` | integration | read, not probed (long-running): drives the real updater and switch scripts or the lineage harness, which start Node and shell processes |
| `codexLineage.test.ts` | integration | read, not probed (long-running): drives the real updater and switch scripts or the lineage harness, which start Node and shell processes |
| `codexLineagePending.test.ts` | integration | read, not probed (long-running): drives the real updater and switch scripts or the lineage harness, which start Node and shell processes |
| `codexReceipt.test.ts` | integration | read, not probed (long-running): drives the real updater and switch scripts or the lineage harness, which start Node and shell processes |
| `codexState.test.ts` | integration | 55 process starts, 0 listens (node(43) kaoiro-runner-switch.sh(11) kaoiro-runner(1)) |
| `codexStateKeepSafety.test.ts` | integration | read, not probed (long-running): drives the real updater and switch scripts or the lineage harness, which start Node and shell processes |
| `codexStateWorkflow.test.ts` | integration | read, not probed (long-running): drives the real updater and switch scripts or the lineage harness, which start Node and shell processes |
| `codex_app_server_supervision.test.ts` | integration | 19 process starts, 7 listens (node(14) x86_64-(5)) |
| `codex_home_readers.test.ts` | fast | 0 process starts, 0 listens |
| `config.test.ts` | fast | 0 process starts, 0 listens |
| `config-diff.test.ts` | fast | 0 process starts, 0 listens |
| `config-watcher.test.ts` | fast | 0 process starts, 0 listens |
| `delivery-composition.test.ts` | integration | 14 process starts, 6 listens (node(14)) |
| `delivery-reload.test.ts` | fast | 0 process starts, 0 listens |
| `delivery-settings.test.ts` | fast | 0 process starts, 0 listens |
| `engine_catalog_refresh.test.ts` | fast | 0 process starts, 0 listens |
| `extra-models-options.test.ts` | fast | 0 process starts, 0 listens |
| `frozenBuildIdentity.test.ts` | integration | 28 process starts, 0 listens (git(24) node(4)) |
| `fujiRound4Matrix.test.ts` | integration | 30 process starts, 0 listens (kaoiro-runner-launch.sh(30)) |
| `grok-catalog.test.ts` | integration | 16 process starts, 0 listens (fake-grok-acp.mjs(14) kaoiro-no-such-grok(2)) |
| `grok-catalog-wiring.test.ts` | integration | 17 process starts, 0 listens (fake-grok-acp.mjs(9) sleep(4) node(4)) |
| `grok-state.test.ts` | fast | 0 process starts, 0 listens |
| `grok_sessions.test.ts` | integration | 35 process starts, 0 listens (fake-grok-acp.mjs(26) node(3) sleep(2) kaoiro-no-such-grok(2)) |
| `grok_sessions.native.test.ts` | native | skipped unless `KAOIRO_LIVE_GROK=1`; needs a real Grok |
| `landingBuildIdentity.test.ts` | integration | 428 process starts, 0 listens (git(426) sh(1) node(1)) |
| `landingTags.test.ts` | integration | 800 process starts, 0 listens (git(796) node(4)) |
| `launchShimVerify.test.ts` | integration | 61 process starts, 0 listens (node(33) kaoiro-runner-launch.sh(28)) |
| `launchShimVersion.test.ts` | integration | 3 process starts, 0 listens (kaoiro-runner-launch.sh(3)) |
| `permission_ceiling.test.ts` | fast | 0 process starts, 0 listens |
| `pid_marker.test.ts` | fast | 0 process starts, 0 listens |
| `releaseBootstrap.test.ts` | integration | 69 process starts, 0 listens (kaoiro-runner-bootstrap.sh(27) tar(18) node(18) sh(6)) |
| `releaseBuildIdentity.test.ts` | integration | 800 process starts, 0 listens (git(790) sh(4) node(4) bash(2)) |
| `releaseCleanup.test.ts` | integration | 5 process starts, 0 listens (sh(5)) |
| `releaseInstall.test.ts` | integration | 155 process starts, 0 listens (kaoiro-runner-install.sh(55) node(53) tar(47)) |
| `releaseReconciliation.test.ts` | integration | 77 process starts, 0 listens (node(61) dep(8) tar(7) sh(1)) |
| `releaseSwitch.test.ts` | integration | 56 process starts, 0 listens (node(32) kaoiro-runner-switch.sh(23) sh(1)) |
| `releaseUpdate.test.ts` | integration | 112 process starts, 2 listens (node(53) kaoiro-runner-update.sh(25) tar(24) sh(10)) |
| `repoDirectWorkspace.test.ts` | integration | 21 process starts, 0 listens (kaoiro-runner-launch.sh(21)) |
| `restore-cwd.test.ts` | fast | 0 process starts, 0 listens |
| `resume_snapshot.test.ts` | fast | 0 process starts, 0 listens |
| `runtimeAssetDeclarations.test.ts` | fast | 0 process starts, 0 listens |
| `sessions.test.ts` | fast | 0 process starts, 0 listens |
| `setup.test.ts` | integration | 1 process starts, 0 listens (agy(1)) |
| `spawn.test.ts` | integration | 6 process starts, 0 listens (node(6)) |
| `supervisor.test.ts` | fast | 0 process starts, 0 listens |
| `supervisor_grok_discovery.test.ts` | integration | 2 process starts, 0 listens (sleep(1) fake-grok-acp.mjs(1)) |
| `test-isolation.canary.test.ts` | fast (shared by every tier) | the isolation canary; selected by every tier |
| `testTiers.test.ts` | fast | added by issue #706 after the probe; read: temporary directories and a mocked `console.log` only |
| `testTierSelection.test.ts` | integration | added by issue #706 after the probe; read: starts `vitest list` processes |
| `transport.test.ts` | fast | 0 process starts, 0 listens |
| `transport-reconnect.test.ts` | integration | 0 process starts, 6 listens |
| `vitest_home_guard_wiring.test.ts` | fast | 0 process starts, 0 listens |
