import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RunnerSessions, SessionMeta, SpawnResult } from "@kaoiro/protocol";
import { Supervisor, type ManagedChild } from "../src/supervisor.js";
import { grokSessionExists } from "../src/grok_sessions.js";

// Abort ownership for every supervisor caller that can start a grok probe
// (issue #644). The F4 fence itself is pinned in supervisor.test.ts; here the
// checks are asynchronous, as the grok discovery is.

const CWD = "/home/user/git/kaoiro";
const SESSION = "11111111-2222-3333-4444-555555555555";
const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const base = {
  version: "0",
  persona: { id: "mio", name: "澪", sprite_set: "mio" },
  cwd: CWD,
  engine: "grok",
  server_url: "ws://localhost:4000/wrapper",
  token: "tok",
};

class FakeChild implements ManagedChild {
  readonly #listeners: Array<() => void> = [];
  kills = 0;
  on(_event: "exit", listener: () => void): void {
    this.#listeners.push(listener);
  }
  kill(): boolean {
    this.kills += 1;
    return true;
  }
  exit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

interface Check<T> {
  signal: AbortSignal | undefined;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function harness(options: { sessionExists?: (cwd: string, id: string, engine: string, signal?: AbortSignal) => Promise<boolean> } = {}) {
  const checks: Check<boolean>[] = [];
  const lists: Check<SessionMeta[]>[] = [];
  const children: FakeChild[] = [];
  const resumes: Array<string | undefined> = [];
  const results: SpawnResult[] = [];
  const sessionsSent: RunnerSessions[] = [];
  const sup = new Supervisor({
    hostId: "lab-pc-1",
    cwdAllowlist: [CWD],
    wrapperServerUrl: "ws://localhost:4000/wrapper",
    launch: (_agentId, _config, _cwd, resume) => {
      resumes.push(resume);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    sendResult: (result) => results.push(result),
    sendSessions: (sessions) => sessionsSent.push(sessions),
    sendResetResult: () => {},
    sendStopAgent: () => {},
    sessionExists: options.sessionExists ?? ((_cwd, _id, _engine, signal) =>
      new Promise<boolean>((resolve, reject) => checks.push({ signal, resolve, reject }))),
    listSessions: (_cwd, _engine, signal) =>
      new Promise<SessionMeta[]>((resolve, reject) => lists.push({ signal, resolve, reject })),
  });
  return { sup, checks, lists, children, resumes, results, sessionsSent };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Starts a resumed agent whose existence check has already passed. */
async function running(h: ReturnType<typeof harness>, agentId = "lab-pc-1.grok-a") {
  h.sup.handleSpawn({ ...base, agent_id: agentId, resume_session_id: SESSION });
  h.checks.at(-1)!.resolve(true);
  await flush();
  expect(h.children).toHaveLength(1);
}

describe("grok discovery: one launch per session (F4) with async checks", () => {
  it("launches only one of two resumes whose checks resolve in the same tick", async () => {
    const h = harness();
    h.sup.handleSpawn({ ...base, agent_id: "lab-pc-1.grok-a", resume_session_id: SESSION });
    h.sup.handleSpawn({ ...base, agent_id: "lab-pc-1.grok-b", resume_session_id: SESSION });
    expect(h.checks).toHaveLength(2);
    h.checks[0]!.resolve(true);
    h.checks[1]!.resolve(true);
    await flush();
    expect(h.children).toHaveLength(1);
    expect(h.results.filter((r) => !r.ok)).toEqual([
      expect.objectContaining({ ok: false, reason: "already_running" }),
    ]);
  });
});

describe("grok discovery: abort ownership", () => {
  it("stop during a resume check aborts it and never launches", async () => {
    const h = harness();
    h.sup.handleSpawn({ ...base, agent_id: "lab-pc-1.grok-a", resume_session_id: SESSION });
    h.sup.handleStop({ agent_id: "lab-pc-1.grok-a" });
    expect(h.checks[0]!.signal?.aborted).toBe(true);
    h.checks[0]!.resolve(true);
    await flush();
    expect(h.children).toHaveLength(0);
  });

  it("stopAll during a resume check aborts it and never launches", async () => {
    const h = harness();
    h.sup.handleSpawn({ ...base, agent_id: "lab-pc-1.grok-a", resume_session_id: SESSION });
    h.sup.stopAll();
    expect(h.checks[0]!.signal?.aborted).toBe(true);
    h.checks[0]!.resolve(true);
    await flush();
    expect(h.children).toHaveLength(0);
  });

  it.each([
    ["a newer switch", (h: ReturnType<typeof harness>) =>
      h.sup.handleSwitchSession({ agent_id: "lab-pc-1.grok-a", resume_session_id: SESSION })],
    ["stop", (h: ReturnType<typeof harness>) => h.sup.handleStop({ agent_id: "lab-pc-1.grok-a" })],
    ["restart", (h: ReturnType<typeof harness>) => h.sup.handleRestart({ agent_id: "lab-pc-1.grok-a" })],
    ["stopAll", (h: ReturnType<typeof harness>) => h.sup.stopAll()],
  ])("%s aborts a pending switch_session check", async (_name, act) => {
    const h = harness();
    await running(h);
    h.sup.handleSwitchSession({ agent_id: "lab-pc-1.grok-a", resume_session_id: OTHER });
    const switchCheck = h.checks.at(-1)!;
    act(h);
    expect(switchCheck.signal?.aborted).toBe(true);
    switchCheck.resolve(true);
    await flush();
    expect(h.resumes).not.toContain(OTHER);
  });

  it("a removed agent aborts its pending switch_session check", async () => {
    const h = harness();
    await running(h);
    h.sup.handleSwitchSession({ agent_id: "lab-pc-1.grok-a", resume_session_id: OTHER });
    const switchCheck = h.checks.at(-1)!;
    h.sup.handleStop({ agent_id: "lab-pc-1.grok-a" });
    h.children[0]!.exit();
    expect(switchCheck.signal?.aborted).toBe(true);
  });

  it("a newer enumeration aborts the previous one, which never publishes", async () => {
    const h = harness();
    h.sup.handleEnumerate({ cwd: CWD, engine: "grok" });
    h.sup.handleEnumerate({ cwd: CWD, engine: "grok" });
    expect(h.lists[0]!.signal?.aborted).toBe(true);
    expect(h.lists[1]!.signal?.aborted).toBe(false);
    h.lists[0]!.resolve([{ session_id: "stale" }]);
    h.lists[1]!.resolve([{ session_id: "fresh" }]);
    await flush();
    expect(h.sessionsSent.map((s) => s.sessions)).toEqual([[{ session_id: "fresh" }]]);
  });

  it("stopAll aborts the running enumeration, which never publishes", async () => {
    const h = harness();
    h.sup.handleEnumerate({ cwd: CWD, engine: "grok" });
    h.sup.stopAll();
    expect(h.lists[0]!.signal?.aborted).toBe(true);
    h.lists[0]!.reject(new Error("aborted"));
    await flush();
    expect(h.sessionsSent).toEqual([]);
  });
});

describe("grok discovery: a stopped check kills the real probe", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
  });

  it("stop during a resume check ends the probe's process group", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-grok-stop-"));
    dirs.push(dir);
    const scenario = join(dir, "scenario.json");
    const pids = join(dir, "pids");
    writeFileSync(scenario, JSON.stringify({ hang: true, spawnChild: true, pages: {} }));
    const env = { ...process.env, FAKE_GROK_SCENARIO: scenario, FAKE_GROK_PIDS: pids };
    const fake = fileURLToPath(new URL("./fixtures/fake-grok-acp.mjs", import.meta.url));
    const h = harness({
      sessionExists: (_cwd, id, _engine, signal) =>
        grokSessionExists(dir, id, { executable: fake, env, ...(signal ? { signal } : {}) }),
    });
    h.sup.handleSpawn({ ...base, agent_id: "lab-pc-1.grok-a", resume_session_id: SESSION });
    const deadline = Date.now() + 3_000;
    while (!existsSync(pids) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const [leader, child] = readFileSync(pids, "utf8").trim().split(" ").map(Number);
    h.sup.handleStop({ agent_id: "lab-pc-1.grok-a" });
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const until = Date.now() + 3_000;
    while ((alive(leader!) || alive(child!)) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(alive(leader!)).toBe(false);
    expect(alive(child!)).toBe(false);
    expect(h.children).toHaveLength(0);
  }, 10_000);
});
