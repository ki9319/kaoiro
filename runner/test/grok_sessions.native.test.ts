import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
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
  // Grok names a workspace `<cwd basename>-<8 hex>`. Only a scratch cwd made
  // by mkdtemp under a `.kaoiro-grok-` prefix is matched, and only exactly,
  // so a workspace another test or peer owns can never match.
  const name = basename(cwd);
  if (!/^\.kaoiro-grok-[\w-]+-[A-Za-z0-9]{6}$/.test(name) || !existsSync(workspaces)) return;
  const own = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[0-9a-f]{8}$`);
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
      const created = await runGrokProbe({ cwd }, async (call) =>
        (await call("session/new", { cwd, mcpServers: [] })) as { sessionId: string });
      expect(typeof created.sessionId).toBe("string");
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
