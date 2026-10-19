import { permitHostAccess } from "../../../scripts/test/fixtures/test-isolation.mjs";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { PermissionControlExt } from "@kaoiro/protocol";
import { nativeRun, type PermissionDecisionRecord } from "./native-support.js";

permitHostAccess({
  kinds: ["network"],
  optIn: "KAOIRO_LIVE_GROK",
  reason: "live Grok provider run",
});
const live = process.env.KAOIRO_LIVE_GROK === "1";
const config = { agent_id: "native.permission-switch", display_name: "Permission fixture",
  server_url: "ws://127.0.0.1:1/agent", sandbox: "workspace-write" as const, network_access: true,
  persona: { id: "default", name: "Default", sprite_set: "default" } };

it.skipIf(!live)("native switch enforces the new profile and reconnects HTTP tools without changing session", async () => {
  const root = mkdtempSync(join(homedir(), ".kogane591-native-switch-"));
  const reports = mkdtempSync(join(tmpdir(), "kogane591-native-report-"));
  const cwd = join(root, "work"); mkdirSync(cwd);
  const inside = join(cwd, "inside"), outside = join(root, "outside"), report = join(reports, "result.json");
  let connections = 0;
  const decisions: PermissionDecisionRecord[] = [];
  const server = createServer(socket => { connections++; socket.end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const script = join(cwd, "probe.py");
  writeFileSync(script, `import pathlib,socket,json\nr={}\nfor name,path in [('inside',${JSON.stringify(inside)}),('outside',${JSON.stringify(outside)})]:\n try:\n  pathlib.Path(path).write_text('fixture')\n  r[name]=True\n except OSError: r[name]=False\ntry:\n socket.create_connection(('127.0.0.1',${port}),timeout=2).close()\n r['network']=True\nexcept OSError: r['network']=False\npathlib.Path(${JSON.stringify(report)}).write_text(json.dumps(r))\n`);
  try {
    await nativeRun(config, cwd, async (host, callbacks, _envelopes, metadata) => {
      await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 40_000 });
      let session: string | undefined;
      const counts: number[] = [];
      for (const turn of [0, 1, 2]) {
        rmSync(inside, { force: true }); rmSync(outside, { force: true }); rmSync(report, { force: true });
        if (turn > 0) callbacks.onSetPermission?.({ revision: turn,
          requested: { sandbox: turn === 1 ? "read-only" : "workspace-write", network_access: turn !== 1 } });
        const before = connections;
        await host.send(`Use run_terminal_command once to execute python3 ${JSON.stringify(script)}. Then call kaoiro whoami once. Do not retry and do not print tool output.`);
        expect(existsSync(report)).toBe(true);
        const result = JSON.parse(readFileSync(report, "utf8"));
        expect(result.inside === (turn !== 1)).toBe(true);
        expect(result.outside === false).toBe(true);
        expect(result.network === (turn !== 1)).toBe(true);
        expect(existsSync(inside)).toBe(turn !== 1); expect(existsSync(outside)).toBe(false);
        expect(connections > before).toBe(turn !== 1); counts.push(connections - before);
        const control = host.statusExtSnapshot().permission_control as PermissionControlExt;
        expect(control.status).toBe("applied");
        if (control.status !== "applied") throw new Error("missing permission observation");
        expect(typeof control.effective.turn_id === "string").toBe(true);
        session ??= control.effective.session_id;
        expect(control.effective.session_id === session).toBe(true);
        expect(host.toolHostStats()!.calls > 0).toBe(true);
        // Grok sends session_start on session/new and on every session/load
        // (issue 633), and the wrapper publishes it once promoted.
        expect(metadata.filter(m => m.hook_event === "session_start")).toHaveLength(turn + 1);
      }
      const pid = host.processId;
      callbacks.onSetPermission?.({ revision: 3, requested: { sandbox: "danger-full-access", network_access: true } });
      expect((host.statusExtSnapshot().permission_control as PermissionControlExt).status).toBe("failed");
      expect(host.processId).toBe(pid);
      // Every expected call was asked and answered by the test (issue 615).
      expect(decisions.some(d => d.tool === "run_terminal_command" && d.allow)).toBe(true);
      expect(decisions.some(d => d.tool.endsWith("whoami") && d.allow)).toBe(true);
      expect(decisions.filter(d => !d.allow)).toEqual([]);
      console.log(JSON.stringify({ native_switch_turns: 3, listener_connections: counts, session_preserved: true, widening_refused: true }));
    }, undefined, { rule: { marker: script, tools: ["whoami"] }, decisions });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true }); rmSync(reports, { recursive: true, force: true });
  }
}, 360_000);

it.skipIf(!live)("native long tool history records load readiness latency", async () => {
  const root = mkdtempSync(join(homedir(), ".kogane591-native-history-"));
  const counter = join(root, "shell-count");
  const script = join(root, "history-probe.py");
  writeFileSync(script, `from pathlib import Path\nwith Path(${JSON.stringify(counter)}).open('a') as f: f.write('1\\n')\n`);
  let spawnedAt = 0, elapsed = 0, switching = false;
  try {
    await nativeRun(config, root, async (host, callbacks) => {
      await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 40_000 });
      for (let n = 0; n < 30; n++) {
        await host.send(`Run python3 ${JSON.stringify(script)} once with run_terminal_command, then call kaoiro whoami once. Do not print the output.`);
        expect(host.toolHostStats()!.calls >= n + 1).toBe(true);
      }
      expect(readFileSync(counter, "utf8").trim().split("\n").length).toBe(30);
      switching = true;
      callbacks.onSetPermission?.({ revision: 1, requested: { sandbox: "read-only", network_access: false } });
      await host.send("Call kaoiro whoami once. Do not print the output.");
      expect(elapsed > 0).toBe(true);
      console.log(JSON.stringify({ native_history_turns: 30, spawn_to_readiness_ms: elapsed, deadline_review_needed: elapsed > 10_000 }));
    }, undefined, { rule: { marker: script, tools: ["whoami"] } }, { onLaneStep: step => {
      if (!switching) return;
      if (step === "spawn") spawnedAt = performance.now();
      if (step === "promotion") elapsed = Math.round(performance.now() - spawnedAt);
    } });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 1_800_000);
