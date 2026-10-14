import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ServerLink, ServerLinkOptions } from "@kaoiro/wrapper-core";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runGrokCli } from "../src/cli.js";
import { GrokHost } from "../src/host.js";
const config: WrapperConfig = {
  agent_id: "test.grok",
  server_url: "ws://127.0.0.1:1/agent",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  display_name: "Default",
};
const buildInfo = {
  revision: "unknown",
  dirty: false,
  built_at: "unknown",
  version: "unknown",
  channel: "dev" as const,
};
export function recordingLink(
  options: ServerLinkOptions,
  envelopes: Envelope[],
  acknowledgements: number[],
  outbound: Envelope[],
) {
  queueMicrotask(() => {
    options.onPersonaPrompt?.("COMPOSED_PERSONA_AND_FOOTER");
    options.onNoticeAttributionMode?.("legacy");
    options.onInterAgentDeliveryStatus?.({ issued_seq: 1, acked_seq: 0 });
  });
  return {
    send: (e: Envelope) => envelopes.push(e),
    setSessionId: () => {},
    deliveryIncarnation: () => "fixture-incarnation",
    deliveryGeneration: () => "fixture-generation",
    acknowledgeInterAgentDelivery: (seq: number) => acknowledgements.push(seq),
    noticeAttributionMode: () => "legacy",
    reportDisconnectIntent: async () => {},
    close: () => {},
    requestDirectory: async () => ({ agents: [], users: [] }),
    requestInterAgentDeliveryStatus: async () => ({
      issued_seq: 1,
      acked_seq: 1,
      lost_count: 0,
    }),
    sendInterAgent: async (e: Envelope) => {
      outbound.push(e);
      return { kind: "accepted", stamp: null };
    },
    setStatusLine: async () => ({ kind: "ok" }),
    readStatusLine: async () => ({ kind: "error", reason: "not_found" }),
  } as unknown as ServerLink;
}
describe("runGrokCli composition", () => {
  it("reports settings and classifies instruction failures", async () => {
    const envelopes: Envelope[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk)); return true;
    });
    let callbacks!: ServerLinkOptions;
    let probe!: Promise<void>;
    try {
      await runGrokCli({
        parseCliArgs: () => ({ configPath: "fixture" }),
        loadConfig: () => ({ ...config,
          turn_watchdog_inactivity_ms: 120_000,
          turn_watchdog_abort_grace_ms: 1_000,
        }),
        loadWrapperBuildInfo: () => buildInfo,
        createHost: (values) => new GrokHost({ ...values,
          executable: fileURLToPath(
            new URL("./fixtures/grok.mjs", import.meta.url),
          ),
        }),
        createServerLink: (_url, _id, options) => {
          callbacks = options;
          return recordingLink(options, envelopes, [], []);
        },
        onHostCreated: (host) => {
          probe = (async () => {
            await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
              timeout: 5_000,
            });
            callbacks.onInstruction?.("fail-turn");
            await vi.waitFor(() => expect(envelopes.some((e) =>
              e.type === "log" && e.payload.text === "grok turn failed",
            )).toBe(true));
            expect(JSON.stringify(envelopes)).not.toContain("unsupported");
            expect(JSON.stringify(envelopes))
              .not.toContain("TURN_FAILURE_BODY_MARKER");
            callbacks.onInstruction?.("attachment", ["attachment-id"]);
            await vi.waitFor(() => expect(envelopes.some((e) =>
              e.type === "log" && e.payload.text ===
                "grok attachment input is unsupported in work unit 1",
            )).toBe(true));
            const output = stderr.join("");
            expect(output).toContain(
              `[kaoiro] grok behaviour: pid=${process.pid} `,
            );
            expect(output).toContain("120000(config)");
            expect(output).toContain("1000(config)");
            expect(output).toContain("below the 30-minute default");
            host.close();
          })();
          void probe.catch(() => host.close());
        },
      });
      await probe;
    } finally { vi.restoreAllMocks(); }
  });

  it("injects, replies and acknowledges a normal peer turn", async () => {
    const envelopes: Envelope[] = [];
    const ack: number[] = [];
    const outbound: Envelope[] = [];
    let options!: ServerLinkOptions;
    let probe!: Promise<void>;
    const work = runGrokCli({
      parseCliArgs: () => ({ configPath: "fixture" }),
      loadConfig: () => ({ ...config }),
      loadWrapperBuildInfo: () => buildInfo,
      createHost: (values) =>
        new GrokHost({
          ...values,
          executable: fileURLToPath(
            new URL("./fixtures/grok.mjs", import.meta.url),
          ),
        }),
      createServerLink: (_url, _id, o) => {
        options = o;
        return recordingLink(o, envelopes, ack, outbound);
      },
      onHostCreated: (host) => {
        probe = (async () => {
          try {
            await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
              timeout: 5000,
            });
            options.onInterAgentMessage?.({
              ...config,
              version: "0",
              agent_id: "peer",
              ts: new Date().toISOString(),
              type: "inter_agent_message",
              state: "idle",
              delivery_seq: 1,
              payload: {
                conversation_id: "fixture-conversation",
                turn_number: 1,
                kind: "request",
                body: "Reply through send_to_agent",
                meta: { done: false, propose_next: "" },
              },
              ext: {},
            } as Envelope);
            await vi.waitFor(() => expect(outbound).toHaveLength(1), {
              timeout: 5000,
            });
            await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
              timeout: 5000,
            });
            expect(ack).toEqual([1]);
            expect(outbound[0]?.payload).toMatchObject({
              to: "peer",
              conversation_id: "fixture-conversation",
              kind: "response",
            });
            expect(options.interAgentReplyBasis).toBeUndefined();
            expect(options.interAgentDeliveryModes).toMatchObject({
              early: "none",
              yield: "none",
            });
          } finally {
            host.close();
          }
        })();
        void probe.catch(() => host.close());
      },
    });
    await work;
    await probe;
  }, 15_000);
  it("notifies the sender when an injected peer turn fails", async () => {
    const envelopes: Envelope[] = [];
    const ack: number[] = [];
    let callbacks!: ServerLinkOptions;
    let probe!: Promise<void>;
    const work = runGrokCli({
      parseCliArgs: () => ({ configPath: "fixture" }),
      loadConfig: () => ({ ...config }),
      loadWrapperBuildInfo: () => buildInfo,
      createHost: (values) =>
        new GrokHost({
          ...values,
          executable: fileURLToPath(
            new URL("./fixtures/grok.mjs", import.meta.url),
          ),
          env: { ...process.env, KAOIRO_TEST_GROK_FAIL_PEER: "1" },
        }),
      createServerLink: (_url, _id, options) => {
        callbacks = options;
        return recordingLink(options, envelopes, ack, []);
      },
      onHostCreated: (host) => {
        probe = (async () => {
          await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
            timeout: 5_000,
          });
          callbacks.onInterAgentMessage?.({
            ...config,
            version: "0",
            agent_id: "peer",
            ts: new Date().toISOString(),
            type: "inter_agent_message",
            state: "idle",
            delivery_seq: 1,
            payload: {
              conversation_id: "failed-peer",
              turn_number: 1,
              kind: "request",
              body: "Reply",
              meta: { done: false, propose_next: "" },
            },
            ext: {},
          } as Envelope);
          await vi.waitFor(() =>
            expect(
              envelopes.some(
                (e) =>
                  e.type === "inter_agent_message" &&
                  e.payload.conversation_id === "failed-peer" &&
                  e.payload.to === "peer" &&
                  e.payload.error !== undefined,
              ),
            ).toBe(true),
          );
          expect(ack).toEqual([1]);
        })();
        void probe.catch(() => host.close());
      },
    });
    await expect(work).rejects.toThrow(
      /(?:exited|connection closed) unexpectedly/,
    );
    await probe;
  });
  it("keeps all diagnostic outputs content-free through the CLI", async () => {
    const diagnostics: unknown[] = [];
    const envelopes: Envelope[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        diagnostics.push(String(chunk));
        return true;
      });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => {
        diagnostics.push(args);
      });
    let probe!: Promise<void>;
    try {
      const work = runGrokCli({
        parseCliArgs: () => ({ configPath: "fixture" }),
        loadConfig: () => ({ ...config }),
        loadWrapperBuildInfo: () => buildInfo,
        onMetadata: (metadata) => diagnostics.push(metadata),
        additionalTools: [
          {
            name: "probe",
            description: "Probe",
            inputSchema: { type: "object" },
            handler: async () => ({
              content: [{ type: "text", text: "NORMAL_TOOL_MARKER" }],
            }),
          },
        ],
        createHost: (values) =>
          new GrokHost({
            ...values,
            executable: fileURLToPath(
              new URL("./fixtures/grok.mjs", import.meta.url),
            ),
          }),
        createServerLink: (_url, _id, options) =>
          recordingLink(options, envelopes, [], []),
        onHostCreated: (host) => {
          probe = (async () => {
            await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
              timeout: 5_000,
            });
            await host.send("unknown");
            await host.send("NORMAL_PROMPT_MARKER");
            await host.send("tool");
            const diagnostic = JSON.stringify(diagnostics);
            for (const marker of [
              "UNKNOWN_BODY_MARKER",
              "NORMAL_PROMPT_MARKER",
              "NORMAL_TOOL_MARKER",
            ])
              expect(diagnostic).not.toContain(marker);
            expect(JSON.stringify(envelopes)).not.toContain(
              "UNKNOWN_BODY_MARKER",
            );
            // Display logs and results intentionally carry normal content.
            expect(JSON.stringify(envelopes)).toContain("NORMAL_PROMPT_MARKER");
            expect(JSON.stringify(envelopes)).toContain("NORMAL_TOOL_MARKER");
            expect(diagnostic).toContain("future_variant");
            expect(diagnostic).toContain("sdk_diagnostic");
            expect(consoleError).not.toHaveBeenCalled();
          })().finally(() => host.close());
          void probe.catch(() => host.close());
        },
      });
      await work;
      await probe;
    } finally {
      stderr.mockRestore();
      consoleError.mockRestore();
    }
  });
});
