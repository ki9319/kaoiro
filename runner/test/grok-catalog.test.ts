import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  GROK_DEFAULT_ENTRY, GrokCatalog, GrokCatalogInvalid, grokCatalogFromInitialize, probeGrokCatalog,
} from "../src/grok-catalog.js";
import { grokSessionExists, listGrokSessions } from "../src/grok_sessions.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-grok-acp.mjs", import.meta.url));
const CWD = mkdtempSync(join(tmpdir(), "kaoiro-grok-catalog-cwd-"));
const dirs: string[] = [];

afterAll(() => rmSync(CWD, { force: true, recursive: true }));
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

// The shape Grok 1.0.52 sends in `initialize` `_meta.modelState`.
const model = (modelId: string, extra: Record<string, unknown> = {}) => ({
  modelId, name: `Grok ${modelId}`, description: `about ${modelId}`,
  _meta: { totalContextTokens: 200_000, supportsReasoningEffort: true,
    reasoningEfforts: ["high", "low"].map((value) => ({ id: value, value, label: value, default: value === "high" })) },
  ...extra,
});
const meta = (availableModels: unknown[] = [model("grok-4.7"), model("grok-4.6")], currentModelId: unknown = "grok-4.7") =>
  ({ modelState: { currentModelId, availableModels } });

function fake(scenario: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "kaoiro-grok-catalog-"));
  dirs.push(dir);
  const scenarioPath = join(dir, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const log = join(dir, "requests.jsonl");
  const pids = join(dir, "pids");
  return {
    options: { cwd: CWD, executable: FAKE,
      env: { ...process.env, FAKE_GROK_SCENARIO: scenarioPath, FAKE_GROK_LOG: log, FAKE_GROK_PIDS: pids } },
    // Requests only: the log also holds the probe's refusal of Grok's own
    // request, which has no method.
    methods: (): string[] => existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).method)
        .filter((method) => method !== undefined) : [],
    leader: async (): Promise<number> => {
      await vi.waitFor(() => expect(existsSync(pids)).toBe(true));
      return Number(readFileSync(pids, "utf8").split(" ")[0]);
    },
  };
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("grokCatalogFromInitialize", () => {
  it("puts the default entry first, then each model with its efforts, without the window", () => {
    expect(grokCatalogFromInitialize({ _meta: meta() })).toEqual([
      GROK_DEFAULT_ENTRY,
      { value: "grok-4.7", display_name: "Grok grok-4.7", description: "about grok-4.7",
        effort_levels: ["high", "low"], default_effort: "high" },
      { value: "grok-4.6", display_name: "Grok grok-4.6", description: "about grok-4.6",
        effort_levels: ["high", "low"], default_effort: "high" },
    ]);
  });

  it("accepts an id of 128 allowed characters and a model without efforts or description", () => {
    const id = `a.b_c:d-${"x".repeat(120)}`;
    const bare = { modelId: id, name: "Bare" };
    expect(grokCatalogFromInitialize({ _meta: meta([bare], id) })).toEqual([
      GROK_DEFAULT_ENTRY, { value: id, display_name: "Bare", effort_levels: [] },
    ]);
  });

  it.each([
    ["no _meta", {}],
    ["no modelState", { _meta: {} }],
    ["no availableModels", { _meta: { modelState: { currentModelId: "grok-4.7" } } }],
    ["an empty list", { _meta: meta([], "grok-4.7") }],
    ["a missing modelId", { _meta: meta([{ name: "x" }], "x") }],
    ["an empty modelId", { _meta: meta([model("")], "") }],
    ["a modelId with a space", { _meta: meta([model("grok 4")], "grok 4") }],
    ["a modelId with a slash", { _meta: meta([model("grok/4")], "grok/4") }],
    ["a modelId of 129 characters", { _meta: meta([model("x".repeat(129))], "x".repeat(129)) }],
    ["a model named default", { _meta: meta([model("default")], "default") }],
    ["a duplicate modelId", { _meta: meta([model("grok-4.7"), model("grok-4.7")]) }],
    ["a missing name", { _meta: meta([model("grok-4.7", { name: undefined })]) }],
    ["a description that is not text", { _meta: meta([model("grok-4.7", { description: 7 })]) }],
    ["efforts that are not a list", { _meta: meta([model("grok-4.7", { _meta: { reasoningEfforts: {} } })]) }],
    ["an effort without a value", { _meta: meta([model("grok-4.7", { _meta: { reasoningEfforts: [{ id: "x" }] } })]) }],
    ["a currentModelId not listed", { _meta: meta(undefined, "grok-9") }],
    ["a missing currentModelId", { _meta: { modelState: { availableModels: [model("grok-4.7")] } } }],
    ["an entry that is not an object", { _meta: meta(["grok-4.7"], "grok-4.7") }],
  ])("fails on %s", (_label, initialized) => {
    expect(() => grokCatalogFromInitialize(initialized)).toThrow(GrokCatalogInvalid);
  });
});

describe("probeGrokCatalog", () => {
  it("reads the catalog from initialize alone", async () => {
    const f = fake({ initMeta: meta() });
    expect((await probeGrokCatalog(f.options)).map((m) => m.value)).toEqual(["default", "grok-4.7", "grok-4.6"]);
    expect(f.methods()).toEqual(["initialize"]);
  }, 10_000);
});

// What the runner's probes send is what the quota measurement covers
// (docs/evidence/grok/2026-10-15-catalog-and-quota.md); any other request,
// a prompt above all, falls outside it.
describe("the session-list probes", () => {
  it("send initialize and session/list only", async () => {
    const page = { sessions: [{ sessionId: "a-1", cwd: CWD, title: "t", updatedAt: "2026-10-15T00:00:00Z" }] };
    const listing = fake({ pages: { __first__: page } });
    expect(await listGrokSessions(CWD, listing.options)).toHaveLength(1);
    expect(listing.methods()).toEqual(["initialize", "session/list"]);
    const lookup = fake({ pages: { __first__: page } });
    expect(await grokSessionExists(CWD, "a-1", lookup.options)).toBe(true);
    expect(lookup.methods()).toEqual(["initialize", "session/list"]);
  }, 10_000);
});

describe("GrokCatalog", () => {
  const warnings = () => {
    const lines: string[] = [];
    return { lines, warn: (line: string) => { lines.push(line); } };
  };

  it("offers the default entry before any reading", () => {
    expect(new GrokCatalog().current()).toEqual([GROK_DEFAULT_ENTRY]);
  });

  it.each([
    ["a missing executable", () => ({ cwd: CWD, executable: join(tmpdir(), "kaoiro-no-such-grok") })],
    ["a JSON-RPC error", () => fake({ initError: -32603 }).options],
    ["the deadline", () => ({ ...fake({ initHang: true }).options, deadlineMs: 300 })],
    ["an invalid model state", () => fake({ initMeta: meta(undefined, "grok-9") }).options],
  ])("keeps the default entry on %s as the first reading, and warns", async (_label, options) => {
    const log = warnings();
    const catalog = new GrokCatalog(probeGrokCatalog, options(), log.warn);
    expect(await catalog.refresh()).toBe(false);
    expect(catalog.current()).toEqual([GROK_DEFAULT_ENTRY]);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain("keeping the default entry");
  }, 10_000);

  it.each([
    ["a missing executable", () => ({ cwd: CWD, executable: join(tmpdir(), "kaoiro-no-such-grok") })],
    ["a JSON-RPC error", () => fake({ initError: -32603 }).options],
    ["the deadline", () => ({ ...fake({ initHang: true }).options, deadlineMs: 300 })],
    ["an invalid model state", () => fake({ initMeta: meta([model("bad id")], "bad id") }).options],
  ])("keeps the last good catalog on %s after a success", async (_label, failing) => {
    const good = fake({ initMeta: meta() }).options;
    let options: Record<string, unknown> = good;
    const log = warnings();
    const catalog = new GrokCatalog((extra) => probeGrokCatalog({ ...options, ...extra }), {}, log.warn);
    expect(await catalog.refresh()).toBe(true);
    const read = catalog.current();
    expect(read.map((m) => m.value)).toEqual(["default", "grok-4.7", "grok-4.6"]);
    options = failing();
    expect(await catalog.refresh()).toBe(false);
    expect(catalog.current()).toBe(read);
    expect(log.lines[0]).toContain("keeping the last good catalog");
  }, 10_000);

  it("drops an aborted reading quietly and ends its process group", async () => {
    const f = fake({ initHang: true });
    const log = warnings();
    const catalog = new GrokCatalog(probeGrokCatalog, f.options, log.warn);
    const refreshing = catalog.refresh();
    const leader = await f.leader();
    catalog.abort();
    expect(await refreshing).toBe(false);
    expect(groupAlive(leader)).toBe(false);
    expect(catalog.current()).toEqual([GROK_DEFAULT_ENTRY]);
    expect(log.lines).toEqual([]);
  }, 10_000);

  it("lets a newer refresh supersede the reading in flight", async () => {
    let calls = 0;
    const settle: ((value: typeof GROK_DEFAULT_ENTRY[]) => void)[] = [];
    const catalog = new GrokCatalog(() => {
      calls += 1;
      return new Promise((resolve) => settle.push(resolve));
    });
    const first = catalog.refresh();
    const second = catalog.refresh();
    settle[0]!([GROK_DEFAULT_ENTRY, { value: "old", display_name: "Old" }]);
    settle[1]!([GROK_DEFAULT_ENTRY, { value: "new", display_name: "New" }]);
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(calls).toBe(2);
    expect(catalog.current().map((m) => m.value)).toEqual(["default", "new"]);
  });
});
