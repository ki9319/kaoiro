import { describe, expect, it, vi } from "vitest";
import { runGrokProbe } from "../src/grok_acp_probe.js";
import { grokSessionExists, listGrokSessions } from "../src/grok_sessions.js";
import { makeGrokScratch, removeGrokState } from "./grok-state.js";

// Discovery against the real grok (issue #644): Grok's session/list binds a
// session to the exact cwd string the runner uses. KAOIRO_LIVE_GROK=1 only;
// session/new makes no model call.

const live = process.env.KAOIRO_LIVE_GROK === "1";

describe.skipIf(!live)("native grok session discovery", () => {
  it("lists and finds a session under its cwd only", async () => {
    const cwd = makeGrokScratch("discovery");
    const other = makeGrokScratch("discovery");
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
    }
  }, 120_000);
});
