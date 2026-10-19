---
title: Test isolation
description: What a test may not reach on the host, how the shared isolation guard enforces it, and how to add a suite or an opt-in native probe.
status: accepted
last_updated: 2026-10-19
related: [runner-development]
---

# Test isolation

No test may reach the real user service manager, `gh`, `docker`, or the
outbound network ([issue #577](https://github.com/sakuraiyuta/kaoiro/issues/577)).
A test's own fake is not a safety boundary: when product code changes the
child `PATH` or environment, a fake can silently stop applying. The boundary
is the shared module
[`scripts/test/fixtures/test-isolation.mjs`](../../scripts/test/fixtures/test-isolation.mjs),
and [`scripts/test-isolation/check.mjs`](../../scripts/test-isolation/check.mjs)
makes loading it mandatory.

## Where tests run

| Place | Host surfaces present | Role of the guard |
|---|---|---|
| Disposable test container (no network, no systemd, no `gh`/`docker`) | none | Keeps suites behaving the same; the place to run negative controls with the guard removed |
| Developer or agent host, CI runner, contributor machine | user manager, logged-in tools, network | The safety boundary |

## Layers

| Layer | Applies to | What it does |
|---|---|---|
| L1a root environment | the first test process | Removes `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `SSH_AUTH_SOCK`, `DOCKER_CONTEXT`. Points `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `DOCKER_HOST`, `DOCKER_CONFIG`, `GH_CONFIG_DIR` at a fresh owned directory |
| L1b spawn boundary | every `child_process` call | After product code has built `options.env`, replaces any of those pointers that is missing or not owned, removes `DOCKER_CONTEXT` unless `DOCKER_CONFIG` is owned, and adds the guard's preload to `NODE_OPTIONS` together with the internal child marker. Reaches non-Node descendants through the environment |
| L2 commands | Node processes | `systemctl`, `systemd-run`, `busctl`, `journalctl`, `loginctl`, `gh`, `docker` run only from an owned root. Otherwise they are refused with `ERR_TEST_HOST_SYSTEMD` or `ERR_TEST_HOST_TOOL`, including through `PATH`, symlinks, shells and launchers. Executing the real updater shell (directly, as a shell's script, or through a launcher) is refused unless its manager resolves to an owned program; passing its path to another program is not a launch |
| L2c Node descendants | Node processes | `NODE_OPTIONS` is the single propagation channel. It carries `--require` of [`test-isolation-preload.cjs`](../../scripts/test/fixtures/test-isolation-preload.cjs), which loads the module through `require(esm)` (Node 22.12 or later). It covers `fork`, `process.execPath`, any `node` on `PATH`, shebang scripts and Node under shells. `--import` is not used, because it would route every main entry through the ES module loader and break Node scripts named like `fake-docker.sh`. `worker_threads` workers are refused (`ERR_TEST_ISOLATION`) |
| L3 network | Node processes | TCP (including `http`, `https`, `tls`, `fetch`), UDP and DNS to anything but loopback are refused with `ERR_TEST_NETWORK`. Unix sockets are allowed |

A child started through the boundary carries an internal marker. It keeps
the environment it was given, including fixture tokens and owned pointers,
instead of initialising again.

**Owned roots** are the OS temp directory plus directories passed to
`registerOwnedRoot(dir)`. Put fakes there; a fake named like a host tool
runs normally.

## Opt-in native and live probes

A test that deliberately needs a host surface calls

```js
permitHostAccess({ kinds: ["systemd"], optIn: "KAOIRO_RELEASE_UNIT_PROBE", reason: "..." });
```

The permission applies only when the named variable is `"1"`. It covers that
process and its children, and only the listed kinds. The checker allows the
call only from the files in its `PERMIT_ALLOW` table. An environment
variable alone never disables the guard.

## Adding a test or a suite

- `node --test` trees (`scripts/test`, `server/deploy/test`): every entry is a
  `*.test.mjs` whose **first import** is the isolation module. Any other
  JavaScript or TypeScript file there must be under `fixtures/` or on the
  checker's helper list.
- vitest packages: the config's `setupFiles` loads the module **first**,
  directly or through a package-local setup file whose first import is the
  module (`dashboard` does this, because a separate root cannot load an outside
  setup file in jsdom files). The package has `test/test-isolation.canary.test.ts`.
- A new package, tree, or launch line (workflow step or `package.json`
  script) must be added to the checker's inventory first. Otherwise
  `node scripts/test-isolation/check.mjs` fails in CI.

## Residual risks

- A non-Node program that opens the network itself (for example `git` over
  `ssh` with keys under `HOME`) is not stopped outside the container.
- A non-Node intermediate that clears the environment drops the guard for
  any Node process below it.
- Playwright specs under `dashboard/e2e/` have their own runner, are not in
  CI, and are exempt.
