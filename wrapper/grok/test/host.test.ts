import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PermissionBroker,
  type Envelope,
  type WrapperConfig,
} from "@kaoiro/agent-common";
import { GrokHost, type GrokHostOptions } from "../src/host.js";
import { GrokProcess } from "../src/grok/process.js";
import * as events from "../src/grok/events.js";
const executable = fileURLToPath(
  new URL("./fixtures/grok.mjs", import.meta.url),
);
export const config: WrapperConfig = {
  agent_id: "grok-test",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  display_name: "Grok test",
  server_url: "ws://127.0.0.1:1/agent",
};
const hosts: GrokHost[] = [];
const scratch: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const host of hosts.splice(0)) {
    host.close();
    await host.closed;
  }
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function started(options: Partial<GrokHostOptions> = {}) {
  const envelopes: Envelope[] = [];
  const host = new GrokHost({
    config: { ...config },
    cwd: process.cwd(),
    personaPrompt: "PERSONA_AND_FOOTER",
    send: (e) => envelopes.push(e),
    decidePermission: async () => ({ allow: false }),
    executable,
    ...options,
  });
  hosts.push(host);
  const run = host.run();
  void run.catch(() => {});
  await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
    timeout: 5_000,
  });
  return { host, envelopes, run };
}
describe("resident ACP host", () => {
  it("fails when stdout ends without exiting", async () => {
    const path = mkdtempSync(join(tmpdir(), "kaoiro-grok-eof-"));
    scratch.push(path);
    const pidFile = join(path, "pid");
    const { host, run } = await started({
      env: { ...process.env, KAOIRO_TEST_GROK_PID_FILE: pidFile },
    });
    const pid = host.processId!;
    const turn = host.send("close-output");
    await expect(turn).rejects.toThrow();
    await vi.waitFor(() => expect(host.state).toBe("error"), {
      timeout: 4500,
    });
    await expect(run).rejects.toThrow("connection closed unexpectedly");
    expect(Number(readFileSync(pidFile, "utf8"))).toBe(pid);
    await expect(host.send("next turn")).rejects.toThrow("closed");
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it("keeps large tool updates on the real SDK session", async () => {
    let receivedBytes = 0;
    const original = events.updateEvents;
    vi.spyOn(events, "updateEvents").mockImplementation((notification) => {
      const update = notification.update;
      if (update.sessionUpdate === "tool_call_update") {
        for (const entry of update.content ?? []) {
          if (entry.type === "content" && entry.content.type === "text") {
            if (entry.content.text.startsWith("LARGE_TOOL_BODY_MARKER"))
              receivedBytes = Buffer.byteLength(entry.content.text);
          }
        }
      }
      return original(notification);
    });
    const metadata: unknown[] = [];
    const { host, envelopes } = await started({
      onMetadata: (m) => metadata.push(m),
    });
    await host.send("large-tool");
    expect(receivedBytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(metadata).toContainEqual({ direction: "in", oversized_lines: 1 });
    expect(JSON.stringify(metadata)).not.toContain("LARGE_TOOL_BODY_MARKER");
    await host.send("next turn");
    expect(envelopes.filter((e) => e.type === "result").at(-1)?.payload.text)
      .toBe("next turn");
    expect(host.state).toBe("waiting_input");
  });
  it("sends only trusted static launch rejection messages", async () => {
    const envelopes: Envelope[] = [];
    const host = new GrokHost({
      config: { ...config, network_access: false },
      cwd: process.cwd(), personaPrompt: "", executable,
      send: (e) => envelopes.push(e),
      decidePermission: async () => ({ allow: false }),
    });
    hosts.push(host);
    await expect(host.run()).rejects.toThrow("sandbox/network");
    expect(envelopes.filter((e) => e.type === "log").map((e) => e.payload))
      .toEqual([{ kind: "system", text:
        "unsupported grok sandbox/network pair" }]);
    const ordinaryLogs: Envelope[] = [];
    const ordinary = new GrokHost({
      config, cwd: process.cwd(), personaPrompt: "",
      executable,
      env: { ...process.env, KAOIRO_TEST_GROK_INITIALIZE_FAIL: "1" },
      send: (e) => ordinaryLogs.push(e),
      decidePermission: async () => ({ allow: false }),
    });
    hosts.push(ordinary);
    await expect(ordinary.run()).rejects.toThrow();
    expect(ordinaryLogs.filter((e) => e.type === "log")).toEqual([]);
    expect(JSON.stringify(ordinaryLogs)).not.toContain("LAUNCH_ERROR_BODY");

  });

  it("aborts startup inspect on close", async () => {
    const path = mkdtempSync(join(tmpdir(), "kaoiro-grok-inspect-"));
    scratch.push(path);
    const pidFile = join(path, "pid");
    const host = new GrokHost({
      config,
      cwd: process.cwd(),
      personaPrompt: "",
      send: () => {},
      decidePermission: async () => ({ allow: false }),
      executable,
      env: {
        ...process.env,
        KAOIRO_TEST_GROK_INSPECT_HANG: "1",
        KAOIRO_TEST_GROK_PID_FILE: pidFile,
      },
    });
    hosts.push(host);
    const run = host.run();
    void run.catch(() => {});
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), {
      timeout: 5000,
    });
    const pid = Number(readFileSync(pidFile, "utf8"));
    const start = Date.now();
    host.close();
    await host.closed;
    await run;
    expect(Date.now() - start).toBeLessThan(4500);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });
  it("keeps one session and native rules", async () => {
    const { host, envelopes } = await started();
    await host.send("remember retained");
    await host.send("recall");
    expect(
      envelopes.filter((e) => e.type === "result").at(-1)?.payload.text,
    ).toBe("retained");
    await host.send("rules");
    expect(
      envelopes.filter((e) => e.type === "result").at(-1)?.payload.text,
    ).toBe("PERSONA_AND_FOOTER");
    expect(host.state).toBe("waiting_input");
    expect(
      envelopes.filter((e) => e.type === "result").at(-1)?.ext
        ?.completion_source,
    ).toBe("vendor");
    expect(host.statusExtSnapshot()).toMatchObject({
      engine: "grok",
      permission: {
        sandbox: "workspace-write",
        approval: "on-request",
        enforcement: "os",
      },
      permission_policy: {
        inspect: "ok",
        claude_hooks: { enabled: true, source: "config" },
      },
      delivery_modes: { early: "none", yield: "none" },
    });
    expect(envelopes.some((e) => e.state === "thinking")).toBe(true);
  });
  it("round-trips a tool through the production stdio bridge", async () => {
    const calls: unknown[] = [];
    const { host, envelopes } = await started({
      toolDescriptors: [
        {
          name: "probe",
          description: "Return a probe value",
          inputSchema: { type: "object" },
          handler: async (input) => {
            calls.push(input);
            return { content: [{ type: "text", text: "TOOL_RESULT_MARKER" }] };
          },
        },
      ],
    });
    await host.send("tool");
    expect(calls).toEqual([{ value: 7 }]);
    expect(
      envelopes.filter((e) => e.type === "result").at(-1)?.payload.text,
    ).toContain("TOOL_RESULT_MARKER");
    expect(envelopes.some((e) => e.state === "tool_running")).toBe(true);
  });
  it("omits OS enforcement for the off profile", async () => {
    const { host } = await started({
      config: {
        ...config,
        sandbox: "danger-full-access",
        network_access: true,
      },
    });
    expect(host.statusExtSnapshot().permission).toEqual({
      sandbox: "danger-full-access",
      approval: "on-request",
    });
    expect(host.statusExtSnapshot().permission_policy).toMatchObject({
      grok_sandbox_env: "off",
    });
  });
  it("delivers tool errors to the agent", async () => {
    const { host, envelopes } = await started({
      toolDescriptors: [
        {
          name: "probe",
          description: "Return an error",
          inputSchema: { type: "object" },
          handler: async () => ({
            isError: true,
            content: [{ type: "text", text: "tool failed" }],
          }),
        },
      ],
    });
    await host.send("error-tool");
    expect(
      envelopes.filter((e) => e.type === "result").at(-1)?.payload.text,
    ).toContain('"isError":true');
  });
  it("does not treat pending_interaction alone as a broker wait", async () => {
    const { host, envelopes } = await started();
    await host.send("pending-only");
    expect(envelopes.some((e) => e.state === "waiting_permission")).toBe(false);
  });
  it("keeps running until every parallel tool call has completed", async () => {
    const { host, envelopes } = await started();
    await host.send("parallel");
    expect(
      envelopes.find(
        (e) => e.type === "log" && e.payload.text === "B_STILL_PENDING",
      )?.state,
    ).toBe("tool_running");
    expect(host.state).toBe("waiting_input");
  });
  it("waits for the broker and reports rejection", async () => {
    let host!: GrokHost;
    const envelopes: Envelope[] = [];
    const broker = new PermissionBroker({
      config,
      send: (e) => envelopes.push(e),
      onPendingChange: (pending) => host.setPendingPermission(pending),
    });
    const startedHost = await started({
      send: (e) => envelopes.push(e),
      decidePermission: (...args) => broker.decide(...args),
    });
    host = startedHost.host;
    vi.useFakeTimers();
    const turn = host.send("permission");
    void turn.catch(() => {});
    await vi.waitFor(() => expect(host.state).toBe("waiting_permission"));
    const request = envelopes.find((e) => e.type === "permission_request")!;
    await vi.waitFor(() =>
      expect(
        envelopes.some(
          (e) => e.type === "log" && e.payload.text === "BROKER_WAIT_PROGRESS",
        ),
      ).toBe(true),
    );
    try {
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
      expect(host.state).toBe("waiting_permission");
    } finally {
      vi.useRealTimers();
    }
    broker.resolve({
      request_id: String(request.payload.request_id),
      allow: false,
    });
    await expect(turn).rejects.toThrow("permission rejected");
    expect(envelopes.filter((e) => e.type === "result")).toHaveLength(1);
    expect(
      envelopes.filter((e) => e.type === "result")[0]?.payload.error_code,
    ).toBe("permission_rejected");
    expect(host.state).toBe("waiting_input");
    await host.send("AFTER_REJECT_TEXT");
    expect(
      envelopes.find(
        (e) =>
          e.type === "log" &&
          e.payload.text === "AFTER_REJECT_TEXT" &&
          e.payload.kind === "assistant",
      )?.state,
    ).toBe("thinking");
    broker.close();
  });
  it("drops unknown bodies and keeps diagnostics content-free", async () => {
    const diagnostics: unknown[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation((...args) => {
      diagnostics.push(args);
    });
    const { host, envelopes } = await started({
      onMetadata: (metadata) => diagnostics.push(metadata),
      toolDescriptors: [
        {
          name: "probe",
          description: "Probe",
          inputSchema: { type: "object" },
          handler: async () => ({
            content: [{ type: "text", text: "NORMAL_TOOL_MARKER" }],
          }),
        },
      ],
    });
    await host.send("unknown");
    await host.send("NORMAL_PROMPT_MARKER");
    await host.send("tool");
    expect(JSON.stringify(diagnostics)).not.toContain("UNKNOWN_BODY_MARKER");
    expect(JSON.stringify(envelopes)).not.toContain("UNKNOWN_BODY_MARKER");
    expect(JSON.stringify(diagnostics)).not.toContain("NORMAL_PROMPT_MARKER");
    expect(JSON.stringify(diagnostics)).not.toContain("NORMAL_TOOL_MARKER");
    expect(JSON.stringify(diagnostics)).toContain("future_variant");
    expect(JSON.stringify(diagnostics)).toContain("sdk_diagnostic");
    expect(errors).not.toHaveBeenCalled();
  });
  it("rejects unsupported controls and attachments", async () => {
    const { host } = await started();
    await expect(host.setModel("other")).rejects.toThrow("unsupported");
    await expect(host.setEffort("low")).rejects.toThrow("unsupported");
    await expect(
      host.setPermission({
        revision: 1,
        requested: { sandbox: "read-only", network_access: false },
      }),
    ).rejects.toThrow("fixed");
    await expect(host.setPermissionMode("default")).rejects.toThrow(
      "unsupported",
    );
    await expect(host.send("image", ["attachment"])).rejects.toThrow(
      "unsupported",
    );
    expect(host.state).toBe("waiting_input");
  });
  it("fails clearly when the executable is absent", async () => {
    const host = new GrokHost({
      config,
      cwd: process.cwd(),
      personaPrompt: "",
      send: () => {},
      decidePermission: async () => ({ allow: false }),
      executable: "/nonexistent/kaoiro-grok-fixture",
    });
    hosts.push(host);
    await expect(host.run()).rejects.toThrow("grok");
    expect(host.state).toBe("error");
  });
  it("fails a turn and leaves running when the child exits", async () => {
    const { host, run } = await started();
    await expect(host.send("exit")).rejects.toThrow();
    await expect(run).rejects.toThrow(
      /(?:exited|connection closed) unexpectedly/,
    );
    expect(["thinking", "tool_running"]).not.toContain(host.state);
  });
  it("cancels and closes the owned tool subtree", async () => {
    const path = mkdtempSync(join(tmpdir(), "kaoiro-grok-child-"));
    scratch.push(path);
    const pidFile = join(path, "pid");
    const { host } = await started({
      env: { ...process.env, KAOIRO_TEST_GROK_PID_FILE: pidFile },
    });
    const turn = host.send("sleep");
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    const pid = Number(readFileSync(pidFile, "utf8"));
    await host.interrupt();
    await turn;
    host.close();
    await host.closed;
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it("bounds shutdown of the owned stubborn group", async () => {
    const path = mkdtempSync(join(tmpdir(), "kaoiro-grok-stubborn-"));
    scratch.push(path);
    const pidFile = join(path, "pid");
    const outside = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    try {
      const processHost = new GrokProcess(executable, process.cwd(), {
        ...process.env,
        KAOIRO_TEST_GROK_IGNORE_TERM: "1",
        KAOIRO_TEST_GROK_PID_FILE: pidFile,
      });
      const pid = processHost.child.pid!;
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), {
        timeout: 5_000,
      });
      const child = Number(readFileSync(pidFile, "utf8"));
      const start = Date.now();
      await processHost.close();
      expect(Date.now() - start).toBeLessThan(4_500);
      await vi.waitFor(() => expect(() => process.kill(-pid, 0)).toThrow());
      expect(() => process.kill(child, 0)).toThrow();
      expect(() => process.kill(outside.pid!, 0)).not.toThrow();
    } finally {
      const exited = new Promise((resolve) => outside.once("exit", resolve));
      outside.kill("SIGTERM");
      await exited;
    }
  });
  it("bounds an unanswered bridge call", async () => {
    const { host } = await started({
      toolDescriptors: [
        {
          name: "probe",
          description: "Never answer",
          inputSchema: { type: "object" },
          handler: async () => new Promise(() => {}),
        },
      ],
    });
    vi.useFakeTimers();
    try {
      const turn = host.send("hang-tool");
      void turn.catch(() => {});
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
      await expect(turn).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
    await host.closed;
  });
});
