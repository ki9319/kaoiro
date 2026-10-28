import "./fixtures/test-isolation.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runNodeEntries } from "../test-isolation/run-node-tests.mjs";

function fixture(files, fn) {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-node-ci-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    execFileSync("git", ["add", "--", ...Object.keys(files)], { cwd: root });
    return fn(root, Object.keys(files));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const testFile = body => `import { test, describe, it } from "node:test";\n${body}\n`;
const skipped = testFile('test("skipped", { skip: true }, () => {});');
const exception = path => [{ path, issue: 872, reason: "fixture" }];
const has = (problems, text) => assert.ok(problems.some(problem => problem.includes(text)), problems.join("\n"));

for (const [name, body] of Object.entries({
  "all skipped": skipped,
  "no tests": testFile(""),
  "empty suite": testFile('describe("empty", () => {});'),
  "suite with only skipped tests": testFile('describe("only skipped", () => { it("x", { skip: true }, () => {}); });'),
})) {
  test(`an entry with ${name} is rejected`, () => fixture({ "empty.test.mjs": body }, (root, entries) => {
    has(runNodeEntries(root, entries, []), "no real test ran");
  }));
}

test("real tests with partial skips and todo are accepted", () => fixture({ "good.test.mjs":
  testFile('test("works", () => {}); test("skip", { skip: true }, () => {}); test.todo("later");') }, (root, entries) => {
  assert.deepEqual(runNodeEntries(root, entries, []), []);
}));

test("a missing path alongside a real test is detected", () => fixture({ "good.test.mjs": testFile('test("ok", () => {});') }, (root, entries) => {
  has(runNodeEntries(root, [...entries, "missing.test.mjs"], []), "missing.test.mjs: no Node test event");
}));

test("an all-skipped exception is reached and accepted", () => fixture({ "except.test.mjs": skipped }, (root, entries) => {
  assert.deepEqual(runNodeEntries(root, entries, exception(entries[0])), []);
}));

test("an exception cannot hide a failure or a newly running test", () => {
  for (const body of [testFile('test("fail", () => { throw Error("bad"); });'), testFile('test("ok", () => {});')]) {
    fixture({ "except.test.mjs": body }, (root, entries) => {
      assert.notEqual(runNodeEntries(root, entries, exception(entries[0])).length, 0);
    });
  }
});

test("an exception must remain present, tracked, unique and issue-linked", () => fixture({ "except.test.mjs": skipped }, (root, entries) => {
  for (const records of [exception("missing.test.mjs"), [...exception(entries[0]), ...exception(entries[0])],
    [{ path: entries[0], issue: 0, reason: "fixture" }], [{ path: entries[0], issue: 872, reason: "" }]]) {
    has(runNodeEntries(root, entries, records), "invalid or stale exception");
  }
}));

test("Node reports an empty file as a synthetic pass with the expected shape", () => fixture({ "empty.test.mjs": testFile("") }, (root, entries) => {
  const file = resolve(root, entries[0]);
  const reporter = fileURLToPath(new URL("../test-isolation/node-reporter.mjs", import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", `--test-reporter=${reporter}`, file], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split("\n").map(JSON.parse);
  assert.ok(events.some(event => event.event === "test:pass" && event.file === file && event.name === file &&
    event.nesting === 0 && event.line === 1 && event.column === 1 && event.type === "test"), result.stdout);
}));
