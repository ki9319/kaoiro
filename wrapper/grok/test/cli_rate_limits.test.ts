import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { ServerLink, ServerLinkOptions } from "@kaoiro/wrapper-core";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runGrokCli } from "../src/cli.js";
import { GrokHost } from "../src/host.js";

const config: WrapperConfig = {
  agent_id: "rates.grok",
  display_name: "Rate fixture",
  server_url: "ws://127.0.0.1:1/agent",
  sandbox: "workspace-write",
  network_access: true,
  persona: { id: "default", name: "Default", sprite_set: "default" },
};
const buildInfo = {
  revision: "unknown", dirty: false, built_at: "unknown", version: "unknown", channel: "dev" as const,
};
const executable = fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url));

function toolText(output: string): string {
  const result = JSON.parse(output) as { content?: { type: string; text?: string }[] };
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

it("projects the same weekly window through whoami and list_agents", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kaoiro-momo660-cli-rates-"));
  const envelopes: Envelope[] = [];
  const peerWindow = { seven_day: { utilization: 0.25, resets_at: 4_102_358_400 } };
  let directoryReads = 0;
  let probe!: Promise<void>;
  try {
    const work = runGrokCli({
      parseCliArgs: () => ({ configPath: "fixture" }),
      loadConfig: () => ({ ...config }),
      loadWrapperBuildInfo: () => buildInfo,
      createHost: (options) => new GrokHost({ ...options, executable,
        env: { ...options.env, KAOIRO_TEST_GROK_BILLING: "valid" } }),
      createServerLink: (_url, _id, options) => {
        queueMicrotask(() => options.onPersonaPrompt?.("fixture rules"));
        return {
          send: (envelope: Envelope) => envelopes.push(envelope),
          setSessionId: () => {},
          currentSessionId: () => null,
          requestDirectory: async () => {
            directoryReads += 1;
            return { agents: [{ agent_id: "rates.peer", display_name: "Rate peer", state: "idle",
              persona: config.persona, rate_limits: peerWindow }], users: [] };
          },
          requestInterAgentDeliveryStatus: async () => ({ issued_seq: 0, acked_seq: 0, lost_count: 0 }),
          noticeAttributionMode: () => "legacy",
          deliveryIncarnation: () => "fixture-incarnation",
          deliveryGeneration: () => "fixture-generation",
          reportDisconnectIntent: async () => {},
          acknowledgeInterAgentDelivery: () => {},
          sendInterAgent: async () => ({ kind: "accepted", stamp: null }),
          setStatusLine: async () => ({ kind: "ok" }),
          readStatusLine: async () => ({ kind: "error", reason: "not_found" }),
          close: () => {},
        } as unknown as ServerLink;
      },
      cwd,
      onHostCreated: (host) => {
        probe = (async () => {
          await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 5_000 });
          await vi.waitFor(() => expect(host.statusSnapshot()).toHaveProperty("rate_limits.seven_day"));
          const own = host.statusSnapshot().rate_limits;
          expect(envelopes.filter((envelope) => envelope.type === "state_change" &&
            envelope.ext?.rate_limits).at(-1)?.ext.rate_limits).toEqual(own);

          await host.send("whoami");
          const whoami = JSON.parse(toolText(
            String(envelopes.filter((envelope) => envelope.type === "result").at(-1)?.payload.text ?? "{}"),
          )) as Record<string, unknown>;
          expect(whoami.agent_id).toBe(config.agent_id);
          expect(whoami.rate_limits).toEqual(own);
          expect(JSON.stringify(whoami)).not.toContain("PRIVATE_BILLING_FIELD");
          expect(JSON.stringify(whoami)).not.toContain('"amount"');

          await host.send("list-agents");
          const directory = toolText(
            String(envelopes.filter((envelope) => envelope.type === "result").at(-1)?.payload.text ?? "{}"),
          );
          expect(directoryReads).toBe(1);
          expect(directory).toContain("rates.peer");
          expect(directory).toContain('"rate_limits"');
          expect(directory).toContain('"seven_day"');
        })().finally(() => host.close());
        void probe.catch(() => {});
      },
    });
    await work;
    await probe;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
