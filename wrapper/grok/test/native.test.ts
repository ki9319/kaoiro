import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ServerLink, ServerLinkOptions } from "@kaoiro/wrapper-core";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runGrokCli } from "../src/cli.js";
import { GrokHost } from "../src/host.js";
import { childEnvironment, parsePermissionPolicy } from "../src/grok/policy.js";
import type { WireMetadata } from "../src/acp/connection.js";
import { checkToolRoundTrip, type ToolEvidence } from "./acceptance.js";
const live = process.env.KAOIRO_LIVE_GROK === "1";
const config: WrapperConfig = {
  agent_id: "native.grok",
  display_name: "Native fixture",
  server_url: "ws://127.0.0.1:1/agent",
  sandbox: "workspace-write",
  network_access: true,
  persona: { id: "default", name: "Default", sprite_set: "default" },
};
const buildInfo = {
  revision: "unknown",
  dirty: false,
  built_at: "unknown",
  version: "unknown",
  channel: "dev" as const,
};
it.skipIf(!live)(
  "native entry: tools, multi-turn, peer ACK and enabled Claude hooks",
  async () => {
    const marker = "GROK_NATIVE_RESULT_7";
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-grok-native-"));
    const file = join(dir, "agent.json");
    writeFileSync(file, JSON.stringify(config));
    const argv = process.argv;
    process.argv = [argv[0]!, argv[1]!, file];
    const envelopes: Envelope[] = [];
    const metadata: WireMetadata[] = [];
    const outbound: Envelope[] = [];
    const ack: number[] = [];
    const calls: ToolEvidence["calls"] = [];
    let callbacks!: ServerLinkOptions;
    let probe!: Promise<void>;
    const startedAt = Date.now();
    try {
      const run = runGrokCli({
        cwd: dir,
        loadWrapperBuildInfo: () => buildInfo,
        onMetadata: (value) => metadata.push(value),
        createServerLink: (_url, _id, options) => {
          callbacks = options;
          queueMicrotask(() => {
            options.onPersonaPrompt?.(
              "Use the requested kaoiro tools and be concise.",
            );
            options.onNoticeAttributionMode?.("legacy");
            options.onInterAgentDeliveryStatus?.({
              issued_seq: 0,
              acked_seq: 0,
            });
          });
          return {
            send: (e: Envelope) => envelopes.push(e),
            setSessionId: () => {},
            requestDirectory: async () => ({
              agents: [
                {
                  agent_id: "native-peer",
                  display_name: marker,
                  state: "idle",
                  persona: config.persona,
                },
              ],
              users: [],
            }),
            sendInterAgent: async (e: Envelope) => {
              outbound.push(e);
              return { kind: "accepted", stamp: null };
            },
            noticeAttributionMode: () => "legacy",
            deliveryIncarnation: () => "native-incarnation",
            deliveryGeneration: () => "native-generation",
            acknowledgeInterAgentDelivery: (n: number) => ack.push(n),
            reportDisconnectIntent: async () => {},
            close: () => {},
            requestInterAgentDeliveryStatus: async () => ({
              issued_seq: 1,
              acked_seq: 1,
              lost_count: 0,
            }),
          } as unknown as ServerLink;
        },
        // Observers forward the production descriptors and handler results.
        createHost: (options) =>
          new GrokHost({
            ...options,
            toolDescriptors: (options.toolDescriptors ?? []).map((d) => ({
              ...d,
              handler: async (input, context) => {
                const result = await d.handler(input, context);
                calls.push({
                  name: d.name,
                  input,
                  isError: result.isError === true,
                });
                return result;
              },
            })),
          }),
        onHostCreated: (host) => {
          probe = (async () => {
            try {
              await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
                timeout: 40_000,
              });
              const ext = host.statusExtSnapshot();
              const env = childEnvironment(process.env, "workspace");
              const raw = JSON.parse(
                execFileSync(
                  "grok",
                  ["--no-auto-update", "inspect", "--json"],
                  { cwd: dir, env, encoding: "utf8" },
                ),
              );
              const version = execFileSync(
                "grok",
                ["--no-auto-update", "--version"],
                { cwd: dir, env, encoding: "utf8" },
              ).trim();
              expect(ext.permission_policy).toEqual(
                parsePermissionPolicy(raw, {
                  grok_sandbox_env: "workspace",
                  grok_version: version,
                }),
              );
              expect(ext.permission_policy).toMatchObject({
                inspect: "ok",
                claude_hooks: { enabled: true, source: "config" },
              });
              expect(
                Object.keys(env).some((key) =>
                  /^GROK_CLAUDE_.*_ENABLED$/.test(key),
                ),
              ).toBe(false);
              await host.send(
                "Run printf KAOIRO_HOOK_PROBE via run_terminal_command. " +
                  "Then call kaoiro list_agents with empty arguments. " +
                  "Reply with only native-peer display_name. Remember it.",
              );
              const text = String(
                envelopes.filter((e) => e.type === "result").at(-1)?.payload
                  .text,
              );
              checkToolRoundTrip({ calls, text }, "list_agents", {}, marker);
              expect(host.state).toBe("waiting_input");
              expect(envelopes.some((e) => e.state === "tool_running")).toBe(
                true,
              );
              await host.send("No tools. Reply with the remembered name.");
              expect(
                envelopes.filter((e) => e.type === "result").at(-1)?.payload
                  .text,
              ).toContain(marker);
              const start = outbound.length;
              callbacks.onInterAgentMessage?.({
                version: "0",
                agent_id: "native-peer",
                display_name: "Native peer",
                persona: config.persona,
                ts: new Date().toISOString(),
                type: "inter_agent_message",
                state: "idle",
                delivery_seq: 1,
                payload: {
                  conversation_id: "native-conversation",
                  turn_number: 1,
                  kind: "request",
                  body:
                    "Send once to native-peer here via kaoiro send_to_agent. " +
                    "Use kind=response, body=received, done=true; " +
                    "empty propose_next.",
                  meta: { done: false, propose_next: "" },
                },
                ext: {},
              } as Envelope);
              await vi.waitFor(
                () => expect(outbound.length).toBeGreaterThan(start),
                { timeout: 120_000 },
              );
              await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
                timeout: 120_000,
              });
              expect(outbound.at(-1)?.payload).toMatchObject({
                to: "native-peer",
                conversation_id: "native-conversation",
                kind: "response",
              });
              expect(ack).toEqual([1]);
              expect(
                metadata.some((m) => m.hook_event === "session_start"),
              ).toBe(true);
              expect(
                metadata.some((m) => m.hook_event === "pre_tool_use"),
              ).toBe(true);
              expect(metadata.some((m) => m.prompt_id)).toBe(true);
              const responses = metadata.filter((m) => m.request_id);
              expect(responses).toHaveLength(3);
              for (const response of responses) {
                expect(response.request_id).toBe(response.prompt_id);
                expect(
                  metadata.some(
                    (m) =>
                      m.vendor_kind === "turn_completed" &&
                      m.prompt_id === response.prompt_id,
                  ),
                ).toBe(true);
              }
              if (process.env.KAOIRO_LIVE_GROK_REPORT) {
                writeFileSync(
                  process.env.KAOIRO_LIVE_GROK_REPORT,
                  JSON.stringify(
                    {
                      elapsed_ms: Date.now() - startedAt,
                      policy: ext.permission_policy,
                      metadata,
                      calls,
                      acknowledgements: ack,
                      states: envelopes
                        .filter((e) => e.type === "state_change")
                        .map((e) => e.state),
                      results: envelopes
                        .filter((e) => e.type === "result")
                        .map((e) => e.payload),
                    },
                    null,
                    2,
                  ),
                );
              }
            } finally {
              const pid = host.processId;
              host.close();
              await host.closed;
              if (pid) expect(() => process.kill(-pid, 0)).toThrow();
            }
          })();
          void probe.catch(() => host.close());
        },
      });
      await run;
      await probe;
    } finally {
      process.argv = argv;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  240_000,
);

it.skipIf(!live)(
  "native default constructor strips a conflicting parent hooks env at spawn",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-grok-native-env-"));
    const previous = process.env.GROK_CLAUDE_HOOKS_ENABLED;
    process.env.GROK_CLAUDE_HOOKS_ENABLED = "false";
    const host = new GrokHost({
      config,
      cwd: dir,
      personaPrompt: "Be concise.",
      send: () => {},
      decidePermission: async () => ({ allow: false }),
    });
    const run = host.run();
    void run.catch(() => {});
    try {
      await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
        timeout: 40_000,
      });
      expect(host.statusExtSnapshot().permission_policy).toMatchObject({
        inspect: "ok",
        claude_hooks: { enabled: true, source: "config" },
      });
    } finally {
      host.close();
      await run;
      if (previous === undefined) delete process.env.GROK_CLAUDE_HOOKS_ENABLED;
      else process.env.GROK_CLAUDE_HOOKS_ENABLED = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
void homedir;
