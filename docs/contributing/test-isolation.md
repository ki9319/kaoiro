---
title: Test isolation
description: What a test may not reach on the host, how the shared isolation guard enforces it, and how to add a suite or an opt-in native probe.
status: accepted
last_updated: 2026-10-22
related: [runner-development]
---

# Test isolation

No test may reach the real user service manager, `gh`, `docker`, or the
outbound network ([issue #577](https://github.com/sakuraiyuta/kaoiro/issues/577)).
A test's own fake is not a safety boundary: when product code changes the
child `PATH` or environment, a fake can silently stop applying. The boundary
is the shared module
[`scripts/test/fixtures/test-isolation.mjs`](../../scripts/test/fixtures/test-isolation.mjs),
(an ES module facade over the CommonJS implementation
[`test-isolation.cjs`](../../scripts/test/fixtures/test-isolation.cjs)),
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
| L2 commands | Node processes | `systemctl`, `systemd-run`, `busctl`, `journalctl`, `loginctl`, `gh`, `docker` run only from an owned root. Otherwise they are refused with `ERR_TEST_HOST_SYSTEMD` or `ERR_TEST_HOST_TOOL`, including through `PATH`, symlinks, shells and launchers. A direct spawn is resolved as the child's `execvp` does: from the child's `PATH` (or `/usr/bin:/bin`) and its cwd, so relative and empty `PATH` elements count from there. A shell or launcher resolves its words again after it may have changed `PATH` or its cwd, so there the systemd tools are refused by name and `gh` and `docker` must be an absolute path to an owned program; a bare or relative `gh` or `docker` word is refused even when it would not run (`echo gh` too). Executing the real updater shell (directly, as a shell's script, or through a launcher) is refused unless its manager resolves to an owned program; passing its path to another program is not a launch. Privilege tools (`sudo`, `doas`, `pkexec`, `run0`, `su`) and login or interactive shells are refused (`ERR_TEST_ISOLATION`), because they rebuild the environment; a shell started by a launcher is checked like a direct one |
| L2c Node descendants | Node processes | `NODE_OPTIONS` is the single propagation channel. It carries `--require` of the CommonJS implementation. It covers `fork`, `process.execPath`, any `node` on `PATH`, shebang scripts and Node under shells. `--import` is not used, because it routes every main entry through the ES module loader and breaks Node scripts named like `fake-docker.sh`. Loading an ES module with `require` is not used either, because it fails in processes with asynchronous loader hooks such as `tsx`. `worker_threads` workers are refused (`ERR_TEST_ISOLATION`) |
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

The variable must be the probe's own `KAOIRO_` variable (not one of the guard's
`KAOIRO_TEST_ISOLATION_` variables), and the permission applies only when it is `"1"`. It covers that
process and its children, and only the listed kinds: their tools run, and the
root's own environment for them comes back (`systemd`: the session bus and
runtime directory; `docker`: `DOCKER_HOST`, `DOCKER_CONFIG`, `DOCKER_CONTEXT`;
`gh`: its config directory and tokens; `network`: `SSH_AUTH_SOCK`). In a
reused Vitest worker the permission and that environment end with the test
file. The calling file and its kinds must be listed in
[`test-isolation-permits.cjs`](../../scripts/test/fixtures/test-isolation-permits.cjs):
the guard reads the caller from V8 call sites and throws `TypeError` for a
file that is not listed, a kind it is not allowed, or a caller without a
repository file (`node -e`, standard input). This is checked on every call,
also without the opt-in, so a module-scope call fails in an ordinary run. The
checker reports any other file that mentions `permitHostAccess`. An environment
variable alone never relaxes a root: the opt-in needs the call as well.

## Adding a test or a suite

- `node --test` trees (`scripts/test`, `server/deploy/test`): every entry is a
  `*.test.mjs` whose **first import** is the isolation module. Any other
  JavaScript or TypeScript file there must be under `fixtures/` or on the
  checker's helper list.
- vitest packages: the config's `setupFiles` loads the module **first**,
  directly or through a package-local setup file whose first import is the
  module (`dashboard` does this, because a separate root cannot load an outside
  setup file in jsdom files); with several entries, `sequence.setupFiles` is
  `"list"`. The order cannot be observed, so it is read from the config
  text: `setupFiles` may appear only in a declared package's own
  `vitest.config.*` or `vite.config.*`, once, as a list of string literals.
  Every such file is held to this; any other form (a second list merged in, a
  spread, a variable, a change after the list, `setupFiles` in another file)
  is reported. The package has
  `test/test-isolation.canary.test.ts`, which calls
  `await assertIsolationActive();` at module scope as well as in its test.
- Vitest is reached only through a declared package's `test` script whose body
  is exactly `vitest run`, `pnpm build && vitest run`, or
  `python3 ../../scripts/run-grok-test-namespace.py -- vitest run`, invoked
  with no further words (`pnpm test`, `pnpm run test`, `pnpm -C <dir> test`,
  or the wrapper's `pnpm -r --filter … run test`). Any other mention of
  Vitest in a workflow step or a `package.json` script, any further word after
  an accepted invocation, `npm`/`npx`/`yarn` naming `test`, and a
  `pnpm`/`npm`/`npx`/`yarn` line with a `$` substitution (for `node`, in the
  program position) are reported. The checker then observes each package as
  that launch resolves it: it runs the package's own `vitest list --json` in
  the package directory with no arguments and requires exit 0, exactly one
  project, and the canary among the selected files. Listing collects every
  file, which runs `setupFiles` and module scope, so a project without the
  guard fails at the canary. The checker therefore needs the dependencies
  installed and what the accepted scripts build (CI builds `wrapper` and
  `runner` first); without them it reports that it cannot observe.
- A new package, tree, or launch line (workflow step or `package.json`
  script) must be added to the checker's inventory first. Otherwise the
  `node scripts/test-isolation/check.mjs` step of the CI job `test-isolation`
  fails.

## Running the checks

```sh
pnpm install --frozen-lockfile && pnpm -C dashboard install --frozen-lockfile
pnpm -C wrapper build && pnpm -C runner build
node scripts/test-isolation/check.mjs
node --test scripts/test/test-isolation.test.mjs scripts/test/check-test-isolation.test.mjs
```

These are the CI job's steps. The checker prints each problem on stderr and
one JSON line, `{"entries":N,"problems":N}`, on stdout; it exits 0 only with no
problems. Its problems are the contract violations above plus the workflow
wiring below.

The checker's observation of the real repository (minutes, because it starts
every `node --test` entry and lists every Vitest package) runs once per CI
candidate, as the `check.mjs` step. No test repeats it. Each remaining check
owns a different guarantee:

| Check | Guarantee |
|---|---|
| `node scripts/test-isolation/check.mjs` (CI step) | The real repository satisfies the contract. Its exit status is the step status |
| `check-test-isolation.test.mjs`, rule cases | Each rule of the checker (guard loading, discovery, setup order, launch lines, permit allow-list) fails on a minimal fixture |
| `check-test-isolation.test.mjs`, command cases | The checker command, started as the workflow starts it, exits 1 with the rule's message on stderr and the summary line when a fixture breaks a rule |
| `check-test-isolation.test.mjs`, workflow cases | The job's checker step and test step are present exactly, with no `continue-on-error` or `if:`. The checker (as its own problem) and this test each check the other's step, so removing either one fails the one that remains |
| `test-isolation.test.mjs` | The guard's refusals, network rules and permits |

The workflow cases read the two steps as exact lines: change them together
with `ciWiringProblems` in the checker.

## Residual risks

- A non-Node program that opens the network itself (for example `git` over
  `ssh` with keys under `HOME`) is not stopped outside the container.
- A non-Node intermediate that clears the environment drops the guard for
  any Node process below it.
- The guard trusts its internal hand-off variables (`KAOIRO_TEST_ISOLATION_*`),
  which only the spawn boundary sets. A shell that has them exported by hand
  starts its Node processes as children: they skip root initialisation and
  accept the handed-on permissions. The threat model is accident by cooperative
  test code, not forgery.
- The content of a script file, or of a script read from standard input, is
  not inspected; only the environment layer applies to it. This includes the
  accepted Vitest prefix `scripts/run-grok-test-namespace.py`.
- Only the listed launchers (`env`, `setsid`, `nohup`, `timeout`, `nice`,
  `xargs`) have their arguments checked; another program that executes its
  arguments (`stdbuf`, `flock`, …) is covered by the environment layer only.
- Shell strings are matched by words, not parsed: a `gh` or `docker` produced
  by a variable or a function inside the string is not seen.
- The Vitest observation runs in the checker's environment. A config that
  branches on the environment is observed as it resolves there. Vitest 2.1.9
  and 4.1.8 read no `VITEST_*` variable that selects the config file.
- Unix sockets are not checked, so a fixed path to a host service socket is
  reachable from Node.
- Playwright specs under `dashboard/e2e/` have their own runner, are not in
  CI, and are exempt.
