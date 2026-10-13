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
import { expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { nativeRun } from "./native-support.js";
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
  "native interrupt cancels a long shell tool and removes its child",
  async () => {
    const root = mkdtempSync(join(homedir(), ".kaoiro-grok-cancel-"));
    const pidPath = join(root, "owned-pid");
    try {
      await nativeRun(config, root, async (host, _callbacks, envelopes) => {
        await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
          timeout: 40_000,
        });
        const command =
          `printf '%s' "$$" > ${JSON.stringify(pidPath)}; ` + "exec sleep 120";
        const turn = host.send(
          `Use run_terminal_command exactly: ${command}. ` +
            "Do not run any other command.",
        );
        void turn.catch(() => {});
        await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true), {
          timeout: 120_000,
        });
        const pid = Number(readFileSync(pidPath, "utf8"));
        expect(pid).toBeGreaterThan(1);
        await host.interrupt();
        await turn;
        expect(
          envelopes.filter((e) => e.type === "result").at(-1)?.ext?.stop_reason,
        ).toBe("cancelled");
        await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), {
          timeout: 5000,
        });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  180_000,
);
it.skipIf(!live)(
  "native broker rejection leaves no target file",
  async () => {
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
          await expect(turn).rejects.toThrow("permission rejected");
          expect(envelopes.some((e) => e.type === "permission_request")).toBe(
            true,
          );
          expect(envelopes.some((e) => e.state === "waiting_permission")).toBe(
            true,
          );
          expect(
            envelopes.filter((e) => e.type === "result").at(-1)?.payload
              .error_code,
          ).toBe("permission_rejected");
          expect(host.state).toBe("waiting_input");
          expect(existsSync(target)).toBe(false);
        },
        env,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  180_000,
);
it.skipIf(!live)(
  "native wrapper SIGTERM closes its resident Grok group within runner grace",
  async () => {
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const root = mkdtempSync(join(homedir(), ".kaoiro-grok-sigterm-"));
    const file = join(root, "agent.json");
    const ready = join(root, "ready");
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
      const grokPid = Number(readFileSync(ready, "utf8"));
      expect(grokPid).toBeGreaterThan(1);
      const startedAt = Date.now();
      child.kill("SIGTERM");
      await exited;
      expect(Date.now() - startedAt).toBeLessThan(4_500);
      expect(() => process.kill(-grokPid, 0)).toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);
