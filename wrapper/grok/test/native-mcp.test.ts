import { permitHostAccess } from "../../../scripts/test/fixtures/test-isolation.mjs";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { nativeRun } from "./native-support.js";

permitHostAccess({
  kinds: ["network"],
  optIn: "KAOIRO_LIVE_GROK",
  reason: "live Grok provider run",
});

const live = process.env.KAOIRO_LIVE_GROK === "1";

/** One request from this process, which has no token. Resolves to the status,
 *  or "refused" when nothing listens. */
function send(
  url: string,
  headers: Record<string, string>,
  method = "tools/call",
): Promise<number | "refused"> {
  const target = new URL(url);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    ...(method === "tools/call"
      ? { params: { name: "whoami", arguments: {} } }
      : {}),
  });
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: target.hostname,
        port: Number(target.port),
        path: target.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(body),
          Connection: "close",
          ...headers,
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code === "ECONNREFUSED" ? "refused" : 0),
    );
    request.end(body);
  });
}

// Grok runs its own MCP client in its own process, so a read-only profile that
// blocks a child's AF_UNIX connect (the stdio bridge) must not stop it. No
// model turn: the session is created and the host reports ready only after
// Grok has listed the tools over the authenticated HTTP endpoint.
for (const [sandbox, network] of [
  ["read-only", false],
  ["workspace-write", true],
] as const) {
  it.skipIf(!live)(
    `native ${sandbox}: Grok lists the kaoiro tools over authenticated HTTP`,
    async () => {
      const root = mkdtempSync(join(homedir(), ".kaoiro-grok-mcp-"));
      const cwd = join(root, "work");
      mkdirSync(cwd);
      const config: WrapperConfig = {
        agent_id: "native.mcp",
        display_name: "MCP fixture",
        server_url: "ws://127.0.0.1:1/agent",
        sandbox,
        network_access: network,
        persona: { id: "default", name: "Default", sprite_set: "default" },
      };
      try {
        await nativeRun(config, cwd, async (host) => {
          await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
            timeout: 40_000,
          });
          const before = host.toolHostStats()!;
          // Grok itself listed the tools, and passed the Host, Origin and
          // token checks to do it: nothing of its was turned away.
          expect(before.authenticatedLists).toBeGreaterThanOrEqual(1);
          expect(before.rejected).toEqual({});
          // Negative controls from this process, which holds no token.
          expect(await send(before.url, {})).toBe(401);
          expect(
            await send(before.url, { Authorization: `Bearer ${"x".repeat(43)}` }),
          ).toBe(401);
          expect(
            await send(before.url, { Origin: "https://untrusted.invalid" }),
          ).toBe(403);
          expect(await send(before.url, { Host: "evil.example" })).toBe(403);
          expect(await send(before.url, {}, "tools/list")).toBe(401);
          const after = host.toolHostStats()!;
          expect(after.calls).toBe(before.calls);
          expect(after.authenticatedLists).toBe(before.authenticatedLists);
          host.close();
          await host.closed;
          expect(await send(before.url, {})).toBe("refused");
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
}
