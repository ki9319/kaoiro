import "../../scripts/test/fixtures/test-isolation.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import TierReporter, {
  buildRecord, CANARY, compareSelections, countCompleteFiles, loadTiers, REPORTER, selectTier, TIERS,
} from "../scripts/tier-selection.mjs";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..");
const created: string[] = [];

// A runner-shaped directory: the named test files exist and the manifest has `declared`.
function runnerDir(declared: unknown, files: string[] = ["test/a.test.ts", "test/b.test.ts", "test/n.native.test.ts"]): string {
  const dir = mkdtempSync(join(tmpdir(), "kaoiro706-tiers-"));
  created.push(dir);
  for (const file of [...files, CANARY]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), "");
  }
  writeFileSync(join(dir, "test-tiers.json"), typeof declared === "string" ? declared : JSON.stringify(declared));
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VALID = { integration: ["test/b.test.ts"], native: ["test/n.native.test.ts"] };

describe("loadTiers", () => {
  it("returns the declared lists, and accepts empty ones", () => {
    expect(loadTiers(runnerDir(VALID))).toEqual(VALID);
    expect(loadTiers(runnerDir({ integration: [], native: [] }))).toEqual({ integration: [], native: [] });
  });

  it("reads the manifest of this package: every entry is declared once and exists", () => {
    const { integration, native } = loadTiers(RUNNER);
    expect(new Set([...integration, ...native]).size).toBe(integration.length + native.length);
  });

  it("rejects an entry that is a directory", () => {
    const dir = runnerDir(VALID);
    mkdirSync(join(dir, "test/folder.test.ts"));
    writeFileSync(join(dir, "test-tiers.json"), JSON.stringify({ integration: ["test/folder.test.ts"], native: [] }));
    expect(() => loadTiers(dir)).toThrow(/lists test\/folder\.test\.ts, which is not a regular file/);
  });

  const rejected: [string, unknown, RegExp][] = [
    ["a duplicate inside one array", { integration: ["test/b.test.ts", "test/b.test.ts"], native: [] }, /test\/b\.test\.ts is declared twice/],
    ["the same file in both arrays", { integration: ["test/b.test.ts"], native: ["test/b.test.ts"] }, /declared twice \(integration and native\)/],
    ["a file that does not exist", { integration: ["test/gone.test.ts"], native: [] }, /lists test\/gone\.test\.ts, which does not exist/],
    ["a glob entry", { integration: ["test/*.test.ts"], native: [] }, /must be a literal test\/<name>\.test\.ts path/],
    ["a traversal entry", { integration: ["test/../a.test.ts"], native: [] }, /must be a literal/],
    ["a nested entry", { integration: ["test/sub/x.test.ts"], native: [] }, /must be a literal/],
    ["a leading ./", { integration: ["./test/a.test.ts"], native: [] }, /must be a literal/],
    ["a backslash", { integration: ["test\\a.test.ts"], native: [] }, /must be a literal/],
    ["a non-string entry", { integration: [1], native: [] }, /must be a literal/],
    ["the canary", { integration: [CANARY], native: [] }, /lists the isolation canary/],
    ["an extra key", { integration: [], native: [], fast: [] }, /keys must be exactly integration and native/],
    ["a missing key", { integration: [] }, /keys must be exactly integration and native/],
    ["a value that is not an array", { integration: "test/b.test.ts", native: [] }, /integration must be an array/],
    ["an array instead of an object", [], /must be an object/],
    ["invalid JSON", "{", /cannot be read as JSON/],
  ];
  for (const [name, declared, expected] of rejected) {
    it(`rejects ${name}`, () => {
      expect(() => loadTiers(runnerDir(declared))).toThrow(expected);
    });
  }
});

describe("selectTier", () => {
  const defaults = ["**/node_modules/**"];

  it("selects every test file for the landing selection, with the default reporter", () => {
    expect(selectTier("complete", runnerDir(VALID), defaults)).toEqual({ include: ["test/**/*.test.ts"] });
  });

  it("selects fast as everything the manifest does not list, and adds the tier reporter", () => {
    expect(selectTier("fast", runnerDir(VALID), defaults)).toEqual({
      include: ["test/**/*.test.ts"],
      exclude: [...defaults, "test/b.test.ts", "test/n.native.test.ts"],
      reporters: ["default", REPORTER],
    });
  });

  it("selects the listed files and the canary for the other tiers, with the tier reporter", () => {
    const dir = runnerDir(VALID);
    expect(selectTier("integration", dir, defaults)).toEqual({ include: ["test/b.test.ts", CANARY], reporters: ["default", REPORTER] });
    expect(selectTier("native", dir, defaults)).toEqual({ include: ["test/n.native.test.ts", CANARY], reporters: ["default", REPORTER] });
  });

  it("selects the canary alone for a tier with an empty list", () => {
    expect(selectTier("native", runnerDir({ integration: [], native: [] }), defaults).include).toEqual([CANARY]);
  });

  it("names the four selectors and refuses any other value", () => {
    expect(TIERS).toEqual(["complete", "fast", "integration", "native"]);
    expect(() => selectTier("zzz", runnerDir(VALID), defaults)).toThrow(/KAOIRO_RUNNER_TIER must be one of complete, fast, integration, native/);
    expect(() => selectTier("", runnerDir(VALID), defaults)).toThrow(/must be one of/);
  });

  it("fails every selection, the landing one included, on a malformed manifest", () => {
    const dir = runnerDir({ integration: ["test/b.test.ts", "test/b.test.ts"], native: [] });
    for (const tier of TIERS) expect(() => selectTier(tier, dir, defaults)).toThrow(/declared twice/);
  });
});

describe("compareSelections", () => {
  const declared = { integration: ["test/b.test.ts"], native: ["test/n.native.test.ts"] };
  const healthy = {
    complete: ["test/a.test.ts", "test/b.test.ts", "test/n.native.test.ts", CANARY],
    fast: ["test/a.test.ts", CANARY],
    integration: ["test/b.test.ts", CANARY],
    native: ["test/n.native.test.ts", CANARY],
    declared,
  };

  it("finds no difference when the tiers partition the complete selection", () => {
    expect(compareSelections(healthy)).toEqual([]);
  });

  it("accepts a tier whose list is empty, with only the canary selected", () => {
    expect(compareSelections({
      complete: ["test/a.test.ts", CANARY], fast: ["test/a.test.ts", CANARY], integration: [CANARY], native: [CANARY],
      declared: { integration: [], native: [] },
    })).toEqual([]);
  });

  const differences: [string, Partial<typeof healthy>, string][] = [
    ["a declared file the tier does not select (an excluded name)", { integration: [CANARY] }, "integration declares test/b.test.ts, which the integration selection does not contain"],
    ["a declared native file the tier does not select", { native: [CANARY] }, "native declares test/n.native.test.ts, which the native selection does not contain"],
    ["an undeclared file selected by integration", { integration: ["test/b.test.ts", "test/a.test.ts", CANARY] }, "integration selects test/a.test.ts, which is not declared for integration"],
    ["an undeclared file selected by native", { native: ["test/n.native.test.ts", "test/a.test.ts", CANARY] }, "native selects test/a.test.ts, which is not declared for native"],
    ["a declared file that fast also selects", { fast: ["test/a.test.ts", "test/b.test.ts", CANARY] }, "fast selects test/b.test.ts, which is declared for integration"],
    ["a file the complete selection has and no tier selects", { fast: [CANARY] }, "test/a.test.ts is in the complete selection but in no tier"],
    ["a file fast selects that the complete selection does not", { fast: ["test/a.test.ts", "test/x.test.ts", CANARY] }, "fast selects test/x.test.ts, which the complete selection does not contain"],
  ];
  for (const [name, change, expected] of differences) {
    it(`names ${name}`, () => {
      expect(compareSelections({ ...healthy, ...change })).toEqual([expected]);
    });
  }
});

describe("countCompleteFiles", () => {
  it("counts the test files under test/, nested ones included", () => {
    const dir = runnerDir(VALID, ["test/a.test.ts", "test/b.test.ts", "test/sub/c.test.ts", "test/helper.ts"]);
    expect(countCompleteFiles(dir)).toBe(4);
  });
});

type Task = { type: string; tasks?: Task[]; result?: { state?: string } };
const test = (state: string): Task => ({ type: "test", result: { state } });
const file = (tasks: Task[], state = "pass"): { tasks: Task[]; result: { state: string } } => ({ tasks, result: { state } });
const base = { tier: "fast", total: 71, wallMs: 1200, commit: "abc123", errors: [] as unknown[] };

describe("buildRecord", () => {
  it("counts passed, failed and skipped cases, nested suites included", () => {
    const record = buildRecord({
      ...base, env: {},
      files: [file([test("pass"), { type: "suite", tasks: [test("pass"), test("fail"), test("skip")] }], "fail"), file([test("pass")])],
    });
    expect(record).toMatchObject({ files: 2, tests: 5, passed: 3, failed: 1, skipped: 1, errors: 0, outcome: "fail", tier: "fast", commit: "abc123", wallMs: 1200 });
    expect(record.notice).toBe("INCOMPLETE for landing: tier fast ran 2 of 71 files; the landing command is pnpm -C runner test");
  });

  it("passes when every case passes or is skipped", () => {
    const record = buildRecord({ ...base, env: {}, files: [file([test("pass"), test("skip")])] });
    expect(record).toMatchObject({ outcome: "pass", errors: 0, passed: 1, skipped: 1 });
  });

  it("fails on a file that failed without a failed case (a collection error)", () => {
    const record = buildRecord({ ...base, env: {}, files: [file([], "fail"), file([test("pass")])] });
    expect(record).toMatchObject({ outcome: "fail", failed: 0, errors: 1 });
  });

  it("fails on an unhandled error even when every case passed", () => {
    const record = buildRecord({ ...base, env: {}, files: [file([test("pass")])], errors: [new Error("late")] });
    expect(record).toMatchObject({ outcome: "fail", failed: 0, errors: 1 });
  });

  describe("identity", () => {
    const files = [file([test("pass")])];

    it("is not counted without a run and an attempt", () => {
      expect(buildRecord({ ...base, files, env: {} })).toMatchObject({ runId: null, attempt: null, counted: false });
      expect(buildRecord({ ...base, files, env: { KAOIRO_TEST_RUN_ID: "r1" } })).toMatchObject({ runId: "r1", attempt: null, counted: false });
      expect(buildRecord({ ...base, files, env: { KAOIRO_TEST_ATTEMPT: "1" } })).toMatchObject({ runId: null, attempt: 1, counted: false });
    });

    it("is counted from the CI variables or the explicit ones, the explicit ones first", () => {
      expect(buildRecord({ ...base, files, env: { GITHUB_RUN_ID: "99", GITHUB_RUN_ATTEMPT: "2" } })).toMatchObject({ runId: "99", attempt: 2, counted: true });
      expect(buildRecord({ ...base, files, env: { GITHUB_RUN_ID: "99", GITHUB_RUN_ATTEMPT: "2", KAOIRO_TEST_RUN_ID: "local", KAOIRO_TEST_ATTEMPT: "1" } }))
        .toMatchObject({ runId: "local", attempt: 1, counted: true });
    });

    it("does not count an attempt that is not a positive integer", () => {
      for (const attempt of ["0", "-1", "1.5", "x", ""]) {
        expect(buildRecord({ ...base, files, env: { KAOIRO_TEST_RUN_ID: "r", KAOIRO_TEST_ATTEMPT: attempt } })).toMatchObject({ attempt: null, counted: false });
      }
    });
  });
});

describe("TierReporter", () => {
  it("prints the record as one JSON line, then the notice", () => {
    const dir = runnerDir(VALID, ["test/a.test.ts", "test/b.test.ts"]);
    vi.stubEnv("KAOIRO_RUNNER_TIER", "integration");
    vi.stubEnv("GITHUB_SHA", "feedface");
    vi.stubEnv("KAOIRO_TEST_RUN_ID", "r7");
    vi.stubEnv("KAOIRO_TEST_ATTEMPT", "1");
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = new TierReporter();
    reporter.onInit({ config: { root: dir } });
    reporter.onFinished([file([test("pass")])], []);
    expect(out).toHaveBeenCalledTimes(2);
    const record = JSON.parse(String(out.mock.calls[0]?.[0]));
    expect(record).toMatchObject({ tier: "integration", commit: "feedface", runId: "r7", attempt: 1, counted: true, files: 1, tests: 1, outcome: "pass" });
    expect(record).not.toHaveProperty("notice");
    expect(out.mock.calls[1]?.[0]).toBe("INCOMPLETE for landing: tier integration ran 1 of 3 files; the landing command is pnpm -C runner test");
  });
});
