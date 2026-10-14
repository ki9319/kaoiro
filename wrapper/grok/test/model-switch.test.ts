import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { GrokHost, type GrokHostOptions } from "../src/host.js";

const executable = fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url));
const config: WrapperConfig = {
  agent_id: "switch-593", display_name: "Switch", server_url: "ws://127.0.0.1:1/agent",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  sandbox: "workspace-write", network_access: true,
};
const hosts: GrokHost[] = [];
const scratch: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) { host.close(); await host.closed; }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function started(env: Record<string, string> = {}, extra: Partial<GrokHostOptions> = {}) {
  const root = mkdtempSync(join(homedir(), ".kaoiro-grok-593-"));
  scratch.push(root);
  const events = join(root, "events.jsonl");
  const releaseFile = join(root, "release");
  const sessionFile = join(root, "session.json");
  const envelopes: Envelope[] = [];
  const host = new GrokHost({
    config: { ...config }, cwd: root, personaPrompt: "fixture", executable,
    permissionSyncSupported: true, permissionGateTimeoutMs: 150,
    env: { ...process.env, KAOIRO_TEST_GROK_EVENTS: events, KAOIRO_TEST_GROK_RELEASE_FILE: releaseFile,
      KAOIRO_TEST_GROK_SESSION_FILE: sessionFile, ...env },
    send: (e) => envelopes.push(e), decidePermission: async () => ({ allow: false }), ...extra,
  });
  hosts.push(host);
  const run = host.run();
  void run.catch(() => {});
  await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 5000 });
  const rows = () => existsSync(events)
    ? readFileSync(events, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return {
    host, run, envelopes, rows, root, sessionFile,
    requests: () => rows().filter((r) => r.event === "session/set_config_option")
      .map((r) => [r.configId, r.value]),
    modelCalls: () => rows().filter((r) => r.event === "model_call").map((r) => r.model),
    release: () => writeFileSync(releaseFile, ""),
    hold: () => rmSync(releaseFile, { force: true }),
    states: () => envelopes.filter((e) => e.type === "state_change"),
    ext: () => host.statusExtSnapshot() as Record<string, any>,
  };
}
type Started = Awaited<ReturnType<typeof started>>;
const firstCall = (t: Started) => vi.waitFor(() => expect(t.modelCalls()).toHaveLength(1), { timeout: 5000 });
const modelIs = (t: Started, model: string) =>
  vi.waitFor(() => expect(t.ext().model).toBe(model), { timeout: 5000 });
const choose = (revision: number) => ({ revision, requested: { sandbox: "read-only" as const, network_access: false } });

describe("catalog and capabilities", () => {
  it("publishes the models and the selection Grok reports, and advertises the switches", async () => {
    const t = await started();
    expect(t.ext().models).toEqual([
      { value: "grok-4.7", display_name: "Grok 4.7", effort_levels: ["xhigh", "high", "medium", "low"], default_effort: "high" },
      { value: "grok-4.7-build-fast", display_name: "Grok 4.7 Fast", effort_levels: ["xhigh", "high", "medium", "low"], default_effort: "high" },
      { value: "grok-4.6", display_name: "Grok 4.6", effort_levels: ["xhigh", "high", "medium", "low"], default_effort: "high" },
      { value: "grok-4.5", display_name: "Grok 4.5", effort_levels: ["high", "medium", "low"], default_effort: "high" },
    ]);
    expect(t.ext()).toMatchObject({ model: "grok-4.7", model_source: "default", effort: "high", effort_source: "default" });
    expect(t.ext().session_capabilities).toMatchObject({
      supports_model_switch: true, supports_effort_switch: true, supports_context_usage: true,
    });
    expect(t.states()[0]!.ext).toMatchObject({ model: "grok-4.7", session_capabilities: { supports_model_switch: true } });
  });

  it("stays fail closed when Grok lists no configuration options", async () => {
    const t = await started({ KAOIRO_TEST_GROK_CONFIG: "none" });
    expect(t.ext()).toMatchObject({ model: "default", model_source: "default",
      models: [{ value: "default", display_name: "Account default" }] });
    expect(t.ext().session_capabilities).toMatchObject({
      supports_model_switch: false, supports_effort_switch: false, supports_context_usage: false,
    });
    await expect(t.host.setModel("grok-4.6")).rejects.toThrow("unsupported");
    await expect(t.host.setEffort("low")).rejects.toThrow("unsupported");
  });
});

describe("switch timing", () => {
  it("sends a switch asked while idle at once", async () => {
    const t = await started();
    await t.host.setModel("grok-4.6");
    await modelIs(t, "grok-4.6");
    expect(t.requests()).toEqual([["model", "grok-4.6"]]);
    expect(t.ext()).toMatchObject({ model: "grok-4.6", model_source: "config" });
    expect(t.ext()).not.toHaveProperty("pending_model");
    const last = t.states().at(-1)!;
    expect(last.ext).toMatchObject({ model: "grok-4.6", model_source: "config" });
    expect(last.ext).not.toHaveProperty("pending_model");
  });

  it("holds a switch asked mid-turn until the turn ends", async () => {
    const t = await started();
    const turn = t.host.send("calls-2");
    await firstCall(t);
    await t.host.setModel("grok-4.6");
    expect(t.ext().pending_model).toBe("grok-4.6");
    expect(t.requests()).toEqual([]);
    t.release();
    await turn;
    await modelIs(t, "grok-4.6");
    expect(t.modelCalls()).toEqual(["grok-4.7", "grok-4.7"]);
    expect(t.requests()).toEqual([["model", "grok-4.6"]]);
    expect(t.ext()).not.toHaveProperty("pending_model");
  });

  it("sends once, before the next turn's prompt, when a turn is queued", async () => {
    const t = await started();
    const first = t.host.send("calls-2");
    const second = t.host.send("chunks");
    await firstCall(t);
    await t.host.setModel("grok-4.6");
    t.release();
    await Promise.all([first, second]);
    expect(t.requests()).toEqual([["model", "grok-4.6"]]);
    const rows = t.rows();
    const sent = rows.findIndex((r) => r.event === "session/set_config_option");
    const prompts = rows.map((r, i) => (r.event === "session/prompt" ? i : -1)).filter((i) => i >= 0);
    expect(prompts).toHaveLength(2);
    expect(sent).toBeGreaterThan(prompts[0]!);
    expect(sent).toBeLessThan(prompts[1]!);
    expect(t.modelCalls()).toEqual(["grok-4.7", "grok-4.7", "grok-4.6"]);
  });

  it("applies a switch recorded while a lane is loading on the new generation, before the prompt", async () => {
    let armed = false;
    let step: string | undefined;
    let open!: () => void;
    const held = new Promise<void>((resolve) => { open = resolve; });
    const t = await started({}, {
      onLaneStep: async (value) => {
        if (!armed) return;
        step = value;
        if (value === "load") await held;
      },
    });
    const before = t.host.processId!;
    await t.host.setPermission(choose(1));
    armed = true;
    const turn = t.host.send("chunks");
    await vi.waitFor(() => expect(step).toBe("load"));
    await t.host.setModel("grok-4.6");
    expect(t.requests()).toEqual([]);
    open();
    await turn;
    const rows = t.rows();
    const sent = rows.findIndex((r) => r.event === "session/set_config_option");
    expect(sent).toBeGreaterThan(-1);
    expect(rows[sent]!.pid).not.toBe(before);
    expect(rows.filter((r) => r.event === "session/set_config_option")).toHaveLength(1);
    const lastPrompt = rows.map((r, i) => (r.event === "session/prompt" ? i : -1)).filter((i) => i >= 0).at(-1)!;
    expect(sent).toBeLessThan(lastPrompt);
    expect(t.modelCalls().at(-1)).toBe("grok-4.6");
    expect(t.ext().model).toBe("grok-4.6");
  });
});

describe("switch outcomes", () => {
  it("reports a rejected model request and keeps the model", async () => {
    const t = await started({ KAOIRO_TEST_GROK_MODEL_FAIL: "1" });
    await t.host.setModel("grok-4.6");
    await vi.waitFor(() => expect(t.states().some((e) => e.ext?.switch_error)).toBe(true));
    expect(t.states().find((e) => e.ext?.switch_error)!.ext!.switch_error).toEqual({
      kind: "model", requested: "grok-4.6", reason: "control_rejected", rolled_back_to: "grok-4.7",
    });
    expect(t.ext()).toMatchObject({ model: "grok-4.7", model_source: "default" });
    expect(t.ext()).not.toHaveProperty("pending_model");
    expect(t.ext()).not.toHaveProperty("switch_error");
    expect(t.requests()).toEqual([["model", "grok-4.6"]]);
  });

  it("rejects a value outside the catalog without sending anything", async () => {
    const t = await started();
    await t.host.setModel("not-a-model");
    await t.host.setEffort("not-a-level");
    const errors = t.states().flatMap((e) => (e.ext?.switch_error ? [e.ext.switch_error] : []));
    expect(errors).toEqual([
      { kind: "model", requested: "not-a-model", reason: "control_rejected", rolled_back_to: "grok-4.7" },
      { kind: "effort", requested: "not-a-level", reason: "control_rejected", rolled_back_to: "high" },
    ]);
    expect(t.requests()).toEqual([]);
  });

  it("checks an effort against the model that is pending, not the one that is running", async () => {
    const t = await started();
    const turn = t.host.send("calls-2");
    await firstCall(t);
    await t.host.setModel("grok-4.5");
    await t.host.setEffort("xhigh");
    expect(t.states().filter((e) => e.ext?.switch_error).map((e) => e.ext!.switch_error)).toEqual([
      { kind: "effort", requested: "xhigh", reason: "control_rejected", rolled_back_to: "high" },
    ]);
    expect(t.ext()).not.toHaveProperty("pending_effort");
    t.release();
    await turn;
    await modelIs(t, "grok-4.5");
    expect(t.requests()).toEqual([["model", "grok-4.5"]]);
  });

  it("publishes a repeated identical error again", async () => {
    const t = await started();
    await t.host.setModel("not-a-model");
    await t.host.setModel("not-a-model");
    expect(t.states().filter((e) => e.ext?.switch_error)).toHaveLength(2);
  });

  it("switches the effort alone and keeps the context reading", async () => {
    const t = await started();
    await t.host.send("calls-1");
    await t.host.setEffort("low");
    await vi.waitFor(() => expect(t.ext().effort).toBe("low"));
    expect(t.requests()).toEqual([["reasoning_effort", "low"]]);
    expect(t.ext()).toMatchObject({ effort_source: "config", model_source: "default" });
    expect(t.ext().context).toMatchObject({ used_tokens: 1110 });
  });

  it("sets the default effort when the new model lacks the current one, and says so once", async () => {
    const t = await started({ KAOIRO_TEST_GROK_EFFORT: "xhigh" });
    await t.host.setModel("grok-4.5");
    await vi.waitFor(() => expect(t.ext().effort).toBe("high"));
    expect(t.requests()).toEqual([["model", "grok-4.5"], ["reasoning_effort", "high"]]);
    expect(t.ext()).toMatchObject({ model: "grok-4.5", effort: "high", effort_source: "config" });
    expect(t.states().filter((e) => e.ext?.effort_reset === true)).toHaveLength(1);
    expect(t.ext()).not.toHaveProperty("effort_reset");
    await t.host.send("chunks");
    expect(t.states().filter((e) => e.ext?.effort_reset === true)).toHaveLength(1);
  });

  it("decides the reset from the final model: a second pick that lists the effort cancels it", async () => {
    const t = await started({ KAOIRO_TEST_GROK_EFFORT: "xhigh" });
    const turn = t.host.send("calls-2");
    await firstCall(t);
    await t.host.setModel("grok-4.5");
    await t.host.setModel("grok-4.6");
    t.release();
    await turn;
    await modelIs(t, "grok-4.6");
    expect(t.requests()).toEqual([["model", "grok-4.6"]]);
    expect(t.ext().effort).toBe("xhigh");
    expect(t.states().some((e) => e.ext?.effort_reset)).toBe(false);
  });

  it("resets the effort when the final pick lacks it, whatever the order of the picks", async () => {
    const t = await started({ KAOIRO_TEST_GROK_EFFORT: "xhigh" });
    const turn = t.host.send("calls-2");
    await firstCall(t);
    await t.host.setModel("grok-4.6");
    await t.host.setModel("grok-4.5");
    t.release();
    await turn;
    await vi.waitFor(() => expect(t.ext().effort).toBe("high"));
    expect(t.requests()).toEqual([["model", "grok-4.5"], ["reasoning_effort", "high"]]);
    expect(t.states().filter((e) => e.ext?.effort_reset === true)).toHaveLength(1);
  });

  it("keeps a model switch whose effort reset fails and reports the stale effort", async () => {
    const t = await started({ KAOIRO_TEST_GROK_EFFORT: "xhigh", KAOIRO_TEST_GROK_EFFORT_FAIL: "1" });
    await t.host.setModel("grok-4.5");
    await vi.waitFor(() => expect(t.states().some((e) => e.ext?.switch_error)).toBe(true));
    expect(t.states().find((e) => e.ext?.switch_error)!.ext!.switch_error).toEqual({
      kind: "effort", requested: "high", reason: "effort_reset_failed", rolled_back_to: "xhigh",
    });
    expect(t.ext()).toMatchObject({ model: "grok-4.5", model_source: "config", effort: "xhigh", effort_source: "default" });
    expect(t.states().some((e) => e.ext?.effort_reset)).toBe(false);
    expect(t.requests()).toEqual([["model", "grok-4.5"], ["reasoning_effort", "high"]]);
  });

  it("fails the host when a configuration request never answers", async () => {
    const t = await started({ KAOIRO_TEST_GROK_SET_HANG: "1" }, { switchTimeoutMs: 100 });
    await t.host.setModel("grok-4.6");
    await expect(t.run).rejects.toThrow("timed out");
  });

  it("logs a Grok report that disagrees with the last returned value and keeps the returned one", async () => {
    const t = await started();
    const written = vi.spyOn(process.stderr, "write");
    await t.host.send("rogue-model-changed");
    expect(written.mock.calls.map(([chunk]) => String(chunk)).join(""))
      .toContain("other than the one it last returned");
    expect(t.ext()).toMatchObject({ model: "grok-4.7", effort: "high" });
  });
});

describe("confirmations", () => {
  it("logs a config_option_update that disagrees with the last returned value", async () => {
    const t = await started();
    const written = vi.spyOn(process.stderr, "write");
    await t.host.send("rogue-config-update");
    expect(written.mock.calls.map(([chunk]) => String(chunk)).join(""))
      .toContain("other than the one it last returned");
    expect(t.ext()).toMatchObject({ model: "grok-4.7" });
  });

  it("does not report the notifications of its own request, even ahead of the answer", async () => {
    const t = await started({ KAOIRO_TEST_GROK_NOTIFY_FIRST: "1" });
    const written = vi.spyOn(process.stderr, "write");
    await t.host.setModel("grok-4.6");
    await modelIs(t, "grok-4.6");
    expect(written.mock.calls.map(([chunk]) => String(chunk)).join("")).not.toContain("other than the one");
  });
});

describe("generations", () => {
  it("adopts the selection a loaded session reports and does not send it again", async () => {
    const t = await started();
    await t.host.setModel("grok-4.6");
    await modelIs(t, "grok-4.6");
    writeFileSync(t.sessionFile, JSON.stringify({ model: "grok-4.5", effort: "high" }));
    await t.host.setPermission(choose(1));
    await t.host.send("chunks");
    expect(t.ext()).toMatchObject({ model: "grok-4.5", effort: "high" });
    expect(t.requests()).toEqual([["model", "grok-4.6"]]);
    expect(t.rows().filter((r) => r.event === "session/load")).toHaveLength(1);
  });
});

describe("context usage", () => {
  it("reads the last model call of the turn, not the first and not the sum", async () => {
    const t = await started();
    t.release();
    await t.host.send("calls-2");
    expect(t.ext().context).toEqual({ used_tokens: 2220, max_tokens: 200_000, used_percentage: (100 * 2220) / 200_000 });
    expect(t.states().at(-1)!.ext!.context).toEqual(t.ext().context);
  });

  it("shows no reading before a turn has finished", async () => {
    const t = await started();
    expect(t.ext()).not.toHaveProperty("context");
  });

  it("withdraws the reading on a model switch until a turn finishes on the new model", async () => {
    const t = await started();
    t.release();
    await t.host.send("calls-2");
    expect(t.ext().context).toMatchObject({ used_tokens: 2220, max_tokens: 200_000 });
    await t.host.setModel("grok-4.6");
    await modelIs(t, "grok-4.6");
    expect(t.ext()).not.toHaveProperty("context");
    expect(t.states().at(-1)!.ext).not.toHaveProperty("context");
    await t.host.send("calls-1");
    expect(t.ext().context).toMatchObject({ used_tokens: 1110, max_tokens: 150_000 });
    await t.host.setModel("grok-4.7");
    await modelIs(t, "grok-4.7");
    expect(t.ext()).not.toHaveProperty("context");
    await t.host.send("no-calls");
    expect(t.ext()).not.toHaveProperty("context");
    await t.host.send("calls-3");
    expect(t.ext().context).toMatchObject({ used_tokens: 3330, max_tokens: 200_000 });
  });

  it("keeps the last reading through a turn that made no model call", async () => {
    const t = await started();
    t.release();
    await t.host.send("calls-3");
    await t.host.send("no-calls");
    expect(t.ext().context).toMatchObject({ used_tokens: 3330 });
  });

  it("publishes the reading of a cancelled turn that made a call", async () => {
    const t = await started();
    t.release();
    await t.host.send("calls-3");
    t.hold();
    const turn = t.host.send("calls-2");
    await vi.waitFor(() => expect(t.modelCalls()).toHaveLength(4));
    await t.host.interrupt();
    await turn;
    expect(t.ext().context).toMatchObject({ used_tokens: 1110 });
  });

  it("withdraws the reading of a turn that ran on a model other than the selected one", async () => {
    const t = await started({ KAOIRO_TEST_GROK_REPORT_MODEL: "grok-4.5" });
    const written = vi.spyOn(process.stderr, "write");
    await t.host.send("calls-1");
    expect(t.ext()).not.toHaveProperty("context");
    expect(written.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("context reading is withdrawn");
  });

  it("puts the reading in whoami next to the effort", async () => {
    const t = await started();
    await t.host.send("calls-1");
    expect(t.host.statusSnapshot()).toMatchObject({
      engine: "grok", model: "grok-4.7", model_source: "default", effort: "high", effort_source: "default",
      context: { used_tokens: 1110, max_tokens: 200_000 },
    });
  });
});
