import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { GrokHost } from "../src/host.js";
import { GrokRateLimitReader, type GrokRateLimitRead } from "../src/grok/rate_limits.js";

const config: WrapperConfig = {
  agent_id: "rates.grok",
  display_name: "Rate fixture",
  server_url: "ws://127.0.0.1:1/agent",
  persona: { id: "default", name: "Default", sprite_set: "default" },
};
const executable = fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url));
const hosts: GrokHost[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    host.close();
    await host.closed;
  }
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function start(prompt?: string, mode = "valid", configOverride: Partial<WrapperConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kaoiro-momo660-grok-rates-"));
  scratch.push(dir);
  const events = join(dir, "events.jsonl");
  const envelopes: Envelope[] = [];
  const host = new GrokHost({
    config: { ...config, ...configOverride }, cwd: dir, personaPrompt: "fixture", send: (envelope) => envelopes.push(envelope),
    decidePermission: async () => ({ allow: false }), executable,
    env: { ...process.env, KAOIRO_TEST_GROK_EVENTS: events, KAOIRO_TEST_GROK_BILLING: mode },
  });
  hosts.push(host);
  const run = host.run(prompt);
  void run.catch(() => {});
  await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 5_000 });
  return { host, envelopes, events };
}

function eventRows(path: string): { event: string }[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function observeReadResults(): Promise<GrokRateLimitRead>[] {
  const results: Promise<GrokRateLimitRead>[] = [];
  const read = GrokRateLimitReader.prototype.read;
  vi.spyOn(GrokRateLimitReader.prototype, "read").mockImplementation(function (this: GrokRateLimitReader) {
    const result = read.call(this);
    results.push(result);
    return result;
  });
  return results;
}

it("publishes one allowlisted snapshot on idle startup and shares it with whoami", async () => {
  const { host, envelopes, events } = await start();
  await vi.waitFor(() => expect(host.statusSnapshot()).toHaveProperty("rate_limits.seven_day"));
  const reading = host.statusSnapshot().rate_limits;
  const state = envelopes.filter((envelope) => envelope.type === "state_change" &&
    envelope.ext?.rate_limits).at(-1);
  expect(state?.ext.rate_limits).toEqual(reading);
  expect(reading).toEqual({ seven_day: { utilization: 0.125, resets_at: 4_102_358_400 } });
  expect(JSON.stringify(envelopes)).not.toContain("PRIVATE_BILLING_FIELD");
  expect(JSON.stringify(envelopes)).not.toContain("amount");
  expect(eventRows(events).filter(({ event }) => event === "_x.ai/billing")).toHaveLength(1);

  await host.send("chunks");
  expect(eventRows(events).filter(({ event }) => event === "_x.ai/billing")).toHaveLength(1);
  expect(host.statusSnapshot().rate_limits).toEqual(reading);
});

it("skips the startup request for an initial prompt and reads after turn finalization", async () => {
  const { host, events } = await start("chunks");
  await vi.waitFor(() => expect(eventRows(events).some(({ event }) => event === "_x.ai/billing")).toBe(true));
  const rows = eventRows(events).map(({ event }) => event);
  expect(rows.filter((event) => event === "_x.ai/billing")).toHaveLength(1);
  expect(rows.indexOf("session/prompt")).toBeLessThan(rows.indexOf("_x.ai/billing"));
  await vi.waitFor(() => expect(host.statusSnapshot()).toHaveProperty("rate_limits.seven_day"));
});

it("omits unsupported and malformed readings without affecting host readiness", async () => {
  const unsupported = await start(undefined, "unsupported");
  expect(unsupported.host.state).toBe("waiting_input");
  await vi.waitFor(() => expect(eventRows(unsupported.events)
    .some(({ event }) => event === "_x.ai/billing")).toBe(true));
  expect(unsupported.host.statusExtSnapshot()).not.toHaveProperty("rate_limits");

  const malformed = await start(undefined, "malformed");
  expect(malformed.host.state).toBe("waiting_input");
  await vi.waitFor(() => expect(eventRows(malformed.events)
    .some(({ event }) => event === "_x.ai/billing")).toBe(true));
  expect(malformed.host.statusExtSnapshot()).not.toHaveProperty("rate_limits");
});

it.each([
  { outcome: "auth", kind: "auth_failed" },
  { outcome: "transport", kind: "transport_error" },
  { outcome: "hang", kind: "timeout" },
].flatMap(scenario => [false, true].map(expired => ({ ...scenario, expired }))))(
  "retains the stored window after $outcome (expired=$expired)", async ({ outcome, kind, expired }) => {
    const reads = observeReadResults();
    const realNow = Date.now;
    let elapsed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + elapsed);
    const { host, envelopes, events } = await start(undefined, `${expired ? "expired" : "valid"}-then-${outcome}`);
    await vi.waitFor(() => expect(host.statusSnapshot()).toHaveProperty("rate_limits.seven_day"));
    const stored = host.statusSnapshot().rate_limits;
    expect(stored).toEqual({ seven_day: {
      utilization: 0.125, resets_at: expired ? 1_577_836_800 : 4_102_358_400,
    } });

    const before = envelopes.length;
    elapsed = 60_001;
    await host.send("chunks");
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    await expect(reads[1]).resolves.toEqual({ kind });
    expect(eventRows(events).filter(({ event }) => event === "_x.ai/billing")).toHaveLength(2);
    expect(host.state).toBe("waiting_input");
    expect(host.statusSnapshot().rate_limits).toEqual(stored);
    expect(host.statusExtSnapshot().rate_limits).toEqual(stored);
    const states = envelopes.slice(before).filter(envelope => envelope.type === "state_change");
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) expect(state.ext.rate_limits).toEqual(stored);
  }, 30_000,
);

it.each([
  { outcome: "malformed", kind: "invalid_shape" },
  { outcome: "unsupported", kind: "unsupported" },
])("withdraws the stored window once after $outcome", async ({ outcome, kind }) => {
  const reads = observeReadResults();
  const realNow = Date.now;
  let elapsed = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + elapsed);
  const { host, envelopes, events } = await start(undefined, `valid-then-${outcome}`);
  await vi.waitFor(() => expect(host.statusSnapshot()).toHaveProperty("rate_limits.seven_day"));
  const before = envelopes.length;
  elapsed = 60_001;
  await host.send("chunks");
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  await expect(reads[1]).resolves.toEqual({ kind });

  expect(eventRows(events).filter(({ event }) => event === "_x.ai/billing")).toHaveLength(2);
  expect(host.state).toBe("waiting_input");
  expect(host.statusSnapshot()).not.toHaveProperty("rate_limits");
  expect(host.statusExtSnapshot()).not.toHaveProperty("rate_limits");
  const withdrawals = envelopes.slice(before).filter(envelope =>
    envelope.type === "state_change" && envelope.ext.rate_limits === undefined);
  expect(withdrawals).toHaveLength(1);
  expect(withdrawals[0]?.state).toBe("waiting_input");
  expect(envelopes.at(-1)?.ext).not.toHaveProperty("rate_limits");
});

it("does not let a retired generation overwrite its successor's snapshot", async () => {
  let resolveOld!: (value: GrokRateLimitRead) => void;
  let reads = 0;
  const current: GrokRateLimitRead = { kind: "reading", value: {
    seven_day: { utilization: 0.2, resets_at: 4_102_358_400 },
  } };
  vi.spyOn(GrokRateLimitReader.prototype, "read").mockImplementation(() => {
    reads += 1;
    if (reads === 1) return new Promise((resolve) => { resolveOld = resolve; });
    return Promise.resolve(current);
  });
  const { host } = await start(undefined, "valid", { sandbox: "danger-full-access", network_access: true });
  await vi.waitFor(() => expect(reads).toBe(1));
  host.setPermissionSyncSupported(true);
  await host.setPermission({ revision: 1, requested: { sandbox: "workspace-write", network_access: true } });
  await host.send("chunks");
  await vi.waitFor(() => expect(host.statusSnapshot().rate_limits).toEqual(current.value));
  resolveOld({ kind: "reading", value: { seven_day: { utilization: 0.9, resets_at: 4_102_358_400 } } });
  await Promise.resolve();
  await Promise.resolve();
  expect(host.statusSnapshot().rate_limits).toEqual(current.value);
});
