import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runGrokProbe } from "../src/grok_acp_probe.js";
import { grokSessionExists, listGrokSessions } from "../src/grok_sessions.js";

// Discovery against the real grok (issue #644): Grok's session/list binds a
// session to the exact cwd string the runner uses. KAOIRO_LIVE_GROK=1 only;
// session/new makes no model call.

const live = process.env.KAOIRO_LIVE_GROK === "1";

function removeGrokState(cwd: string): void {
  const home = process.env.GROK_HOME ?? join(homedir(), ".grok");
  rmSync(join(home, "sessions", encodeURIComponent(cwd)), { recursive: true, force: true });
  const workspaces = join(home, "memory-v2", "workspaces");
  // Grok names a workspace after the cwd basename without its leading dots,
  // lowercased, plus `-<8 hex>` (measured on 1.0.52). Only a scratch cwd made
  // by mkdtemp under a `.kaoiro-grok-` prefix is matched, and only exactly,
  // so a workspace another test or peer owns can never match.
  const name = basename(cwd);
  if (!/^\.kaoiro-grok-[\w-]+-[A-Za-z0-9]{6}$/.test(name) || !existsSync(workspaces)) return;
  const own = new RegExp(`^${name.slice(1).toLowerCase()}-[0-9a-f]{8}$`);
  for (const entry of readdirSync(workspaces))
    if (own.test(entry)) rmSync(join(workspaces, entry), { recursive: true, force: true });
}

describe.skipIf(!live)("native grok session discovery", () => {
  it("lists and finds a session under its cwd only", async () => {
    // Each cwd is its own mkdtemp directory: its random basename is what
    // lets removeGrokState match Grok's workspace for it and nothing else.
    const cwd = mkdtempSync(join(homedir(), ".kaoiro-grok-discovery-"));
    const other = mkdtempSync(join(homedir(), ".kaoiro-grok-discovery-"));
    try {
      // Grok writes a new session to disk a moment after session/new, from the
      // process that made it (measured: a process killed at once leaves no
      // session; 1.5 s later it is listed). Keep the creator alive until then.
      const created = await runGrokProbe({ cwd, deadlineMs: 30_000 }, async (call) => {
        const made = (await call("session/new", { cwd, mcpServers: [] })) as { sessionId: string };
        await vi.waitFor(async () => {
          const page = (await call("session/list", { cwd })) as { sessions: { sessionId: string }[] };
          expect(page.sessions.map((s) => s.sessionId)).toContain(made.sessionId);
        }, { timeout: 20_000, interval: 500 });
        return made;
      });
      const listed = await listGrokSessions(cwd);
      expect(listed.map((s) => s.session_id)).toContain(created.sessionId);
      expect(await grokSessionExists(cwd, created.sessionId)).toBe(true);
      expect(await grokSessionExists(other, created.sessionId)).toBe(false);
      expect(await listGrokSessions(other)).toEqual([]);
    } finally {
      removeGrokState(cwd);
      removeGrokState(other);
      rmSync(cwd, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  }, 120_000);
});
