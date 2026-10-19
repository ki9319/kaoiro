#!/usr/bin/env node
// Enforces the test isolation contract (docs/contributing/test-isolation.md).
// The canonical set is the declared trees as a whole, enumerated from the
// file list; launch lines are checked separately against that set.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MODULE = "scripts/test/fixtures/test-isolation.mjs";
export const NODE_TREES = ["scripts/test", "server/deploy/test"];
// Programs and modules in a node --test tree that are not entries.
export const NODE_HELPERS = ["scripts/test/mock-github-api.mjs"];
export const VITEST_PACKAGES = ["runner", "wrapper/core", "wrapper/agent-common", "wrapper/claude-code",
  "wrapper/codex", "wrapper/antigravity", "wrapper/grok", "dashboard"];
export const CANARY = "test/test-isolation.canary.test.ts";
export const EXEMPT = [
  { pattern: /^protocol\/src\/[^/]+\.type-test\.ts$/, reason: "compile-time type tests run by tsc" },
  { pattern: /^dashboard\/e2e\//, reason: "Playwright specs with their own runner; not in CI" },
];
// Files allowed to call permitHostAccess; the guard enforces their kinds.
export const PERMIT_ALLOW = createRequire(import.meta.url)("../test/fixtures/test-isolation-permits.cjs");

const SOURCE = /\.(?:js|cjs|mjs|ts|cts|mts)$/;
const PERMIT_SOURCE = /\.(?:js|cjs|mjs|jsx|ts|cts|mts|tsx|svelte)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const TEST_NAME = /(?:^|\/)(?:[^/]+[.\-_](?:test|spec)\.[^/]+|test[-.][^/]+)$/;
const TEST_DIR = /(?:^|\/)tests?\//;
const NO_MATCH = "^kaoiro-test-isolation-match-nothing$";

function files(root) {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return [...new Set(result.stdout.split("\0").filter(Boolean))]
    .filter(path => !/(?:^|\/)node_modules\//.test(path) && existsSync(join(root, path))).sort();
}

const within = (path, tree) => path === tree || path.startsWith(`${tree}/`);

/** The module path the first import statement names, or undefined. */
export function firstImport(text) {
  const body = text.replace(/^#!.*\n/, "").replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  return body.match(/^import\s+(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/)?.[1];
}

function classifyNodeTrees(root, all, problems) {
  const entries = [];
  for (const path of all) {
    const tree = NODE_TREES.find(candidate => within(path, candidate));
    if (!tree || !SOURCE.test(path) || DECLARATION.test(path)) continue;
    if (path === MODULE || within(path, `${tree}/fixtures`) || NODE_HELPERS.includes(path)) continue;
    if (!path.endsWith(".test.mjs")) {
      problems.push(`${path}: not an entry (*.test.mjs) or a declared helper`);
      continue;
    }
    const imported = firstImport(readFileSync(join(root, path), "utf8"));
    if (!imported || posix.normalize(posix.join(posix.dirname(path), imported)) !== MODULE) {
      problems.push(`${path}: first import is not ${MODULE}`);
    }
    entries.push(path);
  }
  if (entries.length === 0) problems.push("node --test trees have no entries");
  return entries;
}

function recorder(scratch) {
  const path = join(scratch, "recorder.mjs");
  writeFileSync(path, `import { appendFileSync } from "node:fs";
if (process.env.NODE_TEST_CONTEXT && !process.env.KAOIRO_ISOLATION_RECORDED) {
  process.env.KAOIRO_ISOLATION_RECORDED = "1";
  const file = process.argv[1];
  process.on("exit", () => appendFileSync(process.env.KAOIRO_ISOLATION_RECORD, JSON.stringify({ file,
    marker: Boolean(globalThis[Symbol.for("kaoiro.test.isolation")]) }) + "\\n"));
}
`);
  return path;
}

// Runs node --test with a filter that matches no test, so each file process
// only loads its imports; the recorder reports each file and its marker.
// `env -u` drops an isolation guard and test-runner context inherited from a
// calling test process, so the marker shows only what each file loads itself.
// A file without the guard still runs its top level here, so credentials are
// removed and host pointers lead nowhere. Files are passed as arguments;
// `words` are glob words from a launch line, already checked for shell syntax.
const SCRUBBED = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK", "DOCKER_CONTEXT"];
function cleanEnvironment(scratch) {
  const nowhere = join(scratch, "nowhere");
  return ["-u", "NODE_OPTIONS", "-u", "KAOIRO_TEST_ISOLATION_CHILD", "-u", "NODE_TEST_CONTEXT",
    "-u", "KAOIRO_ISOLATION_RECORDED", ...SCRUBBED.flatMap(key => ["-u", key]),
    `DBUS_SESSION_BUS_ADDRESS=unix:path=${nowhere}/bus`, `XDG_RUNTIME_DIR=${nowhere}`,
    `DOCKER_HOST=unix://${nowhere}/docker.sock`, `DOCKER_CONFIG=${nowhere}`, `GH_CONFIG_DIR=${nowhere}`];
}

function discover(scratch, cwd, { files = [], words = "" }, label) {
  const record = join(scratch, `record-${Math.random().toString(16).slice(2)}.jsonl`);
  const command = `exec "$0" --test --test-name-pattern='${NO_MATCH}' ${words} "$@"`;
  const result = spawnSync("env", [...cleanEnvironment(scratch),
    `NODE_OPTIONS=--import=${pathToFileURL(recorder(scratch)).href}`, `KAOIRO_ISOLATION_RECORD=${record}`,
    "sh", "-c", command, process.execPath, ...files], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const rows = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  return { label, status: result.status, output: `${result.stdout}${result.stderr}`.slice(0, 4_000), rows };
}

function runtimeProof(root, entries, scratch, problems) {
  const run = discover(scratch, root, { files: entries }, "canonical entries");
  if (run.status !== 0) problems.push(`canonical entries: node --test exited ${run.status}\n${run.output}`);
  const seen = new Map(run.rows.map(row => [relative(root, realpathSync(row.file)), row.marker]));
  for (const entry of entries) {
    if (!seen.has(entry)) problems.push(`${entry}: no file process reported (load failure or not discovered)`);
    else if (!seen.get(entry)) problems.push(`${entry}: loaded without the isolation marker`);
  }
  for (const file of seen.keys()) if (!entries.includes(file)) problems.push(`${file}: reported but not a canonical entry`);
}

function strayFiles(all, problems) {
  for (const path of all) {
    if (!SOURCE.test(path) || DECLARATION.test(path) || !(TEST_NAME.test(path) || TEST_DIR.test(path))) continue;
    if (NODE_TREES.some(tree => within(path, tree)) || VITEST_PACKAGES.some(pkg => within(path, `${pkg}/test`))) continue;
    if (EXEMPT.some(exempt => exempt.pattern.test(path))) continue;
    problems.push(`${path}: test file outside every declared tree`);
  }
}

function segments(script) {
  return script.split(/&&|\|\||[;|\n]/).map(part => part.trim()).filter(Boolean);
}

function launchSegment(root, cwd, segment, label, entries, scratch, problems) {
  const tokens = segment.split(/\s+/);
  if (tokens.some(token => /^--test-isolation(?:=|$)/.test(token))) {
    problems.push(`${label}: --test-isolation would run several files in one process`);
  }
  const node = tokens.findIndex(token => /(?:^|\/)node$/.test(token));
  const at = node >= 0 ? tokens.indexOf("--test", node) : -1;
  if (at >= 0) {
    const words = [...tokens.slice(node + 1, at), ...tokens.slice(at + 1)];
    const directory = resolve(root, cwd);
    if (words.some(word => /[^A-Za-z0-9_./*?=,:@+%^-]/.test(word))) {
      problems.push(`${label}: node --test arguments use shell syntax the checker does not evaluate`);
      return;
    }
    if (!existsSync(directory) || !`${realpathSync(directory)}/`.startsWith(`${root}/`)) {
      problems.push(`${label}: working directory ${cwd} is outside the repository`);
      return;
    }
    const run = discover(scratch, directory, { words: words.join(" ") }, label);
    const reported = run.rows.map(row => relative(root, realpathSync(row.file)));
    if (run.status !== 0) problems.push(`${label}: node --test exited ${run.status}\n${run.output}`);
    if (reported.length === 0) problems.push(`${label}: discovers no test file`);
    for (const file of reported) if (!entries.includes(file)) problems.push(`${label}: starts ${file}, outside the canonical entries`);
  }
  // Prefixes (assignments, launchers) may come before the runner; what
  // follows it is matched as a whole.
  const runner = tokens.findIndex(token => RUNNER.test(posix.basename(token)));
  if (runner >= 0) {
    const rest = tokens.slice(runner);
    // For node only the program position matters: its arguments do not choose what runs.
    const program = posix.basename(rest[0]) === "node" ? rest.slice(0, rest.findIndex((token, index) => index > 0 &&
      !token.startsWith("-")) + 1 || undefined) : rest;
    if (program.some(token => token.includes("$"))) {
      problems.push(`${label}: ${rest[0]} line uses substitution the checker does not evaluate`);
    } else if (rest.includes("test") &&
        !(posix.basename(rest[0]) === "pnpm" && TEST_INVOCATION.test(["pnpm", ...rest.slice(1)].join(" ")))) {
      problems.push(`${label}: a test script is invoked in a form the checker does not accept (${segment})`);
    }
  }
  if (tokens.some((token, index) => /(?:^|\/)playwright$/.test(token) && tokens[index + 1] === "test")) {
    problems.push(`${label}: playwright test is exempt only as an unlaunched runner; review before adding a launch line`);
  }
}

// A small reader for the workflow shapes this repository uses: job-level
// defaults.run.working-directory, step-level working-directory, and inline or
// block run scalars.
export function workflowRuns(text) {
  const runs = [];
  let jobs = false, job, steps = false, step;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^jobs:\s*$/.test(line)) { jobs = true; continue; }
    if (/^\S/.test(line)) { jobs = false; job = undefined; continue; }
    const jobMatch = jobs && line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (jobMatch) { job = { name: jobMatch[1], cwd: "" }; steps = false; step = undefined; continue; }
    if (!job) continue;
    if (/^ {4}steps:\s*$/.test(line)) { steps = true; continue; }
    if (steps && /^ {6}- /.test(line)) step = { cwd: undefined };
    const directory = line.match(/^\s+working-directory:\s*(.+?)\s*$/);
    if (directory) {
      if (steps && step) step.cwd = directory[1];
      else job.cwd = directory[1];
      continue;
    }
    const run = line.match(/^(\s+)(-\s+)?run:\s*(.*)$/);
    if (!run) continue;
    let body = run[3].trim().replace(/^(["'])(.*)\1$/, "$2");
    if (/^[|>][-+]?\s*$/.test(body)) {
      const indent = run[1].length + (run[2]?.length ?? 0);
      const block = [];
      while (index + 1 < lines.length &&
          (lines[index + 1].trim() === "" || lines[index + 1].search(/\S/) > indent)) {
        block.push(lines[++index]);
      }
      body = block.join("\n");
    }
    runs.push({ job, step, body });
  }
  return runs.map(({ job, step, body }) => ({ job: job.name, cwd: step?.cwd ?? job.cwd, body }));
}

// The closed set of ways to reach Vitest: a declared package's test script
// with one of these bodies, invoked with no further words. The checker then
// observes exactly that launch (observeVitest).
export const VITEST_TEST_SCRIPTS = ["vitest run", "pnpm build && vitest run",
  "python3 ../../scripts/run-grok-test-namespace.py -- vitest run"];
const RUNNER = /^(?:pnpm|npm|npx|yarn|node)$/;
const TEST_INVOCATION = /^pnpm (?:-C \S+ )?(?:run )?test$|^pnpm -r(?: --filter \S+)+ run test$/;

function vitestLaunch(label, body, accepted, problems) {
  if (!/vitest/i.test(body)) return;
  if (!accepted || !VITEST_TEST_SCRIPTS.includes(body.trim().split(/\s+/).join(" "))) {
    problems.push(`${label}: reaches Vitest outside the accepted forms (${VITEST_TEST_SCRIPTS.join(" | ")} as a declared package's test script)`);
  }
}

function launchLines(root, all, entries, scratch, problems) {
  for (const path of all.filter(path => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))) {
    const runs = workflowRuns(readFileSync(join(root, path), "utf8"));
    if (runs.length === 0) problems.push(`${path}: no run steps were read; the workflow layout is not understood`);
    for (const run of runs) {
      vitestLaunch(`${path} job ${run.job}`, run.body, false, problems);
      const cwd = (run.cwd ?? "").replace(/^\.(?:\/|$)/, "").replace(/\/$/, "");
      for (const segment of segments(run.body.split("\n").filter(line => !/^\s*#/.test(line)).join("\n"))) {
        launchSegment(root, cwd, segment, `${path} job ${run.job}`, entries, scratch, problems);
      }
    }
  }
  for (const path of all.filter(path => posix.basename(path) === "package.json")) {
    const scripts = JSON.parse(readFileSync(join(root, path), "utf8")).scripts ?? {};
    const cwd = posix.dirname(path) === "." ? "" : posix.dirname(path);
    for (const [name, script] of Object.entries(scripts)) {
      vitestLaunch(`${path} script ${name}`, script, name === "test" && VITEST_PACKAGES.includes(cwd), problems);
      for (const segment of segments(script)) launchSegment(root, cwd, segment, `${path} script ${name}`, entries, scratch, problems);
    }
  }
}

// Runs the package's own Vitest as its accepted launch does (no arguments,
// in the package directory), but only collecting: setupFiles and each file's
// module scope run, so the canary's module-scope assertion fails the listing
// when the project does not load the guard. setupFiles is per project, so one
// project whose canary passes covers every file it selects.
export function observeVitest(root, pkg, scratch) {
  const directory = join(root, pkg);
  const vitest = join(directory, "node_modules", ".bin", "vitest");
  if (!existsSync(vitest)) return [`${pkg}: cannot observe the suite: vitest is not installed (install dependencies first)`];
  const result = spawnSync("env", [...cleanEnvironment(scratch), vitest, "list", "--json"],
    { cwd: directory, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let rows;
  try { rows = JSON.parse(result.stdout); } catch { rows = undefined; }
  if (result.status !== 0 || !Array.isArray(rows)) {
    return [`${pkg}: vitest list exited ${result.status}\n${`${result.stdout}${result.stderr}`.slice(-4_000)}`];
  }
  const problems = [];
  const projects = new Set(rows.map(row => row.projectName ?? ""));
  if (projects.size !== 1) problems.push(`${pkg}: vitest selects ${projects.size} projects; exactly one is required`);
  const files = new Set(rows.map(row => relative(root, realpathSync(row.file))));
  if (!files.has(`${pkg}/${CANARY}`)) problems.push(`${pkg}: vitest does not select ${CANARY}`);
  return problems;
}

function vitestWiring(root, all, scratch, observe, problems) {
  const owners = new Set();
  for (const path of all) {
    const base = posix.basename(path);
    const config = /^(?:vitest\.(?:config|workspace)|vite\.config)\.[cm]?[jt]s$/.test(base);
    if (config && (base.startsWith("vitest") || /\btest\s*:/.test(readFileSync(join(root, path), "utf8")))) owners.add(posix.dirname(path));
    if (base === "package.json" && /\bvitest\b/.test(JSON.stringify(JSON.parse(readFileSync(join(root, path), "utf8")).scripts ?? {}))) {
      owners.add(posix.dirname(path));
    }
  }
  for (const owner of owners) if (!VITEST_PACKAGES.includes(owner)) problems.push(`${owner}: vitest package outside the declared inventory`);
  for (const pkg of VITEST_PACKAGES) {
    if (!all.includes(`${pkg}/${CANARY}`)) problems.push(`${pkg}: missing ${CANARY}`);
    else if (!/^await assertIsolationActive\(\);$/m.test(readFileSync(join(root, `${pkg}/${CANARY}`), "utf8"))) {
      problems.push(`${pkg}: ${CANARY} does not assert the guard at module scope (await assertIsolationActive();)`);
    }
    problems.push(...observe(root, pkg, scratch));
    setupOrder(root, all, pkg, problems);
  }
}

// Order is not observable from the listing, so every config file in the
// package that names setupFiles must load the module first and, with more
// than one entry, run them in sequence. Which file Vitest selects does not
// matter here: all of them are held to it.
function setupOrder(root, all, pkg, problems) {
  for (const path of all.filter(path => posix.dirname(path) === pkg && /^(?:vitest|vite)\.config\.[cm]?[jt]s$/.test(posix.basename(path)))) {
    const text = readFileSync(join(root, path), "utf8").replace(/^\s*\/\/.*$/gm, "");
    if (!/setupFiles\s*:/.test(text)) continue;
    const list = text.match(/setupFiles:\s*\[([^\]]*)\]/)?.[1];
    const entries = [...(list ?? "").matchAll(/["']([^"']+)["']/g)].map(match => match[1]);
    if (entries.length > 1 && !/sequence:\s*\{[^}]*setupFiles:\s*["']list["']/.test(text)) {
      problems.push(`${path}: several setupFiles run in parallel unless sequence.setupFiles is "list"`);
    }
    let loaded = entries[0] && posix.normalize(posix.join(pkg, entries[0]));
    // One hop: a package-local setup file whose first import is the module.
    if (loaded && loaded !== MODULE && all.includes(loaded)) {
      const hop = firstImport(readFileSync(join(root, loaded), "utf8"));
      loaded = hop && posix.normalize(posix.join(posix.dirname(loaded), hop));
    }
    if (loaded !== MODULE) problems.push(`${path}: setupFiles does not load ${MODULE} first`);
  }
}

const PERMIT_EXEMPT = [MODULE, "scripts/test/fixtures/test-isolation.cjs", "scripts/test/fixtures/test-isolation-permits.cjs",
  "scripts/test-isolation/check.mjs"];

// Early notice only: the guard checks the calling file and its kinds at run
// time. Any mention counts, so an aliased import cannot hide a call site.
function permitCalls(root, all, problems) {
  for (const path of all) {
    if (!PERMIT_SOURCE.test(path) || DECLARATION.test(path) || PERMIT_EXEMPT.includes(path)) continue;
    if (!PERMIT_ALLOW[path] && readFileSync(join(root, path), "utf8").includes("permitHostAccess")) {
      problems.push(`${path}: permitHostAccess outside the allow-list`);
    }
  }
}

/** Returns the contract violations for the repository at root. */
export function checkTestIsolation(root, { observe = observeVitest } = {}) {
  const problems = [];
  root = realpathSync(root);
  const all = files(root);
  if (!all.includes(MODULE)) problems.push(`${MODULE}: missing`);
  const scratch = mkdtempSync(join(tmpdir(), "kaoiro-isolation-check-"));
  try {
    const entries = classifyNodeTrees(root, all, problems);
    if (entries.length > 0) runtimeProof(root, entries, scratch, problems);
    strayFiles(all, problems);
    launchLines(root, all, entries, scratch, problems);
    vitestWiring(root, all, scratch, observe, problems);
    permitCalls(root, all, problems);
    return { entries: entries.length, problems };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)));
  const { entries, problems } = checkTestIsolation(root);
  for (const problem of problems) console.error(problem);
  console.log(JSON.stringify({ entries, problems: problems.length }));
  process.exitCode = problems.length === 0 ? 0 : 1;
}
