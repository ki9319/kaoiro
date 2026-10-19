import "./fixtures/test-isolation.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkTestIsolation, MODULE, VITEST_PACKAGES } from "../test-isolation/check.mjs";

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
  write(root, "scripts/test/mock-github-api.mjs", "export {};\n");
  write(root, "scripts/test/a.test.mjs", entry("scripts/test/a.test.mjs"));
  write(root, "scripts/test/fixtures/helper.mjs", "export {};\n");
  write(root, "server/deploy/test/b.test.mjs", entry("server/deploy/test/b.test.mjs"));
  write(root, "server/deploy/package.json", JSON.stringify({ scripts: { test: "node --test" } }));
  for (const pkg of VITEST_PACKAGES) {
    write(root, `${pkg}/vitest.config.ts`, `export default { test: { setupFiles: ["${posix.relative(pkg, MODULE)}"] } };\n`);
    write(root, `${pkg}/test/test-isolation.canary.test.ts`, "// canary\n");
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
    return checkTestIsolation(root).problems;
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
    /runner: setupFiles does not load/],
  "a package-local setup file that does not import the module first": [
    root => {
      write(root, "dashboard/test/isolation.setup.ts", 'import "./other.ts";\n');
      write(root, "dashboard/vitest.config.ts", 'export default { test: { setupFiles: ["test/isolation.setup.ts"] } };\n');
    },
    /dashboard: setupFiles does not load/],
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
    root => write(root, ".github/workflows/extra.yml", "jobs:\n  x:\n    steps:\n      - run: node --test 'scripts/test/none*.test.mjs'\n"),
    /extra\.yml job x: discovers no test file/],
  "vitest with a config outside the inventory": [
    root => write(root, "wrapper/grok/package.json", JSON.stringify({ scripts: { test: "vitest run --config vitest.other.config.ts" } })),
    /vitest --config vitest\.other\.config\.ts is not the package's inventoried config/],
  "a playwright launch line": [
    root => write(root, "dashboard/package.json", JSON.stringify({ scripts: { test: "vitest run", e2e: "playwright test" } })),
    /script e2e: playwright test is exempt only as an unlaunched runner/],
  "a permit call outside the allow-list": [
    root => write(root, "scripts/test/a.test.mjs",
      `${entry("scripts/test/a.test.mjs")}${PERMIT}({ kinds: ["network"], optIn: "X", reason: "r" });\n`),
    /scripts\/test\/a\.test\.mjs: permitHostAccess outside the allow-list/],
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

test("the real repository satisfies the contract", () => {
  const { entries, problems } = checkTestIsolation(fileURLToPath(new URL("../..", import.meta.url)));
  assert.deepEqual(problems, []);
  assert.ok(entries > 0);
});
