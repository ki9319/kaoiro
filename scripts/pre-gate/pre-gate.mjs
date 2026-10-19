#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildRecord, DEFAULT_RECORD, exitCodeOf, runRecorded, writeRecord } from "./run-recorded.mjs";

const SCRIPT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// The same commands CI runs: the `runner` job builds the wrapper by hand, and
// `pnpm -C runner test` starts with runner's `pnpm build`.
export const BUILD_COMMANDS = [
  { name: "wrapper", args: ["-C", "wrapper", "build"] },
  { name: "runner", args: ["-C", "runner", "build"] },
];
// The argv of the nested call that scripts/with-build-identity.mjs makes.
export const EXPECTED_NESTED = "-r --filter @kaoiro/wrapper-core";
const BUDGET_MS = 120_000;
const LAYOUT_ENV_KEYS = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME",
  "COREPACK_HOME", "COREPACK_ENABLE_DOWNLOAD_PROMPT", "COREPACK_NPM_REGISTRY"];

class GateStop extends Error {
  constructor(stage, kind, detail) {
    super(`${stage}: ${kind}: ${Array.isArray(detail) ? detail.join(", ") : detail}`);
    this.stage = stage;
    this.kind = kind;
    this.detail = detail;
  }
}

export function which(name, searchPath) {
  for (const directory of (searchPath ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

export function workspacePackages(tree) {
  const found = [];
  let inPackages = false;
  for (const line of readFileSync(join(tree, "pnpm-workspace.yaml"), "utf8").split("\n")) {
    if (/^packages:\s*$/.test(line)) inPackages = true;
    else if (inPackages) {
      const item = /^\s+-\s+['"]?([^'"\s#]+)['"]?\s*(#.*)?$/.exec(line);
      if (item) found.push(item[1]);
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  return found;
}

export function buildPackages(tree) {
  return workspacePackages(tree).filter((directory) => {
    const scripts = JSON.parse(readFileSync(join(tree, directory, "package.json"), "utf8")).scripts ?? {};
    return typeof scripts.build === "string";
  });
}

export function missingArtifacts(tree) {
  const missing = [];
  for (const directory of buildPackages(tree)) {
    let entries = 0;
    try {
      entries = readdirSync(join(tree, directory, "dist")).length;
    } catch {
      // no dist directory at all
    }
    if (entries === 0) missing.push(directory);
  }
  return missing;
}

export function markerSeen(lines) {
  return lines.some((line) => line.startsWith(EXPECTED_NESTED));
}

const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
const seconds = (ms) => (ms / 1000).toFixed(1);

export async function runGate({ repo = SCRIPT_ROOT, rev = "HEAD", keep = false, exec = [], recordFile = DEFAULT_RECORD, env = process.env, budgetMs = BUDGET_MS, log = (line) => process.stderr.write(`${line}\n`) }) {
  const started = new Date();
  const steps = [];
  let stage = null;
  let failure = null;
  let exitCode = 0;
  let sha = null;
  let scratch = null;
  let tree = null;
  let phase = "revision";
  let precheckMs = null;
  const stop = (kind, detail) => {
    throw new GateStop(phase, kind, detail);
  };
  const run = (name, file, args, options = {}) => {
    const t0 = Date.now();
    const result = spawnSync(file, args, { cwd: options.cwd ?? tree, env: options.env ?? env, encoding: "utf8", maxBuffer: 1 << 28 });
    const exit = result.error ? null : exitCodeOf(result.status, result.signal);
    steps.push({ name, exit, elapsed_ms: Date.now() - t0 });
    log(`[pre-gate] ${name}: ${exit === 0 ? "ok" : "FAILED"} (${seconds(Date.now() - t0)}s)`);
    if (exit !== 0) {
      log(`${(result.stdout ?? "").slice(-4096)}${(result.stderr ?? "").slice(-4096)}`);
      stop("step_exit", `${name} ${result.error ? `could not start: ${result.error.code}` : `exited ${exit}`}`);
    }
    return result;
  };
  const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo, encoding: "utf8" }).stdout?.trim() ? true : false;
  try {
    try {
      const resolved = spawnSync("git", ["rev-parse", "--verify", `${rev}^{commit}`], { cwd: repo, encoding: "utf8" });
      if (resolved.status !== 0) stop("step_exit", `cannot resolve revision ${rev}`);
      sha = resolved.stdout.trim();
      if (dirty) log("[pre-gate] warning: uncommitted changes are not covered; only the commit is checked");
      scratch = mkdtempSync(join(tmpdir(), "kaoiro-pregate-"));
      tree = join(scratch, "tree");
      run("worktree", "git", ["worktree", "add", "--detach", tree, sha], { cwd: repo });

      phase = "toolchain";
      const pnpm = which("pnpm", env.PATH);
      if (!pnpm) stop("toolchain_mismatch", "pnpm not found on PATH");
      const rootPackage = JSON.parse(readFileSync(join(tree, "package.json"), "utf8"));
      const pinned = /^pnpm@([^+]+)/.exec(rootPackage.packageManager ?? "")?.[1];
      if (!pinned) stop("toolchain_mismatch", "root packageManager is not pnpm@<version>");
      const actual = run("pnpm-version", pnpm, ["--version"]).stdout.trim();
      if (actual !== pinned) stop("toolchain_mismatch", `pnpm: expected ${pinned}, actual ${actual}`);
      const required = /^>=\s*(\d+)/.exec(rootPackage.engines?.node ?? "")?.[1];
      if (!required) stop("toolchain_mismatch", `unsupported engines.node: ${rootPackage.engines?.node}`);
      const major = Number(process.versions.node.split(".")[0]);
      if (major < Number(required)) stop("toolchain_mismatch", `node: expected >=${required}, actual ${major}`);

      phase = "install";
      run("install", pnpm, ["install", "--offline", "--frozen-lockfile"]);

      phase = "build";
      for (const build of BUILD_COMMANDS) run(`build-${build.name}`, pnpm, build.args);
      let missing = missingArtifacts(tree);
      if (missing.length) stop("artifact_missing", missing);

      phase = "ci-layout";
      for (const directory of buildPackages(tree)) rmSync(join(tree, directory, "dist"), { recursive: true, force: true });
      const home = join(scratch, "pnpm-home");
      const marker = join(scratch, "pnpm-marker");
      mkdirSync(home);
      writeFileSync(join(home, "pnpm"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(marker)}\nexec ${quote(pnpm)} "$@"\n`, { mode: 0o755 });
      const layoutEnv = { PATH: [home, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), PNPM_HOME: home, CI: "true" };
      for (const key of LAYOUT_ENV_KEYS) if (typeof env[key] === "string") layoutEnv[key] = env[key];
      for (const build of BUILD_COMMANDS) run(`ci-build-${build.name}`, pnpm, build.args, { env: layoutEnv });
      let lines = [];
      try {
        lines = readFileSync(marker, "utf8").split("\n").filter(Boolean);
      } catch {
        // the shim never ran
      }
      if (!markerSeen(lines)) stop("marker_missing", `no nested "${EXPECTED_NESTED}" call went through PNPM_HOME (${lines.length} shim calls)`);
      missing = missingArtifacts(tree);
      if (missing.length) stop("artifact_missing", missing);
    } catch (error) {
      // An exception the gate did not plan for is still recorded, with the
      // stage it happened in, and still ends the run without a suite.
      const planned = error instanceof GateStop;
      stage = planned ? error.stage : phase;
      failure = planned ? { kind: error.kind, detail: error.detail } : { kind: "internal_error", detail: String(error?.message ?? error) };
      exitCode = planned ? 1 : 2;
      log(`[pre-gate] stopped at ${stage}: ${planned ? error.message : error.stack}`);
    }
    precheckMs = Date.now() - started.getTime();

    if (!failure && exec.length) {
      const t0 = Date.now();
      const suite = await runRecorded({ command: exec, cwd: tree, recordFile, env });
      steps.push({ name: "suite", exit: suite.exit_code, elapsed_ms: Date.now() - t0 });
      exitCode = suite.exit_code;
      if (exitCode !== 0) {
        stage = "suite";
        failure = { kind: "step_exit", detail: `suite exited ${exitCode}` };
      }
    }
  } finally {
    if (scratch && keep) log(`[pre-gate] kept ${tree}`);
    else if (scratch) {
      if (tree) spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: repo });
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const ended = new Date();
  const record = buildRecord({
    command: ["pre-gate", "--rev", sha ?? rev, ...(exec.length ? ["--exec"] : [])], cwd: repo, started, ended, exit_code: exitCode,
    revision: sha, dirty,
    extra: { stage_failed: stage, failure, steps, precheck_ms: precheckMs, over_budget: precheckMs !== null && precheckMs > budgetMs },
  });
  writeRecord(record, recordFile);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (flag === "--rev" && args.length) options.rev = args.shift();
    else if (flag === "--repo" && args.length) options.repo = args.shift();
    else if (flag === "--record" && args.length) options.recordFile = args.shift();
    else if (flag === "--keep") options.keep = true;
    else if (flag === "--exec") {
      if (args[0] === "--") args.shift();
      options.exec = args.splice(0);
    } else {
      process.stderr.write("usage: pre-gate.mjs [--repo DIR] [--rev REV] [--record FILE] [--keep] [--exec -- <command> [args...]]\n");
      process.exitCode = 2;
      options.exec = null;
      break;
    }
  }
  if (options.exec !== null) {
    try {
      process.exitCode = (await runGate(options)).exit_code;
    } catch (error) {
      process.stderr.write(`pre-gate: internal error: ${error.stack}\n`);
      process.exitCode = 2;
    }
  }
}
