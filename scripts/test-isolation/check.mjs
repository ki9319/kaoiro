#!/usr/bin/env node
// Enforces the test isolation contract (docs/contributing/test-isolation.md).
// The canonical set is the declared trees as a whole, enumerated from the
// file list; launch lines are checked separately against that set.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
// Files allowed to call permitHostAccess, with the kinds each may relax.
export const PERMIT_ALLOW = {
  "scripts/test/production-release-native.test.mjs": ["systemd"],
  "scripts/test/production-release-unit.test.mjs": ["systemd"],
  "scripts/test/test-isolation.test.mjs": ["systemd"],
  "scripts/test/runner-pairing.test.mjs": ["docker"],
  "runner/test/grok_sessions.native.test.ts": ["network"],
  "wrapper/antigravity/test/agy131_native.test.ts": ["network"],
  "wrapper/antigravity/test/live_agy_stream_input.test.ts": ["network"],
  "wrapper/claude-code/test/haiku55_native.test.ts": ["network"],
  ...Object.fromEntries(["history", "inspect", "lifecycle", "mcp", "permission-answer", "permission-switch",
    "rate-limits", "resume", "sandbox"].map(name => [`wrapper/grok/test/native-${name}.test.ts`, ["network"]])),
};

const SOURCE = /\.(?:js|cjs|mjs|ts|cts|mts)$/;
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
function discover(scratch, cwd, args, label) {
  const record = join(scratch, `record-${Math.random().toString(16).slice(2)}.jsonl`);
  const command = `exec "$0" --test --test-name-pattern='${NO_MATCH}' ${args}`;
  const result = spawnSync("env", ["-u", "NODE_OPTIONS", "-u", "KAOIRO_TEST_ISOLATION_CHILD", "-u", "NODE_TEST_CONTEXT",
    "-u", "KAOIRO_ISOLATION_RECORDED",
    `NODE_OPTIONS=--import=${pathToFileURL(recorder(scratch)).href}`, `KAOIRO_ISOLATION_RECORD=${record}`,
    "sh", "-c", command, process.execPath], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const rows = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  return { label, status: result.status, output: `${result.stdout}${result.stderr}`, rows };
}

function runtimeProof(root, entries, scratch, problems) {
  const run = discover(scratch, root, entries.map(entry => `'${entry}'`).join(" "), "canonical entries");
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
  const node = tokens.findIndex((token, index) => /(?:^|\/)node$/.test(token) && tokens[index + 1] === "--test");
  if (node >= 0) {
    const args = tokens.slice(node + 2).join(" ");
    const run = discover(scratch, join(root, cwd), args, label);
    const reported = run.rows.map(row => relative(root, realpathSync(row.file)));
    if (run.status !== 0) problems.push(`${label}: node --test exited ${run.status}\n${run.output}`);
    if (reported.length === 0) problems.push(`${label}: discovers no test file`);
    for (const file of reported) if (!entries.includes(file)) problems.push(`${label}: starts ${file}, outside the canonical entries`);
  }
  const vitest = tokens.findIndex(token => /(?:^|\/)vitest$/.test(token));
  if (vitest >= 0) {
    if (!VITEST_PACKAGES.includes(cwd)) problems.push(`${label}: vitest outside a declared package (${cwd || "."})`);
    const config = tokens.indexOf("--config") >= 0 ? tokens[tokens.indexOf("--config") + 1]
      : tokens.find(token => token.startsWith("--config="))?.slice("--config=".length);
    if (config !== undefined && !/^(?:\.\/)?vitest\.config\.[cm]?[jt]s$/.test(config)) {
      problems.push(`${label}: vitest --config ${config} is not the package's inventoried config`);
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
    let body = run[3];
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

function launchLines(root, all, entries, scratch, problems) {
  for (const path of all.filter(path => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))) {
    for (const run of workflowRuns(readFileSync(join(root, path), "utf8"))) {
      const cwd = (run.cwd ?? "").replace(/^\.\/?/, "").replace(/\/$/, "");
      for (const segment of segments(run.body.split("\n").filter(line => !/^\s*#/.test(line)).join("\n"))) {
        launchSegment(root, cwd, segment, `${path} job ${run.job}`, entries, scratch, problems);
      }
    }
  }
  for (const path of all.filter(path => posix.basename(path) === "package.json")) {
    const scripts = JSON.parse(readFileSync(join(root, path), "utf8")).scripts ?? {};
    const cwd = posix.dirname(path) === "." ? "" : posix.dirname(path);
    for (const [name, script] of Object.entries(scripts)) {
      for (const segment of segments(script)) launchSegment(root, cwd, segment, `${path} script ${name}`, entries, scratch, problems);
    }
  }
}

function vitestWiring(root, all, problems) {
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
    const configs = all.filter(path => posix.dirname(path) === pkg && /^(?:vitest|vite)\.config\.[cm]?[jt]s$/.test(posix.basename(path)));
    const first = configs.map(path => readFileSync(join(root, path), "utf8").match(/setupFiles:\s*\[\s*["']([^"']+)["']/)?.[1])
      .find(Boolean);
    let loaded = first && posix.normalize(posix.join(pkg, first));
    // One hop: a package-local setup file whose first import is the module.
    if (loaded && loaded !== MODULE && all.includes(loaded)) {
      const hop = firstImport(readFileSync(join(root, loaded), "utf8"));
      loaded = hop && posix.normalize(posix.join(posix.dirname(loaded), hop));
    }
    if (loaded !== MODULE) problems.push(`${pkg}: setupFiles does not load ${MODULE} first`);
  }
}

function permitCalls(root, all, problems) {
  for (const path of all) {
    if (!SOURCE.test(path) || DECLARATION.test(path) || path === MODULE) continue;
    const text = readFileSync(join(root, path), "utf8");
    for (const call of text.matchAll(/permitHostAccess\(\s*\{\s*kinds:\s*\[([^\]]*)\]/g)) {
      const kinds = [...call[1].matchAll(/["']([a-z]+)["']/g)].map(match => match[1]);
      const allowed = PERMIT_ALLOW[path];
      if (!allowed) problems.push(`${path}: permitHostAccess outside the allow-list`);
      else for (const kind of kinds) if (!allowed.includes(kind)) problems.push(`${path}: permitHostAccess kind ${kind} not allowed`);
    }
    if (/permitHostAccess\(/.test(text) && !/permitHostAccess\(\s*\{\s*kinds:/.test(text) && !PERMIT_ALLOW[path]) {
      problems.push(`${path}: permitHostAccess outside the allow-list`);
    }
  }
}

/** Returns the contract violations for the repository at root. */
export function checkTestIsolation(root) {
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
    vitestWiring(root, all, problems);
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
