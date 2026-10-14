// @vitest-environment jsdom
// issue #612: the engine-independent stop display for ext.permission_gate.
// The fixtures are grok-shaped (engine "grok"). A Codex status never carries
// the gate, and the existing Codex fixtures live in
// permissionSwitchDisplay.integration.test.ts and must keep passing.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import { makeReactivePermissionDetailProps } from "./reactiveProps.svelte";
import { permissionGateFrom } from "../src/lib/protocol";
import type { Envelope, KaoiroConnection } from "../src/lib/protocol";

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

function connection(): KaoiroConnection {
  return {
    spawn: vi.fn(),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    setPermission: vi.fn(),
  } as unknown as KaoiroConnection;
}

function envelope(
  ext: Record<string, unknown>,
  state = "waiting_input",
  agentId = "host-g.p",
): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts: "2026-10-14T00:00:00Z",
    type: "state_change",
    state,
    payload: {},
    ext,
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

const SWITCH_CAPS = {
  supports_attachments: false,
  supports_user_input_dialog: true,
  supports_permission_switch: true,
};

function grokExt(extra: Record<string, unknown>): Record<string, unknown> {
  return { engine: "grok", session_capabilities: SWITCH_CAPS, ...extra };
}

function control(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revision: 7,
    requested: { sandbox: "workspace-write", network_access: false },
    constraints: { approval: "never", enforcement: "os" },
    status: "pending",
    ...over,
  };
}

/** A failed control whose rolled_back_to is the server's fallback. */
function failedWithFallback(
  reason: string,
  revision: number,
): Record<string, unknown> {
  return control({
    revision,
    status: "failed",
    reason,
    rolled_back_to: { sandbox: "read-only", network_access: false },
  });
}

function gate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "blocked",
    reason: "awaiting_server_next",
    revision: 7,
    step: "spawn",
    since: "2026-10-14T00:00:00Z",
    ...over,
  };
}

function rowByLabel(target: HTMLElement, label: string): HTMLElement | null {
  for (const row of target.querySelectorAll(".cc-row")) {
    if (row.querySelector("dt")?.textContent?.trim() === label) {
      return row.querySelector("dd");
    }
  }
  return null;
}

async function render(
  ext: Record<string, unknown>,
  state = "waiting_input",
) {
  const target = document.createElement("div");
  document.body.append(target);
  const props = makeReactivePermissionDetailProps({
    envelope: envelope(ext, state),
    connection: connection(),
    onClose: vi.fn(),
    onSetPermission: vi.fn(async () => null) as never,
  });
  const component = mount(AgentDetail, { target, props });
  mounted.push(component);
  await tick();
  return { target };
}

describe("permissionGateFrom (issue #612)", () => {
  it("reads a well-formed gate", () => {
    expect(permissionGateFrom(envelope({ permission_gate: gate() }))).toEqual({
      reason: "awaiting_server_next",
      revision: 7,
      step: "spawn",
      since: "2026-10-14T00:00:00Z",
    });
  });

  it("reads an absent step as absent, not as a value", () => {
    const parsed = permissionGateFrom(
      envelope({ permission_gate: gate({ reason: "observation_unavailable", step: undefined }) }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("step");
  });

  it.each([
    ["the field is absent", {}],
    ["the status is not blocked", { permission_gate: gate({ status: "clear" }) }],
    ["the reason is unknown", { permission_gate: gate({ reason: "bogus" }) }],
    ["the revision is negative", { permission_gate: gate({ revision: -1 }) }],
    ["the step is unknown", { permission_gate: gate({ step: "bogus" }) }],
    ["since is missing", { permission_gate: gate({ since: undefined }) }],
  ])("reads as absent when %s", (_label, ext) => {
    expect(permissionGateFrom(envelope(ext))).toBeNull();
  });
});

describe("AgentDetail permission gate recovery (issue #612)", () => {
  it("case 1: a restart failure with the server fallback shows the stop and does not draw a recovered rollback", async () => {
    const { target } = await render(
      grokExt({
        permission_control: failedWithFallback("restart_failed", 7),
        permission_gate: gate(),
      }),
    );
    const dock = target.querySelector(".permission-gate-dock")?.textContent ?? "";
    expect(dock).toContain("権限の確認で止まっています");
    expect(dock).toContain("rev 7: awaiting_server_next (spawn)");
    expect(dock).toContain("サーバの fallback では何も実行されていません");
    expect(dock).toContain("同じ組み合わせでも可");
    expect(dock).toContain("キャンセルされた指示は再送されません");

    const row = rowByLabel(target, "権限要求")?.textContent ?? "";
    expect(row).toContain("サーバの fallback（未適用）");
    expect(row).not.toContain("適用前に戻した設定");
    expect(row).toContain("要求: 不明");
  });

  it("case 3: a refused later selection names the revision of the server fallback", async () => {
    const { target } = await render(
      grokExt({
        permission_control: failedWithFallback("unsupported_permission_pair", 8),
        permission_gate: gate({ revision: 8, step: "load" }),
      }),
    );
    const dock = target.querySelector(".permission-gate-dock")?.textContent ?? "";
    expect(dock).toContain("rev 8: awaiting_server_next (load)");
    expect(dock).toContain("wrapper は rev 8 (load) を適用する前に止まっています");
    expect(dock).not.toContain("rev 7");
    const row = rowByLabel(target, "権限要求")?.textContent ?? "";
    expect(row).toContain("サーバの fallback（未適用）");
    expect(row).toContain("read-only");
  });

  it("unknown: an unconfirmed outcome (observation_unavailable) shows the stop", async () => {
    const { target } = await render(
      grokExt({
        permission_control: control({
          status: "unknown",
          submitted: {
            revision: 7,
            requested: { sandbox: "workspace-write", network_access: false },
            execution_id: "exec-7",
          },
          reason: "observation_unavailable",
        }),
        permission_gate: gate({ reason: "observation_unavailable", step: undefined }),
      }),
    );
    const dock = target.querySelector(".permission-gate-dock")?.textContent ?? "";
    expect(dock).toContain("rev 7: observation_unavailable");
    expect(dock).toContain("rev 7 の結果を確認できませんでした");
    expect(dock).not.toContain("サーバの fallback では何も実行されていません");
  });

  it("next_over_ceiling: the guidance asks for a selection within the limit and forbids the same pair", async () => {
    const { target } = await render(
      grokExt({
        permission_control: failedWithFallback("unsupported_permission_pair", 8),
        permission_gate: gate({ revision: 8, step: "next_over_ceiling" }),
      }),
    );
    const dock = target.querySelector(".permission-gate-dock")?.textContent ?? "";
    expect(dock).toContain("上限内の権限を選ぶと再開します");
    expect(dock).toContain("同じ組み合わせは");
    expect(dock).not.toContain("同じ組み合わせでも可");
    expect(dock).not.toContain("サーバの fallback では何も実行されていません");
  });

  it("sheet tone: the handle lamp shows waiting_permission while the gate is present, even after the state returned to waiting_input", async () => {
    const { target } = await render(
      grokExt({
        permission_control: failedWithFallback("restart_failed", 7),
        permission_gate: gate(),
      }),
      "waiting_input",
    );
    (target.querySelector(".toggle") as HTMLElement).click();
    await tick();
    expect(target.querySelector(".pending-lamp")?.getAttribute("data-tone")).toBe(
      "waiting_permission",
    );
  });

  it("negative control: a final-gate refusal without a gate shows no guidance and no waiting tone", async () => {
    const { target } = await render(
      grokExt({
        permission_control: failedWithFallback("unsupported_permission_pair", 7),
      }),
    );
    expect(target.querySelector(".permission-gate-dock")).toBeNull();
    expect(target.textContent).not.toContain("権限の確認で止まっています");
    expect(target.textContent).not.toContain("wrapper は rev");
    const row = rowByLabel(target, "権限要求")?.textContent ?? "";
    expect(row).toContain("適用前に戻した設定");
    expect(row).not.toContain("サーバの fallback（未適用）");
    (target.querySelector(".toggle") as HTMLElement).click();
    await tick();
    expect(target.querySelector(".pending-lamp")).toBeNull();
  });

  it("keeps the tool-approval dock in charge when a pending permission exists alongside the gate", async () => {
    const { target } = await render(
      grokExt({
        permission_control: failedWithFallback("restart_failed", 7),
        permission_gate: gate(),
        pending_permission: {
          request_id: "perm-1",
          tool_name: "Bash",
          input: { command: "pnpm test" },
        },
      }),
      "waiting_permission",
    );
    const dock = target.querySelector(".permission-dock")?.textContent ?? "";
    expect(dock).toContain("Bash");
    expect(dock).not.toContain("権限の確認で止まっています");
  });
});
