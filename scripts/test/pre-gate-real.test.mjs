// Negative controls against the real repository. Each one commits a defect into
// a scratch clone, checks that the defect is in the commit the gate will read,
// and runs the clone's own gate on that SHA. Slow (about a minute each), so it
// runs only with KAOIRO_PREGATE_REAL=1, in the remote test slot.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const skip = process.env.KAOIRO_PREGATE_REAL === "1" ? false : "set KAOIRO_PREGATE_REAL=1 (slow; run in the remote test slot)";
const work = mkdtempSync(join(tmpdir(), "kaoiro-pregate-real-"));
after(() => rmSync(work, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
const digest = (text) => createHash("sha256").update(text).digest("hex");
let counter = 0;

// Commits `transform(file)` into a fresh clone of HEAD and proves the defect is
// in the new commit and not in its parent. Returns the clone, the SHA and the
// hash of the mutated file, which the test logs.
function commitMutation(file, transform) {
  const clone = join(work, `clone-${counter++}`);
  git(work, "clone", "-q", "--local", root, clone);
  const before = readFileSync(join(clone, file), "utf8");
  const mutated = transform(before);
  assert.notEqual(mutated, before, `mutation changed nothing in ${file}`);
  writeFileSync(join(clone, file), mutated);
  git(clone, "commit", "-q", "-am", `mutation: ${file}`);
  const sha = git(clone, "rev-parse", "HEAD");
  assert.equal(git(clone, "show", `${sha}:${file}`), mutated.trimEnd());
  assert.notEqual(git(clone, "show", `${sha}^:${file}`), mutated.trimEnd());
  console.log(`mutation ${file} sha=${sha} sha256=${digest(mutated)}`);
  return { clone, sha };
}

function runGate({ clone, sha }, { path } = {}) {
  const log = join(work, `counter-${counter++}.jsonl`);
  const record = join(work, `records-${counter++}.jsonl`);
  const probe = join(work, `counter-${counter++}.mjs`);
  writeFileSync(probe, 'import { appendFileSync, existsSync } from "node:fs";\nappendFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd(), dist: existsSync("runner/dist") && existsSync("wrapper/core/dist") }) + "\\n");\n');
  const result = spawnSync(process.execPath, [join(clone, "scripts/pre-gate/pre-gate.mjs"), "--rev", sha, "--record", record, "--exec", "--", process.execPath, probe, log],
    { encoding: "utf8", env: { ...process.env, ...(path ? { PATH: path } : {}) } });
  const read = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  const gate = read(record).find((entry) => entry.command[0] === "pre-gate");
  console.log(`gate sha=${sha} exit=${result.status} stage_failed=${gate?.stage_failed} failure=${JSON.stringify(gate?.failure)} steps=${JSON.stringify(gate?.steps)}`);
  return { result, gate, runs: read(log) };
}

test("P: the unmutated commit passes and runs the suite once in the verified tree", { skip }, () => {
  const seen = runGate({ clone: root, sha: git(root, "rev-parse", "HEAD") });
  assert.equal(seen.result.status, 0, seen.result.stderr);
  assert.equal(seen.gate.failure, null);
  assert.ok(seen.gate.steps.every((entry) => entry.exit === 0));
  assert.equal(seen.runs.length, 1);
  assert.ok(seen.runs[0].cwd.includes("kaoiro-pregate-"));
  assert.equal(seen.runs[0].dist, true);
});

test("N1: dropping the build profile's PATH passthrough is caught although both builds exit 0", { skip }, () => {
  const seen = runGate(commitMutation("runner/deploy/child-process-environment.mjs", (text) =>
    text.replace(/ {2}if \(profile === "build" && typeof source\.PATH === "string" && source\.PATH\.length > 0\) \{\n {4}result\.PATH = source\.PATH;\n {2}\}\n/, "")));
  assert.notEqual(seen.result.status, 0);
  assert.equal(seen.gate.stage_failed, "ci-layout");
  assert.equal(seen.gate.failure.kind, "marker_missing");
  assert.ok(seen.gate.steps.filter((entry) => entry.name.startsWith("ci-build")).every((entry) => entry.exit === 0));
  assert.equal(seen.runs.length, 0);
});

test("N2: a pnpm other than the pinned one stops at the toolchain stage", { skip }, () => {
  const bin = join(work, "fake-pnpm");
  mkdirSync(bin);
  writeFileSync(join(bin, "pnpm"), '#!/bin/sh\n[ "$1" = "--version" ] && echo 11.0.9 && exit 0\nexit 97\n', { mode: 0o755 });
  const seen = runGate({ clone: root, sha: git(root, "rev-parse", "HEAD") }, { path: `${bin}:${process.env.PATH}` });
  assert.equal(seen.gate.stage_failed, "toolchain");
  assert.match(seen.gate.failure.detail, /expected 10\.20\.0, actual 11\.0\.9/);
  assert.equal(seen.runs.length, 0);
});

test("N3: a dependency range changed without the lockfile fails the frozen install", { skip }, () => {
  const seen = runGate(commitMutation("wrapper/core/package.json", (text) => text.replace('"phoenix": "^1.8.7"', '"phoenix": "^1.8.8"')));
  assert.equal(seen.gate.stage_failed, "install");
  assert.equal(seen.gate.failure.kind, "step_exit");
  assert.equal(seen.runs.length, 0);
});

test("N4: a type error in wrapper/core fails the build", { skip }, () => {
  const seen = runGate(commitMutation("wrapper/core/src/args.ts", (text) => `${text}\nexport const brokenForPreGate: number = "not a number";\n`));
  assert.equal(seen.gate.stage_failed, "build");
  assert.equal(seen.gate.failure.kind, "step_exit");
  assert.equal(seen.runs.length, 0);
});

test("N7: a build that exits 0 but produces nothing stops the suite as a missing artifact", { skip }, () => {
  const seen = runGate(commitMutation("runner/package.json", (text) => text.replace(/"build": "[^"]*"/, '"build": "true"')));
  assert.notEqual(seen.result.status, 0);
  assert.ok(seen.gate.steps.filter((entry) => entry.name.includes("build")).every((entry) => entry.exit === 0));
  assert.equal(seen.gate.stage_failed, "build");
  assert.equal(seen.gate.failure.kind, "artifact_missing");
  assert.deepEqual(seen.gate.failure.detail, ["runner"]);
  assert.equal(seen.runs.length, 0);
});
