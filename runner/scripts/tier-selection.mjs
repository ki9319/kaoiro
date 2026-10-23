// Runner test tiers (issue #706): selection from runner/test-tiers.json and the
// record a tier run prints. docs/contributing/runner-development.md#test-tiers
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const TIERS = ["complete", "fast", "integration", "native"];
export const CANARY = "test/test-isolation.canary.test.ts";
export const REPORTER = "./scripts/tier-selection.mjs";
// A literal file directly under test/: no glob character, no ".." segment.
const ENTRY = /^test\/[A-Za-z0-9_.-]+\.test\.ts$/;
const KEYS = ["integration", "native"];

/** The declared tier lists, validated as declared (before any set is built). */
export function loadTiers(runnerDir) {
  let declared;
  try {
    declared = JSON.parse(readFileSync(join(runnerDir, "test-tiers.json"), "utf8"));
  } catch (error) {
    throw new Error(`test-tiers.json: cannot be read as JSON (${error.message})`);
  }
  if (declared === null || typeof declared !== "object" || Array.isArray(declared)) {
    throw new Error("test-tiers.json: must be an object");
  }
  const keys = Object.keys(declared).sort();
  if (keys.join() !== KEYS.join()) {
    throw new Error(`test-tiers.json: keys must be exactly ${KEYS.join(" and ")} (got ${keys.join(", ") || "none"})`);
  }
  const owner = new Map();
  for (const key of KEYS) {
    if (!Array.isArray(declared[key])) throw new Error(`test-tiers.json: ${key} must be an array`);
    for (const entry of declared[key]) {
      if (typeof entry !== "string" || !ENTRY.test(entry)) {
        throw new Error(`test-tiers.json: ${key} entry ${JSON.stringify(entry)} must be a literal test/<name>.test.ts path`);
      }
      if (entry === CANARY) throw new Error(`test-tiers.json: ${key} lists the isolation canary, which every tier selects itself`);
      if (owner.has(entry)) throw new Error(`test-tiers.json: ${entry} is declared twice (${owner.get(entry)} and ${key})`);
      const stat = statSync(join(runnerDir, entry), { throwIfNoEntry: false });
      if (!stat) throw new Error(`test-tiers.json: ${key} lists ${entry}, which does not exist`);
      if (!stat.isFile()) throw new Error(`test-tiers.json: ${key} lists ${entry}, which is not a regular file`);
      owner.set(entry, key);
    }
  }
  return { integration: [...declared.integration], native: [...declared.native] };
}

/** The Vitest `test` options that select a tier. Only `complete` is the landing selection. */
export function selectTier(tier, runnerDir, defaultExclude) {
  if (!TIERS.includes(tier)) {
    throw new Error(`KAOIRO_RUNNER_TIER must be one of ${TIERS.join(", ")} (got ${JSON.stringify(tier)})`);
  }
  const tiers = loadTiers(runnerDir);
  const include = ["test/**/*.test.ts"];
  if (tier === "complete") return { include };
  const reporters = ["default", REPORTER];
  if (tier === "fast") return { include, exclude: [...defaultExclude, ...tiers.integration, ...tiers.native], reporters };
  return { include: [...tiers[tier], CANARY], reporters };
}

/**
 * Compares what each selector actually selects (runner-relative paths, as Vitest
 * lists them) with the declarations. Returns one named problem per difference.
 * The canary is selected by every tier and is not a declaration.
 */
export function compareSelections({ complete, fast, integration, native, declared }) {
  const problems = [];
  const owner = new Map([...declared.integration.map(file => [file, "integration"]), ...declared.native.map(file => [file, "native"])]);
  const without = set => [...set].filter(file => file !== CANARY).sort();
  const selected = { fast: new Set(without(fast)), integration: new Set(without(integration)), native: new Set(without(native)) };
  const all = new Set(without(complete));
  for (const tier of ["integration", "native"]) {
    for (const file of declared[tier]) {
      if (!selected[tier].has(file)) problems.push(`${tier} declares ${file}, which the ${tier} selection does not contain`);
    }
    for (const file of selected[tier]) {
      if (!declared[tier].includes(file)) problems.push(`${tier} selects ${file}, which is not declared for ${tier}`);
    }
  }
  for (const file of selected.fast) {
    if (owner.has(file)) problems.push(`fast selects ${file}, which is declared for ${owner.get(file)}`);
  }
  // complete = fast + integration + native, in both directions.
  for (const tier of ["fast", "integration", "native"]) {
    for (const file of selected[tier]) {
      if (!all.has(file)) problems.push(`${tier} selects ${file}, which the complete selection does not contain`);
    }
  }
  const union = new Set(Object.values(selected).flatMap(files => [...files]));
  for (const file of all) {
    if (!union.has(file)) problems.push(`${file} is in the complete selection but in no tier`);
  }
  return problems;
}

/** How many test files the complete selection runs. */
export function countCompleteFiles(runnerDir) {
  return readdirSync(join(runnerDir, "test"), { recursive: true }).filter(path => path.endsWith(".test.ts")).length;
}

function* testsOf(tasks) {
  for (const task of tasks ?? []) {
    if (task.type === "suite") yield* testsOf(task.tasks);
    else yield task;
  }
}

const positive = value => (/^[1-9][0-9]*$/.test(value ?? "") ? Number(value) : null);

/**
 * One record per tier run. `errors` counts unhandled errors and files that failed
 * without a failed case (a collection error). `counted` is true only when the
 * run and attempt identity was given, so a rate never rests on a guessed identity.
 */
export function buildRecord({ tier, files, errors, total, wallMs, commit, env }) {
  const counts = { tests: 0, passed: 0, failed: 0, skipped: 0 };
  let fileErrors = 0;
  for (const file of files) {
    let failedHere = 0;
    for (const test of testsOf(file.tasks)) {
      counts.tests += 1;
      const state = test.result?.state;
      if (state === "fail") { counts.failed += 1; failedHere += 1; }
      else if (state === "pass") counts.passed += 1;
      else counts.skipped += 1;
    }
    if (file.result?.state === "fail" && failedHere === 0) fileErrors += 1;
  }
  const runId = env.KAOIRO_TEST_RUN_ID || env.GITHUB_RUN_ID || null;
  const attempt = positive(env.KAOIRO_TEST_ATTEMPT) ?? positive(env.GITHUB_RUN_ATTEMPT);
  const errorCount = errors.length + fileErrors;
  return {
    tier, commit, runId, attempt, files: files.length, ...counts, errors: errorCount,
    outcome: counts.failed > 0 || errorCount > 0 ? "fail" : "pass", wallMs, counted: runId !== null && attempt !== null,
    notice: `INCOMPLETE for landing: tier ${tier} ran ${files.length} of ${total} files; the landing command is pnpm -C runner test`,
  };
}

function headCommit(root) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Vitest reporter: used for the tiers only, never for the landing selection. */
export default class TierReporter {
  onInit(context) {
    this.root = context.config.root;
    this.started = Date.now();
  }

  onFinished(files = [], errors = []) {
    const { notice, ...record } = buildRecord({
      tier: process.env.KAOIRO_RUNNER_TIER, files, errors, total: countCompleteFiles(this.root),
      wallMs: Date.now() - this.started, commit: process.env.GITHUB_SHA || headCommit(this.root), env: process.env,
    });
    console.log(JSON.stringify(record));
    console.log(notice);
  }
}
