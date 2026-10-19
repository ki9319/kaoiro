import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUILD_COMMANDS, EXPECTED_NESTED, buildPackages, runGate, which } from "../pre-gate/pre-gate.mjs";
import { DEFAULT_RECORD, createCountParser, runRecorded } from "../pre-gate/run-recorded.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const realGateDir = join(root, "scripts", "pre-gate");
const work = mkdtempSync(join(tmpdir(), "kaoiro-pregate-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

const sh = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
let counter = 0;
const fresh = (label) => {
  const directory = join(work, `${label}-${counter++}`);
  mkdirSync(directory, { recursive: true });
  return directory;
};

// A stand-in for pnpm. Its behaviour comes from fake-mode.json in the checked
// tree, so every scenario is a committed input, as the real controls are.
const FAKE_PNPM = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const args = process.argv.slice(2);
const modeFile = path.join(process.cwd(), "fake-mode.json");
const mode = fs.existsSync(modeFile) ? JSON.parse(fs.readFileSync(modeFile, "utf8")) : {};
const ciLayout = path.basename(process.env.PNPM_HOME ?? "") === "pnpm-home";
const dist = (dir) => {
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "index.js"), "x");
};
const skipDist = ciLayout && mode.no_dist_in_ci_layout;
if (args[0] === "--version") { console.log(mode.version ?? "10.20.0"); process.exit(0); }
if (args[0] === "install") process.exit(mode.install_exit ?? 0);
if (args[0] === "-r") process.exit(0);
if (args[0] === "-C" && args[2] === "build" && args[1] === "wrapper") {
  if (mode.wrapper_exit) process.exit(mode.wrapper_exit);
  if (mode.nested !== "absent") {
    const nested = cp.spawnSync("pnpm", ["-r", "--filter", "@kaoiro/wrapper-core", "run", "build"], { stdio: "inherit" });
    if (nested.status !== 0) process.exit(nested.status ?? 1);
  }
  if (!skipDist) dist("wrapper/core");
  process.exit(0);
}
if (args[0] === "-C" && args[2] === "build" && args[1] === "runner") {
  if (!mode.no_dist_runner && !skipDist) dist("runner");
  process.exit(0);
}
process.exit(97);
`;
const COUNTER = `import { appendFileSync, existsSync } from "node:fs";
appendFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd(), dist: existsSync("wrapper/core/dist") }) + "\\n");
`;

function makeFixture(mode, rootPackage = JSON.stringify({ packageManager: "pnpm@10.20.0", engines: { node: ">=22" } })) {
  const dir = fresh("fixture");
  const repo = join(dir, "repo");
  const put = (name, content) => {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), content);
  };
  mkdirSync(repo);
  put("package.json", rootPackage);
  put("pnpm-workspace.yaml", "packages:\n  - wrapper/core\n  - runner\n# not a package\n");
  put("wrapper/core/package.json", JSON.stringify({ scripts: { build: "x" } }));
  put("runner/package.json", JSON.stringify({ scripts: { build: "x" } }));
  put("fake-mode.json", JSON.stringify(mode));
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "fixture");
  return { dir, repo, sha: sh(repo, "rev-parse", "HEAD") };
}

function fakeBin() {
  const bin = fresh("bin");
  writeFileSync(join(bin, "pnpm"), FAKE_PNPM, { mode: 0o755 });
  return bin;
}

// Runs the gate CLI from `gateDir` against a fixture whose committed
// fake-mode.json is `mode`. The suite command is a counter script.
function scenario({ mode, gateDir = realGateDir, withExec = true, path, repoEdit, rootPackage }) {
  const fixture = makeFixture(mode, rootPackage);
  if (repoEdit) repoEdit(fixture.repo);
  const tmp = fresh("tmp");
  const record = join(fixture.dir, "records.jsonl");
  const log = join(fixture.dir, "counter.jsonl");
  const counterScript = join(fixture.dir, "counter.mjs");
  writeFileSync(counterScript, COUNTER);
  const args = [join(gateDir, "pre-gate.mjs"), "--repo", fixture.repo, "--rev", fixture.sha, "--record", record];
  if (withExec) args.push("--exec", "--", process.execPath, counterScript, log);
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...process.env, PATH: path ?? `${fakeBin()}:${process.env.PATH}`, TMPDIR: tmp },
  });
  const records = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const runs = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return {
    ...fixture, tmp, result, runs,
    gate: records.find((entry) => entry.command[0] === "pre-gate"),
    leftovers: readdirSync(tmp).filter((name) => name.startsWith("kaoiro-pregate-")),
    worktrees: sh(fixture.repo, "worktree", "list").split("\n").length,
  };
}

const buildExits = (gate) => gate.steps.filter((entry) => /build/.test(entry.name)).map((entry) => entry.exit);

test("a clean tree passes, runs the suite once in the verified tree, and leaves nothing behind", () => {
  const seen = scenario({ mode: {} });
  assert.equal(seen.result.status, 0, seen.result.stderr);
  assert.equal(seen.gate.failure, null);
  assert.equal(seen.gate.stage_failed, null);
  assert.equal(seen.gate.revision, seen.sha);
  assert.deepEqual(seen.gate.steps.map((entry) => entry.name),
    ["worktree", "pnpm-version", "install", "build-wrapper", "build-runner", "ci-build-wrapper", "ci-build-runner", "suite"]);
  assert.ok(seen.gate.steps.every((entry) => entry.exit === 0));
  assert.equal(seen.runs.length, 1);
  assert.ok(seen.runs[0].cwd.includes("kaoiro-pregate-"), seen.runs[0].cwd);
  assert.equal(seen.runs[0].dist, true);
  assert.deepEqual(seen.leftovers, []);
  assert.equal(seen.worktrees, 1);
  assert.equal(seen.gate.over_budget, false);
});

test("a pnpm that differs from the pinned version stops at the toolchain stage", () => {
  const seen = scenario({ mode: { version: "11.0.9" } });
  assert.notEqual(seen.result.status, 0);
  assert.equal(seen.gate.stage_failed, "toolchain");
  assert.equal(seen.gate.failure.kind, "toolchain_mismatch");
  assert.match(seen.gate.failure.detail, /expected 10\.20\.0, actual 11\.0\.9/);
  assert.equal(seen.runs.length, 0);
});

test("a pnpm that is not on PATH stops at the toolchain stage", () => {
  const bare = fresh("bare");
  for (const tool of ["node", "git"]) symlinkSync(tool === "node" ? process.execPath : which("git", process.env.PATH), join(bare, tool));
  const seen = scenario({ mode: {}, path: bare });
  assert.equal(seen.gate.stage_failed, "toolchain");
  assert.equal(seen.gate.failure.kind, "toolchain_mismatch");
  assert.equal(seen.runs.length, 0);
});

test("a failing frozen-lockfile install stops at the install stage", () => {
  const seen = scenario({ mode: { install_exit: 1 } });
  assert.equal(seen.gate.stage_failed, "install");
  assert.equal(seen.gate.failure.kind, "step_exit");
  assert.equal(seen.runs.length, 0);
});

test("a build that exits non-zero is a step_exit failure, not a missing artifact", () => {
  const seen = scenario({ mode: { wrapper_exit: 2 } });
  assert.equal(seen.gate.stage_failed, "build");
  assert.equal(seen.gate.failure.kind, "step_exit");
  assert.equal(seen.runs.length, 0);
});

test("a missing artifact with every build exiting 0 stops the suite for that reason only", () => {
  const seen = scenario({ mode: { no_dist_runner: true } });
  assert.notEqual(seen.result.status, 0);
  assert.equal(buildExits(seen.gate).length, 2);
  assert.ok(buildExits(seen.gate).every((exit) => exit === 0));
  assert.equal(seen.gate.stage_failed, "build");
  assert.equal(seen.gate.failure.kind, "artifact_missing");
  assert.deepEqual(seen.gate.failure.detail, ["runner"]);
  assert.equal(seen.runs.length, 0);
});

test("an artifact that vanishes in the CI-layout rebuild is reported at that stage", () => {
  const seen = scenario({ mode: { no_dist_in_ci_layout: true } });
  assert.equal(seen.gate.stage_failed, "ci-layout");
  assert.equal(seen.gate.failure.kind, "artifact_missing");
  assert.deepEqual(seen.gate.failure.detail, ["wrapper/core", "runner"]);
  assert.ok(buildExits(seen.gate).every((exit) => exit === 0));
  assert.equal(seen.runs.length, 0);
});

test("a nested pnpm call that never goes through PNPM_HOME is caught although the builds exit 0", () => {
  const seen = scenario({ mode: { nested: "absent" } });
  assert.equal(seen.gate.stage_failed, "ci-layout");
  assert.equal(seen.gate.failure.kind, "marker_missing");
  assert.ok(buildExits(seen.gate).every((exit) => exit === 0));
  assert.equal(seen.runs.length, 0);
});

test("an unexpected exception inside the gate is recorded with its stage and returns non-zero", () => {
  const seen = scenario({ mode: {}, rootPackage: "{ invalid JSON" });
  assert.equal(seen.result.status, 2);
  assert.equal(seen.gate.stage_failed, "toolchain");
  assert.equal(seen.gate.failure.kind, "internal_error");
  assert.match(seen.gate.failure.detail, /JSON/);
  assert.equal(seen.gate.exit_code, 2);
  assert.equal(seen.runs.length, 0);
  assert.deepEqual(seen.leftovers, []);
  assert.equal(seen.worktrees, 1);
});

test("over_budget measures the checks before the suite, not the suite", async () => {
  const fixture = makeFixture({});
  const base = { repo: fixture.repo, rev: fixture.sha, recordFile: join(fixture.dir, "r.jsonl"), log: () => {},
    env: { ...process.env, PATH: `${fakeBin()}:${process.env.PATH}`, TMPDIR: fresh("tmp") },
    exec: [process.execPath, "-e", "setTimeout(() => {}, 3000)"] };
  const slowSuite = await runGate({ ...base, budgetMs: 2500 });
  assert.equal(slowSuite.exit_code, 0);
  assert.ok(slowSuite.duration_ms > 3000, String(slowSuite.duration_ms));
  assert.ok(slowSuite.precheck_ms < 2500, String(slowSuite.precheck_ms));
  assert.equal(slowSuite.over_budget, false);
  const tinyBudget = await runGate({ ...base, exec: [], budgetMs: 1 });
  assert.equal(tinyBudget.over_budget, true);
});

test("the gate alone checks the commit and starts no suite", () => {
  const seen = scenario({ mode: {}, withExec: false });
  assert.equal(seen.result.status, 0, seen.result.stderr);
  assert.equal(seen.gate.steps.at(-1).name, "ci-build-runner");
  assert.deepEqual(seen.leftovers, []);
});

test("a dirty tree warns, is recorded as dirty, and the checked revision is the commit", () => {
  const seen = scenario({ mode: {}, repoEdit: (repo) => writeFileSync(join(repo, "package.json"), "{}\n") });
  assert.match(seen.result.stderr, /uncommitted changes are not covered/);
  assert.equal(seen.gate.dirty, true);
  assert.equal(seen.gate.revision, seen.sha);
  assert.equal(seen.gate.failure, null);
});

test("--keep leaves the verified tree and says where", () => {
  const fixture = makeFixture({});
  const tmp = fresh("tmp");
  const result = spawnSync(process.execPath, [join(realGateDir, "pre-gate.mjs"), "--repo", fixture.repo, "--rev", fixture.sha, "--record", join(fixture.dir, "r.jsonl"), "--keep"],
    { encoding: "utf8", env: { ...process.env, PATH: `${fakeBin()}:${process.env.PATH}`, TMPDIR: tmp } });
  assert.equal(result.status, 0, result.stderr);
  const kept = /\[pre-gate\] kept (\S+)/.exec(result.stderr)?.[1];
  assert.ok(kept && existsSync(join(kept, "fake-mode.json")), kept);
});

test("the build commands are the ones CI and the runner test script run", () => {
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  assert.ok(ci.includes("- run: pnpm -C wrapper build"));
  assert.ok(ci.includes("- run: pnpm -C runner test"));
  assert.match(JSON.parse(readFileSync(join(root, "runner/package.json"), "utf8")).scripts.test, /^pnpm build\b/);
  assert.deepEqual(BUILD_COMMANDS.map((entry) => entry.args.join(" ")), ["-C wrapper build", "-C runner build"]);
  const wrapperBuild = JSON.parse(readFileSync(join(root, "wrapper/package.json"), "utf8")).scripts.build;
  assert.ok(wrapperBuild.includes(`with-build-identity.mjs -- pnpm ${EXPECTED_NESTED}`), wrapperBuild);
});

test("the workspace parser finds the real build packages", () => {
  const packages = buildPackages(root);
  for (const expected of ["wrapper/core", "wrapper/agent-common", "runner"]) assert.ok(packages.includes(expected), expected);
});

// --- the checks guard themselves: each guard removed on its own turns the matching scenario red

function mutatedGate(from, to) {
  const dir = fresh("gate");
  cpSync(realGateDir, dir, { recursive: true });
  const file = join(dir, "pre-gate.mjs");
  const source = readFileSync(file, "utf8");
  assert.equal(source.split(from).length - 1, 1, `mutation anchor must appear once: ${from}`);
  writeFileSync(file, source.replace(from, to));
  return { dir, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
}

test("without the artifact check an artifact-only defect is no longer stopped, a build error still is", () => {
  const gate = mutatedGate("return missing;", "return [];");
  const artifact = scenario({ mode: { no_dist_runner: true }, gateDir: gate.dir });
  assert.equal(artifact.gate.failure, null, "the artifact input must now pass");
  assert.equal(artifact.runs.length, 1);
  const buildError = scenario({ mode: { wrapper_exit: 2 }, gateDir: gate.dir });
  assert.equal(buildError.gate.failure.kind, "step_exit");
  assert.equal(buildError.runs.length, 0);
});

test("without the marker assertion the PATH-dropped build is no longer stopped", () => {
  const gate = mutatedGate("return lines.some((line) => line.startsWith(EXPECTED_NESTED));", "return true;");
  const seen = scenario({ mode: { nested: "absent" }, gateDir: gate.dir });
  assert.equal(seen.gate.failure, null);
  assert.equal(seen.runs.length, 1);
});

test("without the not-started guard a failed step still starts the suite", () => {
  const gate = mutatedGate("if (!failure && exec.length) {", "if (exec.length) {");
  const seen = scenario({ mode: { version: "11.0.9" }, gateDir: gate.dir });
  assert.equal(seen.gate.failure.kind, "toolchain_mismatch");
  assert.equal(seen.runs.length, 1);
});

// --- the recorder

test("the count parser sums every summary and returns null for unknown output", () => {
  const parse = (text) => {
    const parser = createCountParser();
    parser.push(text);
    return parser.result();
  };
  const esc = String.fromCharCode(27);
  assert.deepEqual(parse(`@kaoiro/a test:  Test Files  1 passed (1)\n@kaoiro/a test:       Tests  3 passed (3)\n${esc}[32m      Tests  2 failed | 5 passed (7)${esc}[0m\n`),
    { vitest: { total: 10, passed: 8, failed: 2 } });
  assert.deepEqual(parse("# tests 7\n# pass 5\n# fail 2\n"), { "node:test": { total: 7, passed: 5, failed: 2 } });
  assert.deepEqual(parse("Finished in 1.2 seconds\n12 tests, 1 failure\n"), { mix: { total: 12, failed: 1 } });
  assert.equal(parse("nothing recognisable\n"), null);
  const split = createCountParser();
  split.push("      Tests  4 pass");
  split.push("ed (4)");
  assert.deepEqual(split.result(), { vitest: { total: 4, passed: 4 } });
});

const sink = () => {
  const chunks = [];
  return { write: (chunk) => chunks.push(String(chunk)), text: () => chunks.join("") };
};

// A child that writes stdout in pieces, with stderr output in between, the way
// two real pipes interleave.
const interleaved = (script) => [process.execPath, "-e", script];

test("an unfinished stdout line is not joined with stderr output that arrives in the middle of it", async () => {
  const record = await runRecorded({
    command: interleaved("process.stdout.write('# tests 1\\n# pass '); setTimeout(() => process.stderr.write('diagnostic\\n'), 50); setTimeout(() => process.stdout.write('1\\n# fail 0\\n'), 100);"),
    recordFile: join(fresh("rec"), "r.jsonl"), stdout: sink(), stderr: sink() });
  assert.deepEqual(record.counts, { "node:test": { total: 1, passed: 1, failed: 0 } });
});

test("each stream's last line without a newline is parsed on its own", async () => {
  const record = await runRecorded({
    command: interleaved("process.stdout.write('# tests 1\\n# pass 1'); process.stderr.write('# fail 0');"),
    recordFile: join(fresh("rec"), "r.jsonl"), stdout: sink(), stderr: sink() });
  assert.deepEqual(record.counts, { "node:test": { total: 1, passed: 1, failed: 0 } });
});

test("a multi-byte character split across chunks is decoded as one character", async () => {
  // U+00A0 is two bytes (c2 a0) and counts as whitespace before the summary key.
  const record = await runRecorded({
    command: interleaved("process.stdout.write(Buffer.from([0xc2])); setTimeout(() => process.stdout.write(Buffer.concat([Buffer.from([0xa0]), Buffer.from('# pass 1\\n')])), 80);"),
    recordFile: join(fresh("rec"), "r.jsonl"), stdout: sink(), stderr: sink() });
  assert.deepEqual(record.counts, { "node:test": { passed: 1 } });
});

test("the parser decodes each stream with its own decoder", () => {
  const parser = createCountParser();
  parser.push(Buffer.from([0xc2]), "stdout");
  parser.push(Buffer.from("x\n"), "stderr");
  parser.push(Buffer.concat([Buffer.from([0xa0]), Buffer.from("# pass 2\n")]), "stdout");
  assert.deepEqual(parser.result(), { "node:test": { passed: 2 } });
});

test("the recorder preserves a failing child's exit code and records it", async () => {
  const record = await runRecorded({ command: [process.execPath, "-e", "console.log('# tests 1\\n# pass 0\\n# fail 1'); process.exit(3)"],
    recordFile: join(fresh("rec"), "r.jsonl"), stdout: sink(), stderr: sink() });
  assert.equal(record.exit_code, 3);
  assert.equal(record.stage_failed, "suite");
  assert.deepEqual(record.counts, { "node:test": { total: 1, passed: 0, failed: 1 } });
});

test("the recorder reports a signal as 128 plus its number", async () => {
  const record = await runRecorded({ command: [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"],
    recordFile: join(fresh("rec"), "r.jsonl"), stdout: sink(), stderr: sink() });
  assert.equal(record.signal, "SIGTERM");
  assert.equal(record.exit_code, 143);
});

test("the recorder reports a command that cannot start", async () => {
  const record = await runRecorded({ command: ["/nonexistent/kaoiro-pregate"], recordFile: join(fresh("rec"), "r.jsonl"), stdout: sink(), stderr: sink() });
  assert.equal(record.exit_code, 127);
  assert.equal(record.error, "ENOENT");
});

test("an unwritable record file only warns and leaves the child's result alone", async () => {
  const err = sink();
  const record = await runRecorded({ command: [process.execPath, "-e", "process.exit(0)"], recordFile: "/dev/null/kaoiro/records.jsonl", stdout: sink(), stderr: err });
  assert.equal(record.exit_code, 0);
  assert.match(err.text(), /run-recorded: cannot write/);
  assert.match(err.text(), /KAOIRO_TEST_RUN /);
});

test("the recorder CLI exits with the child's code and appends one JSON line", () => {
  const file = join(fresh("rec"), "r.jsonl");
  const result = spawnSync(process.execPath, [join(realGateDir, "run-recorded.mjs"), "--record", file, "--", process.execPath, "-e", "process.exit(5)"], { encoding: "utf8" });
  assert.equal(result.status, 5);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).exit_code, 5);
});

test("the default record file is inside the gitignored tmp directory", () => {
  assert.equal(DEFAULT_RECORD, join(root, "tmp", "test-runs.jsonl"));
  assert.equal(spawnSync("git", ["check-ignore", "-q", "tmp/test-runs.jsonl"], { cwd: root }).status, 0);
});
