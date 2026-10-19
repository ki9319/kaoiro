import { permitHostAccess } from "../../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ServerLink, ServerLinkOptions } from "@kaoiro/wrapper-core";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runGrokCli } from "../src/cli.js";
import { GrokHost } from "../src/host.js";

permitHostAccess({
  kinds: ["network"],
  optIn: "KAOIRO_LIVE_GROK_RATE_LIMITS",
  reason: "live Grok provider run",
});

const live = process.env.KAOIRO_LIVE_GROK_RATE_LIMITS === "1";
const config: WrapperConfig = {
  agent_id: "native.rate-limits",
  display_name: "Native rate limits",
  server_url: "ws://127.0.0.1:1/agent",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  sandbox: "workspace-write",
  network_access: true,
};
const buildInfo = {
  revision: "unknown", dirty: false, built_at: "unknown", version: "unknown", channel: "dev" as const,
};
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function check(condition: boolean, reason: string): void {
  if (!condition) throw new Error(`native rate-limit check failed: ${reason}`);
}

it.skipIf(!live)("native Grok reports its own weekly window and renders a peer directory", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kaoiro-momo660-native-rates-"));
  dirs.push(cwd);
  const envelopes: Envelope[] = [];
  let probe!: Promise<void>;
  const directoryWindow = { seven_day: { utilization: 0.25, resets_at: 4_102_358_400 } };
  let directoryReads = 0;
  try {
    const run = runGrokCli({
      parseCliArgs: () => ({ configPath: "native-rates" }),
      loadConfig: () => ({ ...config }),
      loadWrapperBuildInfo: () => buildInfo,
      cwd,
      createServerLink: (_url, _id, options) => {
        queueMicrotask(() => options.onPersonaPrompt?.("Use the requested tools and reply briefly."));
        const link = {
          send: (envelope: Envelope) => envelopes.push(envelope),
          setSessionId: () => {},
          requestDirectory: async () => {
            directoryReads += 1;
            return { agents: [{ agent_id: "native-peer", display_name: "Native peer", state: "idle",
              persona: config.persona, rate_limits: directoryWindow }], users: [] };
          },
          requestInterAgentDeliveryStatus: async () => ({ issued_seq: 0, acked_seq: 0, lost_count: 0 }),
          noticeAttributionMode: () => "legacy",
          deliveryIncarnation: () => null,
          deliveryGeneration: () => null,
          reportDisconnectIntent: async () => {},
          close: () => {},
        } as unknown as ServerLink;
        return link;
      },
      onHostCreated: (host) => {
        probe = (async () => {
          await vi.waitFor(() => check(host.state === "waiting_input" &&
            host.statusSnapshot().rate_limits !== undefined, "startup snapshot"), { timeout: 60_000 });
          const own = host.statusSnapshot().rate_limits as { seven_day?: { utilization?: unknown; resets_at?: unknown } };
          const state = envelopes.filter((envelope) => envelope.type === "state_change" &&
            envelope.ext?.rate_limits).at(-1);
          check(typeof own.seven_day?.utilization === "number" &&
            Number.isFinite(own.seven_day.utilization) && own.seven_day.utilization >= 0 &&
            own.seven_day.utilization <= 1, "weekly utilization shape");
          check(Number.isSafeInteger(own.seven_day?.resets_at) &&
            Number(own.seven_day?.resets_at) >= 0, "weekly reset shape");
          check(JSON.stringify(state?.ext.rate_limits) === JSON.stringify(own), "state and whoami snapshot equality");

          const beforeWhoami = host.toolHostStats()?.calls ?? 0;
          await host.send("Call kaoiro whoami exactly once with empty arguments. Reply checked.");
          check(host.toolHostStats()?.calls === beforeWhoami + 1, "native whoami tool call");
          check(host.statusSnapshot().rate_limits !== undefined, "whoami snapshot remains published");

          const beforeDirectory = host.toolHostStats()?.calls ?? 0;
          await host.send("Call kaoiro list_agents exactly once with empty arguments. Reply checked.");
          check(host.toolHostStats()?.calls === beforeDirectory + 1 && directoryReads === 1,
            "native list_agents peer directory call");
        })().finally(() => host.close());
        void probe.catch(() => host.close());
      },
    });
    await run;
    await probe;
  } finally {
    const grokHome = process.env.GROK_HOME ?? join(homedir(), ".grok");
    const sessionDirectory = join(grokHome, "sessions", encodeURIComponent(cwd));
    rmSync(sessionDirectory, { recursive: true, force: true });
  }
}, 120_000);
