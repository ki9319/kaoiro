import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope, ResolvedSnapshotExt, WrapperConfig } from "@kaoiro/agent-common";
import { AcpSession } from "../src/acp/session.js";
import { GrokHost, type GrokHostOptions } from "../src/host.js";

// Work unit 3a (issue #644): cold resume through session/resume, the start
// selection with its sources, and the projection the server persists.

const executable = fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url));
const base: WrapperConfig = {
  agent_id: "resume-644", display_name: "Resume", server_url: "ws://127.0.0.1:1/agent",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  sandbox: "workspace-write", network_access: true,
};
vi.setConfig({ testTimeout: 30_000 });
const hosts: GrokHost[] = [];
const scratch: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) { host.close(); await host.closed; }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface Launch {
  config?: Partial<WrapperConfig>;
  env?: Record<string, string>;
  options?: Partial<GrokHostOptions>;
  root?: string;
  wait?: boolean;
}

async function launch({ config = {}, env = {}, options = {}, root, wait = true }: Launch = {}) {
  const dir = root ?? mkdtempSync(join(homedir(), ".kaoiro-grok-644-"));
  if (!root) scratch.push(dir);
  // A second host on the same root keeps the session file and logs apart.
  const events = join(dir, root ? "events-again.jsonl" : "events.jsonl");
  const sessionFile = join(dir, "session.json");
  const envelopes: Envelope[] = [];
  const host = new GrokHost({
    config: { ...base, ...config }, cwd: dir, personaPrompt: "fixture", executable,
    permissionSyncSupported: true, permissionGateTimeoutMs: 150,
    env: { ...process.env, KAOIRO_TEST_GROK_EVENTS: events, KAOIRO_TEST_GROK_SESSION_FILE: sessionFile, ...env },
    send: (e) => envelopes.push(e), decidePermission: async () => ({ allow: false }), ...options,
  });
  hosts.push(host);
  const run = host.run();
  void run.catch(() => {});
  if (wait) await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 10_000 });
  const rows = () => existsSync(events)
    ? readFileSync(events, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return {
    host, run, envelopes, rows, root: dir, sessionFile,
    methods: () => rows().map((r) => r.event),
    requests: () => rows().filter((r) => r.event === "session/set_config_option").map((r) => [r.configId, r.value]),
    states: () => envelopes.filter((e) => e.type === "state_change").map((e) => e.ext as Record<string, any>),
    ext: () => host.statusExtSnapshot() as Record<string, any>,
  };
}
type Launched = Awaited<ReturnType<typeof launch>>;

/** Mirrors the server's snapshot gate (`wrapper_channel.ex`
 *  record_snapshot_from_ext) and merge (`session_pointers.ex` merge_snapshot):
 *  a status with a pending field or a switch error is skipped; otherwise every
 *  field merges, except effort and its source, which replace as a pair. */
function persisted(statuses: Record<string, any>[], start: ResolvedSnapshotExt = {}) {
  let stored: Record<string, unknown> = { ...start };
  const history: Record<string, unknown>[] = [];
  for (const ext of statuses) {
    const effective = ext.effective;
    if (typeof effective !== "object" || effective === null) continue;
    if ("switch_error" in ext || "pending_model" in ext || "pending_effort" in ext) continue;
    const { effort: _effort, effort_source: _source, ...kept } = stored;
    stored = { ...kept, ...effective };
    history.push(stored);
  }
  return { stored: stored as ResolvedSnapshotExt, history };
}

describe("cold resume", () => {
  it("attaches with session/resume, never session/new, and stamps the cwd on every status", async () => {
    const t = await launch({ options: { resumeSessionId: "fixture-session" } });
    expect(t.methods()).toContain("session/resume");
    expect(t.methods()).not.toContain("session/new");
    expect(t.methods()).not.toContain("session/load");
    expect(t.rows().find((r) => r.event === "session/resume")).toMatchObject({ sessionId: "fixture-session" });
    expect(t.states().length).toBeGreaterThan(0);
    for (const ext of t.states()) expect(ext.cwd).toBe(t.root);
    await t.host.send("hello");
    expect(t.methods()).toContain("session/prompt");
  });

  it("stamps the cwd on a fresh start too", async () => {
    const t = await launch();
    for (const ext of t.states()) expect(ext.cwd).toBe(t.root);
  });

  it("fails the start with a static reason when Grok refuses the id", async () => {
    const t = await launch({ options: { resumeSessionId: "unknown-session" }, wait: false });
    await expect(t.run).rejects.toThrow("grok could not resume the session");
    const logs = t.envelopes.filter((e) => e.type === "log");
    expect(JSON.stringify(logs)).toContain("grok could not resume the session");
    expect(JSON.stringify(t.envelopes)).not.toContain("RESUME_ERROR_BODY_MARKER");
    expect(t.methods()).not.toContain("session/new");
  });

  it("fails the start when Grok does not offer session/resume", async () => {
    const t = await launch({ options: { resumeSessionId: "fixture-session" },
      env: { KAOIRO_TEST_GROK_NO_RESUME: "1" }, wait: false });
    await expect(t.run).rejects.toThrow("grok does not support session resume");
    expect(t.methods()).not.toContain("session/resume");
  });

  it("keeps load for the restart after a permission switch", async () => {
    const t = await launch({ options: { resumeSessionId: "fixture-session" } });
    await t.host.setPermission({ revision: 1, requested: { sandbox: "read-only", network_access: false } });
    await t.host.send("hello");
    expect(t.methods().filter((m) => m === "session/resume")).toHaveLength(1);
    expect(t.methods()).toContain("session/load");
  });
});

describe("start selection", () => {
  it("publishes the session's model as default when nothing is requested", async () => {
    const t = await launch({ options: { resumeSessionId: "fixture-session" } });
    expect(t.requests()).toEqual([]);
    expect(t.ext()).toMatchObject({ model: "grok-4.7", model_source: "default", effort: "high", effort_source: "default" });
  });

  it("takes the requested source for a value the session already holds, without a request", async () => {
    const t = await launch({ config: { model: "grok-4.7", model_source: "env", effort: "high", effort_source: "launch" } });
    expect(t.requests()).toEqual([]);
    expect(t.ext()).toMatchObject({ model: "grok-4.7", model_source: "env", effort: "high", effort_source: "launch" });
  });

  it("treats a requested `default` model as no request", async () => {
    const t = await launch({ config: { model: "default", model_source: "launch" } });
    expect(t.requests()).toEqual([]);
    expect(t.ext()).toMatchObject({ model: "grok-4.7", model_source: "default" });
  });

  it("applies a differing model before the first prompt, keeping its relayed source", async () => {
    const t = await launch({ config: { model: "grok-4.6", model_source: "launch" } });
    await vi.waitFor(() => expect(t.ext().model).toBe("grok-4.6"));
    expect(t.requests()).toEqual([["model", "grok-4.6"]]);
    expect(t.ext()).toMatchObject({ model_source: "launch", effort_source: "default" });
    expect(t.ext()).not.toHaveProperty("pending_model");
  });

  it("keeps each axis's source: model env applied, effort launch already held", async () => {
    const t = await launch({ config: { model: "grok-4.6", model_source: "env", effort: "high", effort_source: "launch" } });
    await vi.waitFor(() => expect(t.ext().model).toBe("grok-4.6"));
    expect(t.requests()).toEqual([["model", "grok-4.6"]]);
    expect(t.ext()).toMatchObject({ model_source: "env", effort: "high", effort_source: "launch" });
  });

  it("keeps each axis's source: model launch held, effort config applied", async () => {
    const t = await launch({ config: { model: "grok-4.7", model_source: "launch", effort: "low", effort_source: "config" } });
    await vi.waitFor(() => expect(t.ext().effort).toBe("low"));
    expect(t.requests()).toEqual([["reasoning_effort", "low"]]);
    expect(t.ext()).toMatchObject({ model_source: "launch", effort_source: "config" });
  });

  it("resets an effort the requested model lacks, under unit 4's contract", async () => {
    const t = await launch({ config: { model: "grok-4.5", model_source: "env", effort: "xhigh", effort_source: "launch" },
      env: { KAOIRO_TEST_GROK_EFFORT: "xhigh" } });
    await vi.waitFor(() => expect(t.ext().model).toBe("grok-4.5"));
    await vi.waitFor(() => expect(t.ext().effort).toBe("high"));
    expect(t.ext()).toMatchObject({ model_source: "env", effort_source: "config" });
    expect(t.states().some((ext) => ext.effort_reset === true)).toBe(true);
  });

  it("rejects a model the catalog lacks without a request", async () => {
    const t = await launch({ config: { model: "grok-9", model_source: "launch" } });
    expect(t.requests()).toEqual([]);
    expect(t.states().some((ext) => ext.switch_error?.requested === "grok-9")).toBe(true);
    expect(t.ext().model).toBe("grok-4.7");
  });

  it("reports a model Grok refuses", async () => {
    const t = await launch({ config: { model: "grok-4.6", model_source: "launch" },
      env: { KAOIRO_TEST_GROK_MODEL_FAIL: "1" } });
    await vi.waitFor(() => expect(t.states().some((ext) => ext.switch_error?.kind === "model")).toBe(true));
    expect(t.ext().model).toBe("grok-4.7");
  });

  it("keeps sources across the load after a permission switch", async () => {
    const t = await launch({ config: { model: "grok-4.7", model_source: "env", effort: "high", effort_source: "launch" } });
    await t.host.setPermission({ revision: 1, requested: { sandbox: "read-only", network_access: false } });
    await t.host.send("hello");
    expect(t.methods()).toContain("session/load");
    expect(t.ext()).toMatchObject({ model_source: "env", effort_source: "launch" });
  });

  it("keeps the effort's source on an operator model switch", async () => {
    const t = await launch({ config: { effort: "high", effort_source: "launch" } });
    await t.host.setModel("grok-4.6");
    await vi.waitFor(() => expect(t.ext().model).toBe("grok-4.6"));
    expect(t.ext()).toMatchObject({ model_source: "config", effort_source: "launch" });
  });
});

describe("projection and persistence", () => {
  it("puts the model fields in effective and whoami next to a known permission", async () => {
    const t = await launch({ config: { model: "grok-4.6", model_source: "launch" } });
    await vi.waitFor(() => expect(t.ext().model).toBe("grok-4.6"));
    expect(t.ext().effective).toEqual({ model: "grok-4.6", model_source: "launch", effort: "high",
      effort_source: "default", sandbox: "workspace-write", network_access: true });
    expect(t.host.statusSnapshot()).toMatchObject({ engine: "grok", model: "grok-4.6", model_source: "launch",
      effort: "high", effort_source: "default", network_access: true });
  });

  it("shows the start selection as pending, with no effective model, before Grok's selection is read", () => {
    const host = new GrokHost({
      config: { ...base, model: "grok-4.6", model_source: "launch", effort: "low", effort_source: "env" },
      cwd: homedir(), personaPrompt: "fixture", executable, send: () => {},
      decidePermission: async () => ({ allow: false }),
    });
    const ext = host.statusExtSnapshot() as Record<string, any>;
    expect(ext).toMatchObject({ pending_model: "grok-4.6", pending_effort: "low" });
    expect(ext.effective?.model).toBeUndefined();
  });

  it("publishes no effective at all while nothing is known, so the stored effort survives", () => {
    const host = new GrokHost({ config: { ...base }, cwd: homedir(), personaPrompt: "fixture", executable,
      send: () => {}, decidePermission: async () => ({ allow: false }) });
    const ext = host.statusExtSnapshot() as Record<string, any>;
    expect(ext).not.toHaveProperty("effective");
    const { stored } = persisted([ext], { effort: "low", effort_source: "launch" });
    expect(stored).toEqual({ effort: "low", effort_source: "launch" });
  });

  it("stamps the resume snapshot and its drift", async () => {
    const t = await launch({ options: { resumeSessionId: "fixture-session",
      resumeSnapshot: { model: "grok-4.6", model_source: "default", sandbox: "workspace-write", network_access: true } } });
    expect(t.ext().resume_snapshot).toMatchObject({ model: "grok-4.6" });
    expect(t.ext().resume_drift).toEqual([
      { field: "model", prev: "grok-4.6", now: "grok-4.7" },
      { field: "effort", prev: undefined, now: "high" },
      { field: "effort_source", prev: undefined, now: "default" },
    ]);
  });

  it("leaves an operator switch and a pending start selection out of the drift", async () => {
    const snapshot: ResolvedSnapshotExt = { model: "grok-4.7", model_source: "default", effort: "high",
      effort_source: "default", sandbox: "workspace-write", network_access: true };
    const t = await launch({ options: { resumeSessionId: "fixture-session", resumeSnapshot: snapshot } });
    expect(t.ext().resume_drift).toEqual([]);
    await t.host.setModel("grok-4.6");
    await vi.waitFor(() => expect(t.ext().model).toBe("grok-4.6"));
    expect(t.ext().resume_drift).toEqual([]);
    const pending = new GrokHost({
      config: { ...base, model: "grok-4.6", model_source: "launch" }, cwd: homedir(), personaPrompt: "fixture",
      executable, send: () => {}, decidePermission: async () => ({ allow: false }),
      resumeSnapshot: { ...snapshot, model: "grok-4.6", model_source: "launch" },
    });
    expect((pending.statusExtSnapshot() as Record<string, any>).resume_drift).toEqual([]);
  });

  it("never stores an intermediate pair while the start selection is applied, and resumes it with no drift", async () => {
    const real = AcpSession.prototype.setConfigOption;
    let open!: () => void;
    const held = new Promise<void>((resolve) => { open = resolve; });
    vi.spyOn(AcpSession.prototype, "setConfigOption").mockImplementation(async function (this: AcpSession, id, value) {
      if (id === "model") await held;
      return real.call(this, id, value);
    });
    const start: ResolvedSnapshotExt = { model: "grok-4.6", model_source: "env", effort: "low", effort_source: "launch" };
    const t = await launch({ config: { model: "grok-4.6", model_source: "env", effort: "low", effort_source: "launch" } });
    await vi.waitFor(() => expect(t.ext().pending_model).toBe("grok-4.6"));
    expect(persisted(t.states(), start).history).toEqual([]);
    open();
    await vi.waitFor(() => expect(t.ext().effort).toBe("low"));
    await t.host.renameDisplayName("Renamed", 1);
    const { stored, history } = persisted(t.states(), start);
    for (const entry of history) expect(entry).toMatchObject(start);
    expect(stored).toMatchObject(start);
    vi.restoreAllMocks();
    t.host.close();
    await t.host.closed;
    const again = await launch({ root: t.root, config: { model: stored.model!, model_source: stored.model_source!,
      effort: stored.effort!, effort_source: stored.effort_source! },
    options: { resumeSessionId: "fixture-session", resumeSnapshot: stored } });
    expect(again.requests()).toEqual([]);
    expect(again.ext()).toMatchObject(start);
    expect(again.ext().resume_drift).toEqual([]);
  });
});
