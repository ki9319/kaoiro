import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { nativeRun, type PermissionDecisionRecord } from "./native-support.js";

// Negative controls for the live permission path (issue 615): the plugin makes
// Grok ask on any host, so the answer the test gives decides the turn.
const live = process.env.KAOIRO_LIVE_GROK === "1";
const config: WrapperConfig = {
  agent_id: "native.permission-answer",
  display_name: "Permission answer fixture",
  server_url: "ws://127.0.0.1:1/agent",
  sandbox: "workspace-write",
  network_access: true,
  persona: { id: "default", name: "Default", sprite_set: "default" },
};
const rule = { marker: "KAOIRO_HOOK_PROBE" };
const prompt =
  "Run exactly printf KAOIRO_HOOK_PROBE with run_terminal_command, once. " +
  "Then reply with one word: done.";

it.skipIf(!live)(
  "an unanswered permission request leaves the agent waiting_permission",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-grok-native-unanswered-"));
    try {
      await nativeRun(
        config,
        dir,
        async (host, _callbacks, envelopes) => {
          await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
            timeout: 40_000,
          });
          const turn = host.send(prompt);
          void turn.catch(() => {});
          await vi.waitFor(
            () => {
              expect(envelopes.some((e) => e.type === "permission_request")).toBe(true);
              expect(host.state).toBe("waiting_permission");
            },
            { timeout: 60_000 },
          );
        },
        undefined,
        { rule, answer: "none" },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(!live)(
  "a denied permission request fails the turn as rejected",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-grok-native-denied-"));
    const decisions: PermissionDecisionRecord[] = [];
    try {
      await nativeRun(
        config,
        dir,
        async (host) => {
          await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
            timeout: 40_000,
          });
          await expect(host.send(prompt)).rejects.toThrow("grok permission rejected");
          expect(host.state).toBe("waiting_input");
        },
        undefined,
        { rule, answer: "deny", decisions },
      );
      expect(decisions).toContainEqual({ tool: "run_terminal_command", allow: false });
      expect(decisions.every((d) => !d.allow)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);
