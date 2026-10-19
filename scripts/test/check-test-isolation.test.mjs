import "./fixtures/test-isolation.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkTestIsolation, MODULE, observeVitest, VITEST_PACKAGES } from "../test-isolation/check.mjs";

const REAL_MODULE = fileURLToPath(new URL("./fixtures/test-isolation.mjs", import.meta.url));
// Built by concatenation so this file is not itself a permit call site.
const PERMIT = "permit" + "HostAccess";

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const importLine = path => `import "${posix.relative(posix.dirname(path), MODULE).replace(/^(?!\.)/, "./")}";\n`;
const entry = path => `${importLine(path)}import { test } from "node:test";\ntest("fixture", () => {});\n`;

// A minimal repository that satisfies the contract; each test breaks one thing.
function fixtureRepository() {
  const root = mkdtempSync(join(tmpdir(), "kaoiro577-checker-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  write(root, MODULE, readFileSync(REAL_MODULE, "utf8"));
  for (const suffix of [".cjs", "-permits.cjs", "-canary.mjs"]) {
    write(root, MODULE.replace(/\.mjs$/, suffix), readFileSync(REAL_MODULE.replace(/\.mjs$/, suffix), "utf8"));
  }
  write(root, "scripts/test/mock-github-api.mjs", "export {};\n");
  write(root, "scripts/test/a.test.mjs", entry("scripts/test/a.test.mjs"));
  write(root, "scripts/test/fixtures/helper.mjs", "export {};\n");
  write(root, "server/deploy/test/b.test.mjs", entry("server/deploy/test/b.test.mjs"));
  write(root, "server/deploy/package.json", JSON.stringify({ scripts: { test: "node --test" } }));
  for (const pkg of VITEST_PACKAGES) {
    write(root, `${pkg}/vitest.config.ts`, `export default { test: { setupFiles: ["${posix.relative(pkg, MODULE)}"] } };\n`);
    write(root, `${pkg}/test/test-isolation.canary.test.ts`, "await assertIsolationActive();\n");
    write(root, `${pkg}/package.json`, JSON.stringify({ scripts: { test: "vitest run" } }));
  }
  write(root, ".github/workflows/ci.yml", [
    "on:", "  push:", "jobs:", "  scripts:", "    runs-on: ubuntu-latest", "    steps:",
    "      - run: node --test scripts/test/a.test.mjs", "  deploy:", "    defaults:", "      run:",
    "        working-directory: server/deploy", "    steps:", "      - run: node --test", ""].join("\n"));
  return root;
}

function problemsAfter(mutate) {
  const root = fixtureRepository();
  try {
    mutate(root);
    // Grammar and wiring only; observeVitest is exercised against a real
    // Vitest below and by the real repository test.
    return checkTestIsolation(root, { observe: () => [] }).problems;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("a repository that follows the contract has no problems", () => {
  assert.deepEqual(problemsAfter(() => {}), []);
});

test("a package-local setup file that imports the module first is accepted", () => {
  assert.deepEqual(problemsAfter(root => {
    write(root, "dashboard/test/isolation.setup.ts", 'import "../../scripts/test/fixtures/test-isolation.mjs";\n');
    write(root, "dashboard/vitest.config.ts", 'export default { test: { setupFiles: ["test/isolation.setup.ts"] } };\n');
  }), []);
});

const mutations = {
  "an existing scripts entry loses its first import": [
    root => write(root, "scripts/test/a.test.mjs", 'import { test } from "node:test";\ntest("x", () => {});\n'),
    /scripts\/test\/a\.test\.mjs: first import is not/],
  "an existing deploy entry loses its first import": [
    root => write(root, "server/deploy/test/b.test.mjs", 'import { test } from "node:test";\ntest("x", () => {});\n'),
    /server\/deploy\/test\/b\.test\.mjs: first import is not/],
  "a new .test.cjs entry in scripts/test": [
    root => write(root, "scripts/test/new.test.cjs", "require('node:test');\n"),
    /scripts\/test\/new\.test\.cjs: not an entry/],
  "a new .test.cjs entry in server/deploy/test": [
    root => write(root, "server/deploy/test/new.test.cjs", "require('node:test');\n"),
    /server\/deploy\/test\/new\.test\.cjs: not an entry/],
  "a new entry without the import": [
    root => write(root, "scripts/test/new.test.mjs", 'import { test } from "node:test";\n'),
    /scripts\/test\/new\.test\.mjs: first import is not/],
  "an unlisted helper in a node --test tree": [
    root => write(root, "scripts/test/helper.mjs", "export {};\n"),
    /scripts\/test\/helper\.mjs: not an entry/],
  "a test file outside every declared tree": [
    root => write(root, "server/deploy/new.test.mjs", entry("server/deploy/new.test.mjs")),
    /server\/deploy\/new\.test\.mjs: test file outside every declared tree/],
  "a vitest package whose setup does not load the module first": [
    root => write(root, "runner/vitest.config.ts", 'export default { test: { setupFiles: ["test/setup.ts"] } };\n'),
    /runner\/vitest\.config\.ts: setupFiles does not load/],
  "a config that merges a second setupFiles list in front of the guard": [
    root => write(root, "wrapper/core/vitest.config.ts", [
      'import { defineConfig, mergeConfig } from "vitest/config";',
      `const base = defineConfig({ test: { setupFiles: ["${posix.relative("wrapper/core", MODULE)}"] } });`,
      'export default mergeConfig(defineConfig({ test: { setupFiles: ["test/first.setup.ts"] } }), base);', ""].join("\n")),
    /wrapper\/core\/vitest\.config\.ts: setupFiles must be a single list of string literals/],
  "a setupFiles list with a spread": [
    root => write(root, "wrapper/core/vitest.config.ts",
      `const more = ["test/other.setup.ts"];\nexport default { test: { setupFiles: ["${posix.relative("wrapper/core", MODULE)}", ...more] } };\n`),
    /wrapper\/core\/vitest\.config\.ts: setupFiles must be a single list of string literals/],
  "a config that changes setupFiles after the list": [
    root => write(root, "wrapper/core/vitest.config.ts",
      `const config = { test: { setupFiles: ["${posix.relative("wrapper/core", MODULE)}"] } };\nconfig.test.setupFiles.unshift("test/other.setup.ts");\nexport default config;\n`),
    /wrapper\/core\/vitest\.config\.ts: setupFiles must be a single list of string literals/],
  "setupFiles in a file the config imports": [
    root => write(root, "wrapper/core/vitest.shared.ts", 'export const shared = { setupFiles: ["test/other.setup.ts"] };\n'),
    /wrapper\/core\/vitest\.shared\.ts: setupFiles outside a declared package's vitest or vite config/],
  "a second config file whose setup does not load the module first": [
    root => write(root, "runner/vite.config.ts", 'export default { test: { setupFiles: ["test/setup.ts"] } };\n'),
    /runner\/vite\.config\.ts: setupFiles does not load/],
  "a package-local setup file that does not import the module first": [
    root => {
      write(root, "dashboard/test/isolation.setup.ts", 'import "./other.ts";\n');
      write(root, "dashboard/vitest.config.ts", 'export default { test: { setupFiles: ["test/isolation.setup.ts"] } };\n');
    },
    /dashboard\/vitest\.config\.ts: setupFiles does not load/],
  "a vitest package missing its canary": [
    root => rmSync(join(root, "wrapper/core/test/test-isolation.canary.test.ts")),
    /wrapper\/core: missing test\/test-isolation\.canary\.test\.ts/],
  "a new vitest package outside the inventory": [
    root => write(root, "extra/vitest.config.ts", "export default { test: {} };\n"),
    /extra: vitest package outside the declared inventory/],
  "a workflow line starting a file outside the canonical entries": [
    root => {
      write(root, "scripts/other/x.test.mjs", entry("scripts/other/x.test.mjs"));
      write(root, ".github/workflows/extra.yml", "jobs:\n  x:\n    steps:\n      - run: node --test scripts/other/x.test.mjs\n");
    },
    /extra\.yml job x: starts scripts\/other\/x\.test\.mjs, outside the canonical entries/],
  "a launch line that discovers nothing": [
    root => write(root, ".github/workflows/extra.yml", "jobs:\n  x:\n    steps:\n      - run: node --test scripts/test/none*.test.mjs\n"),
    /extra\.yml job x: discovers no test file/],
  "a test script selects another config with -c": [
    root => write(root, "wrapper/core/package.json", JSON.stringify({ scripts: { test: "vitest run -c alternate.config.ts" } })),
    /wrapper\/core\/package\.json script test: reaches Vitest outside the accepted forms/],
  "a test script selects another config with --config=": [
    root => write(root, "wrapper/grok/package.json", JSON.stringify({ scripts: { test: "vitest run --config=vitest.config.ts" } })),
    /wrapper\/grok\/package\.json script test: reaches Vitest outside the accepted forms/],
  "a test script changes directory before Vitest": [
    root => write(root, "runner/package.json", JSON.stringify({ scripts: { test: "cd test && vitest run" } })),
    /runner\/package\.json script test: reaches Vitest outside the accepted forms/],
  "another script of a declared package runs Vitest": [
    root => write(root, "dashboard/package.json", JSON.stringify({ scripts: { test: "vitest run", "test:one": "vitest run test/one.test.ts" } })),
    /dashboard\/package\.json script test:one: reaches Vitest outside the accepted forms/],
  "a workflow runs Vitest directly": [
    root => write(root, ".github/workflows/extra.yml", "jobs:\n  x:\n    steps:\n      - run: pnpm exec vitest run\n"),
    /extra\.yml job x: reaches Vitest outside the accepted forms/],
  "a workflow passes words to the test script": [
    root => write(root, ".github/workflows/extra.yml", "jobs:\n  x:\n    steps:\n      - run: pnpm -C runner test -- -c x.config.ts\n"),
    /extra\.yml job x: a test script is invoked in a form the checker does not accept/],
  "a workflow runs the test script through npm": [
    root => write(root, ".github/workflows/extra.yml", "jobs:\n  x:\n    steps:\n      - run: npm test\n"),
    /extra\.yml job x: a test script is invoked in a form the checker does not accept/],
  "a workflow line takes its script from a substitution": [
    root => write(root, ".github/workflows/extra.yml", "jobs:\n  x:\n    steps:\n      - run: pnpm run ${{ matrix.script }} -- -c x\n"),
    /extra\.yml job x: pnpm line uses substitution the checker does not evaluate/],
  "a workflow node line takes its program from a variable": [
    root => write(root, ".github/workflows/extra.yml", "jobs:\n  x:\n    steps:\n      - run: node \"$ENTRY\" run\n"),
    /extra\.yml job x: node line uses substitution the checker does not evaluate/],
  "a canary that asserts only inside a test": [
    root => write(root, "runner/test/test-isolation.canary.test.ts", 'it("x", async () => { await assertIsolationActive(); });\n'),
    /runner: test\/test-isolation\.canary\.test\.ts does not assert the guard at module scope/],

  "a playwright launch line": [
    root => write(root, "dashboard/package.json", JSON.stringify({ scripts: { test: "vitest run", e2e: "playwright test" } })),
    /script e2e: playwright test is exempt only as an unlaunched runner/],
  "a permit call outside the allow-list": [
    root => write(root, "scripts/test/a.test.mjs",
      `${entry("scripts/test/a.test.mjs")}${PERMIT}({ kinds: ["network"], optIn: "X", reason: "r" });\n`),
    new RegExp(`scripts/test/a\\.test\\.mjs: ${PERMIT} outside the allow-list`)],
  "a launch line that runs files in one process": [
    root => write(root, "server/deploy/package.json", JSON.stringify({ scripts: { test: "node --test --test-isolation=none" } })),
    /--test-isolation would run several files in one process/],
  "a launch line with a flag before --test starting a file outside the set": [
    root => {
      write(root, "scripts/other/y.test.mjs", entry("scripts/other/y.test.mjs"));
      write(root, ".github/workflows/extra.yml", "jobs:\n  y:\n    steps:\n      - run: node --no-warnings --test scripts/other/y.test.mjs\n");
    },
    /extra\.yml job y: starts scripts\/other\/y\.test\.mjs, outside the canonical entries/],
  "a workflow whose run steps cannot be read": [
    root => write(root, ".github/workflows/odd.yml", "jobs:\n   z:\n       steps:\n         - run: node --test scripts/other/z.test.mjs\n"),
    /odd\.yml: no run steps were read/],
  "a canary that does not assert anything": [
    root => write(root, "wrapper/core/test/test-isolation.canary.test.ts", "// nothing\n"),
    /wrapper\/core: test\/test-isolation\.canary\.test\.ts does not assert the guard at module scope/],
  "several setup files without a sequential order": [
    root => write(root, "runner/vitest.config.ts", `export default { test: { setupFiles: ["${posix.relative("runner", MODULE)}", "test/setup.ts"] } };\n`),
    /runner\/vitest\.config\.ts: several setupFiles run in parallel/],
  "an aliased permit import outside the allow-list": [
    root => write(root, "scripts/test/a.test.mjs",
      `import { ${PERMIT} as allow } from "./fixtures/test-isolation.mjs";\nallow({ kinds: ["network"], optIn: "X", reason: "r" });\n`),
    new RegExp(`scripts/test/a\\.test\\.mjs: ${PERMIT} outside the allow-list`)],
  "a launch line with shell syntax": [
    root => write(root, ".github/workflows/extra.yml", "jobs:\n  x:\n    steps:\n      - run: node --test scripts/test/a.test.mjs $(id)\n"),
    /extra\.yml job x: node --test arguments use shell syntax/],
  "a launch line whose working directory leaves the repository": [
    root => write(root, ".github/workflows/extra.yml", "jobs:\n  x:\n    defaults:\n      run:\n        working-directory: ../..\n    steps:\n      - run: node --test\n"),
    /extra\.yml job x: working directory \.\.\/\.\. is outside the repository/],
  "a correctly named import that does not install the guard": [
    root => write(root, MODULE, "export {};\n"),
    /scripts\/test\/a\.test\.mjs: loaded without the isolation marker/],
};

for (const [name, [mutate, expected]] of Object.entries(mutations)) {
  test(`the checker is red when ${name}`, () => {
    const problems = problemsAfter(mutate);
    assert.ok(problems.some(problem => expected.test(problem)), problems.join("\n") || "no problems reported");
  });
}

test("every declared package is observed and its problems are reported", () => {
  const root = fixtureRepository();
  try {
    const observed = [];
    const { problems } = checkTestIsolation(root, { observe: (_, pkg) => { observed.push(pkg); return [`${pkg}: observed`]; } });
    assert.deepEqual(observed, VITEST_PACKAGES);
    assert.deepEqual(problems, VITEST_PACKAGES.map(pkg => `${pkg}: observed`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// observeVitest against a real Vitest (wrapper/core's, linked into a small
// package), so its verdicts come from Vitest's own config resolution.
const REAL_VITEST_MODULES = fileURLToPath(new URL("../../wrapper/core/node_modules", import.meta.url));
const CANARY_TEXT = 'import { it } from "vitest";\nimport { assertIsolationActive } from "../../../scripts/test/fixtures/test-isolation-canary.mjs";\n' +
  'await assertIsolationActive();\nit("canary", async () => { await assertIsolationActive(); });\n';
const SETUP = `setupFiles: ["${posix.relative("wrapper/core", MODULE)}"]`;

function observed(config, extra = {}) {
  assert.ok(existsSync(REAL_VITEST_MODULES), "install dependencies: wrapper/core/node_modules is needed to observe Vitest");
  const root = fixtureRepository();
  const scratch = mkdtempSync(join(tmpdir(), "kaoiro577-observe-"));
  try {
    symlinkSync(REAL_VITEST_MODULES, join(root, "wrapper/core/node_modules"));
    write(root, "wrapper/core/vitest.config.ts", config);
    write(root, "wrapper/core/test/test-isolation.canary.test.ts", CANARY_TEXT);
    write(root, "wrapper/core/test/other.test.ts", 'import { it } from "vitest";\nit("other", () => {});\n');
    for (const [path, text] of Object.entries(extra)) write(root, path, text);
    return observeVitest(root, "wrapper/core", scratch);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("a real Vitest package that loads the guard is observed without problems", () => {
  assert.deepEqual(observed(`export default { test: { include: ["test/**/*.test.ts"], ${SETUP} } };\n`), []);
});

test("a real Vitest package whose config lacks the setup fails the listing", () => {
  const problems = observed('export default { test: { include: ["test/**/*.test.ts"] } };\n');
  assert.match(problems.join("\n"), /wrapper\/core: vitest list exited 1[\s\S]*test isolation is not loaded/);
});

test("a real Vitest package whose config does not select the canary is reported", () => {
  const problems = observed(`export default { test: { include: ["test/other.test.ts"], ${SETUP} } };\n`);
  assert.deepEqual(problems, ["wrapper/core: vitest does not select test/test-isolation.canary.test.ts"]);
});

test("a real Vitest package with more than one project is reported", () => {
  const project = (name, include) => `{ test: { name: "${name}", include: ["${include}"], ${SETUP} } }`;
  const problems = observed(`export default { test: { ${SETUP} } };\n`, {
    "wrapper/core/vitest.workspace.ts": `export default [${project("one", "test/other.test.ts")}, ${project("two", "test/test-isolation.canary.test.ts")}];\n`,
  });
  assert.deepEqual(problems, ["wrapper/core: vitest selects 2 projects; exactly one is required"]);
});

test("a package without Vitest installed cannot be observed and is reported", () => {
  const root = fixtureRepository();
  try {
    assert.deepEqual(observeVitest(root, "runner", root), ["runner: cannot observe the suite: vitest is not installed (install dependencies first)"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the real repository satisfies the contract", () => {
  const { entries, problems } = checkTestIsolation(fileURLToPath(new URL("../..", import.meta.url)));
  assert.deepEqual(problems, []);
  assert.ok(entries > 0);
});
