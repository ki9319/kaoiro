// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import type { Envelope } from "../src/lib/protocol";
const mounted: object[] = [];
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});
afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
async function render(policy: unknown, engine: string | undefined = "grok") {
  const target = document.createElement("div");
  document.body.append(target);
  const envelope: Envelope = {
    version: "0",
    agent_id: "fixture.grok",
    ts: "2026-10-14T00:00:00Z",
    type: "state_change",
    state: "waiting_input",
    payload: {},
    persona: { id: "default", name: "Default", sprite_set: "default" },
    ext: {
      ...(engine ? { engine } : {}),
      model: "default",
      permission: {
        sandbox: "workspace-write",
        approval: "on-request",
        enforcement: "os",
      },
      permission_policy: policy,
      effective: { sandbox: "workspace-write", network_access: true },
      session_capabilities: {
        supports_permission_switch: false,
        supports_user_input_dialog: true,
        supports_attachments: false,
      },
    },
  };
  mounted.push(
    mount(AgentDetail, { target, props: { envelope, onClose: vi.fn() } }),
  );
  await tick();
  return target;
}
it("renders observed Grok policy fields", async () => {
  const target = await render({
    inspect: "ok",
    grok_sandbox_env: "workspace",
    grok_version: "fixture version",
    sources: ["user", "trusted project"],
    managed_settings_active: true,
    rules_loaded: 7,
    rules_skipped: 2,
    claude_hooks: { enabled: true, source: "config" },
  });
  const text = target.textContent!.replace(/\s+/g, " ");
  for (const value of [
    "Sources: user, trusted project",
    "Managed settings: true",
    "rules loaded: 7",
    "skipped: 2",
    "Claude hooks: true (config)",
    "Sandbox profile: workspace",
    "version: fixture version",
    "Approval decisions are made by grok from the Claude settings it loads; " +
      "kaoiro receives the requests grok sends.",
  ]) {
    expect(text).toContain(value);
  }
  expect(
    target.querySelector(".grok-permission-policy a")?.getAttribute("href"),
  ).toContain("grok-acp.md");
});
it.each(["failed", "timed out", "unknown shape"])(
  "renders unknown fields for inspect %s",
  async () => {
    const target = await render({
      inspect: "unavailable",
      grok_sandbox_env: "workspace",
      grok_version: null,
    });
    const text = target.querySelector(".grok-permission-policy")!.textContent!;
    expect(text).toContain("permission sources unknown");
    for (const label of [
      "Sources:",
      "Managed settings:",
      "rules loaded:",
      "skipped:",
      "Claude hooks:",
    ]) {
      expect(text).not.toContain(label);
    }
  },
);

it.each([undefined, "other-engine"])(
  "renders policy with an unrelated or absent engine %s",
  async (engine) => {
    const target = await render({ inspect: "unavailable" }, engine ?? "");
    expect(target.querySelector(".grok-permission-policy")?.textContent)
      .toContain("permission sources unknown");
  },
);
it("omits the policy component when the field is absent", async () => {
  const target = await render(undefined);
  expect(target.querySelector(".grok-permission-policy")).toBeNull();
});
