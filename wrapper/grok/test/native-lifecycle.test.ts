import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { nativeRun } from "./native-support.js";
import * as grokEvents from "../src/grok/events.js";
import { checkForegroundTool } from "./acceptance.js";
const live = process.env.KAOIRO_LIVE_GROK === "1";
const config: WrapperConfig = {
  agent_id: "native.lifecycle",
  display_name: "Lifecycle fixture",
  server_url: "ws://127.0.0.1:1/agent",
  sandbox: "workspace-write",
  network_access: true,
  persona: { id: "default", name: "Default", sprite_set: "default" },
};
it.skipIf(!live)(
  "native foreground cancel removes the known tool child",
  async () => {
    const root = mkdtempSync(join(homedir(), ".kaoiro-grok-cancel-"));
    const pidPath = join(root, "owned-pid");
    const calls: Record<string, unknown>[] = [];
    const updateEvents = grokEvents.updateEvents;
    const observe = vi
      .spyOn(grokEvents, "updateEvents")
      .mockImplementation((notification) => {
        if (
          notification.update.sessionUpdate === "tool_call" ||
          notification.update.sessionUpdate === "tool_call_update"
        ) {
          calls.push(
            notification.update as unknown as Record<string, unknown>,
          );
        }
        return updateEvents(notification);
      });
    try {
      await nativeRun(config, root, async (
        host, _link, envelopes, metadata,
      ) => {
        await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
          timeout: 40_000,
        });
        const command =
          `printf '%s' "$$" > ${JSON.stringify(pidPath)}; ` + "exec sleep 120";
        const turn = host.send(
          "Call run_terminal_command exactly once with these arguments: " +
            JSON.stringify({ command, block_until_ms: 120_000 }) +
            ". Keep it in the foreground. Do not use other tools.",
        );
        void turn.catch(() => {});
        await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true), {
          timeout: 120_000,
        });
        const pid = Number(readFileSync(pidPath, "utf8"));
        expect(pid).toBeGreaterThan(1);
        const before = readFileSync(`/proc/${pid}/stat`, "utf8");
        expect(before.slice(0, before.lastIndexOf(")") + 1)).toContain(
          "(sleep)",
        );
        const input = calls.map((c) => c.rawInput).find((raw) =>
          raw && typeof raw === "object" &&
          (raw as Record<string, unknown>).command === command,
        );
        checkForegroundTool(input, command);
        expect(() => checkForegroundTool(
          { ...(input as Record<string, unknown>), block_until_ms: 0 },
          command,
        )).toThrow();
        expect(metadata.some((m) => m.method === "_x.ai/task_backgrounded"))
          .toBe(false);
        expect(host.state).toBe("tool_running");
        await host.interrupt();
        await turn;
        expect(
          envelopes.filter((e) => e.type === "result").at(-1)?.ext?.stop_reason,
        ).toBe("cancelled");
        expect(host.state).toBe("waiting_input");
        await delay(5_000);
        expect(() => process.kill(pid, 0)).toThrow();
        expect(existsSync(`/proc/${pid}/stat`)).toBe(false);
        const startedAt = Date.now();
        host.close();
        await host.closed;
        expect(Date.now() - startedAt).toBeLessThan(4_500);
        if (process.env.KAOIRO_LIVE_GROK_LIFECYCLE_REPORT) {
          writeFileSync(
            process.env.KAOIRO_LIVE_GROK_LIFECYCLE_REPORT,
            JSON.stringify({
              pid,
              grok_pid: host.processId,
              calls,
              before,
              after_cancel: null,
              after_close: null,
              shutdown_ms: Date.now() - startedAt,
            }),
          );
        }
      });
    } finally {
      observe.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  },
  180_000,
);
it.skipIf(!live).each([false, true])(
  "native broker allow=%s controls the target file",
  async allow => {
    const root = mkdtempSync(join(homedir(), ".kaoiro-grok-permission-"));
    const fixtureHome = join(root, "home");
    const cwd = join(root, "work");
    mkdirSync(fixtureHome);
    mkdirSync(cwd);
    const target = join(cwd, "permission-output");
    const env = {
      ...process.env,
      HOME: fixtureHome,
      GROK_HOME: process.env.GROK_HOME ?? join(homedir(), ".grok"),
    };
    try {
      await nativeRun(
        { ...config, sandbox: "danger-full-access", network_access: true },
        cwd,
        async (host, _callbacks, envelopes) => {
          await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
            timeout: 40_000,
          });
          const turn = host.send(
            "Use run_terminal_command once to run exactly: " +
              `dd if=/dev/zero of=${JSON.stringify(target)} bs=1 count=1. ` +
              "Do not retry after rejection.",
          );
          void turn.catch(() => {});
          if (allow) await turn;
          else await expect(turn).rejects.toThrow("permission rejected");
          expect(envelopes.some((e) => e.type === "permission_request")).toBe(
            true,
          );
          expect(envelopes.some((e) => e.state === "waiting_permission")).toBe(
            true,
          );
          expect(
            envelopes.filter((e) => e.type === "result").at(-1)?.payload
              .error_code,
          ).toBe(allow ? undefined : "permission_rejected");
          expect(host.state).toBe("waiting_input");
          expect(existsSync(target)).toBe(allow);
        },
        env,
        () => allow,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  180_000,
);
it.skipIf(!live)(
  "native wrapper SIGTERM removes Grok and its active tool child",
  async () => {
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const root = mkdtempSync(join(homedir(), ".kaoiro-grok-sigterm-"));
    const file = join(root, "agent.json");
    const ready = join(root, "ready");
    const toolPidFile = join(root, "tool-pid");
    const driver = join(root, "driver.mjs");
    writeFileSync(file, JSON.stringify(config));
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    writeFileSync(
      driver,
      `import { runGrokCli } from ${JSON.stringify(cli)};
import { writeFileSync } from 'node:fs';
process.argv = [process.argv[0], process.argv[1], ${JSON.stringify(file)}];
await runGrokCli({
 createServerLink: (_url, _id, options) => {
  queueMicrotask(() => options.onPersonaPrompt('Be concise.'));
  return { send() {}, setSessionId() {},
   noticeAttributionMode() { return 'legacy'; },
   deliveryIncarnation() { return null; },
   deliveryGeneration() { return null; },
   async reportDisconnectIntent() {}, close() {} };
 },
 onHostCreated: host => {
  const timer = setInterval(() => { if (host.state === 'waiting_input') {
   clearInterval(timer);
   writeFileSync(${JSON.stringify(ready)}, String(host.processId));
   void host.send(${JSON.stringify(
     "Use run_terminal_command exactly: " +
       `printf '%s' "$$" > ${JSON.stringify(toolPidFile)}; exec sleep 120. ` +
       "Do not run any other command.",
   )}).catch(() => {});
  } }, 25);
 }
});
`,
    );
    const child = spawn(process.execPath, [driver], {
      cwd: root,
      stdio: "ignore",
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), {
        timeout: 40_000,
      });
      await vi.waitFor(() => expect(existsSync(toolPidFile)).toBe(true), {
        timeout: 120_000,
      });
      const toolPid = Number(readFileSync(toolPidFile, "utf8"));
      expect(toolPid).toBeGreaterThan(1);
      expect(readFileSync(`/proc/${toolPid}/stat`, "utf8").split(" ")[1]).toBe(
        "(sleep)",
      );
      const grokPid = Number(readFileSync(ready, "utf8"));
      expect(grokPid).toBeGreaterThan(1);
      const startedAt = Date.now();
      child.kill("SIGTERM");
      await exited;
      expect(Date.now() - startedAt).toBeLessThan(4_500);
      await vi.waitFor(() => {
        expect(() => process.kill(-grokPid, 0)).toThrow();
        expect(() => process.kill(toolPid, 0)).toThrow();
      });
      expect(Date.now() - startedAt).toBeLessThan(4_500);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  180_000,
);
