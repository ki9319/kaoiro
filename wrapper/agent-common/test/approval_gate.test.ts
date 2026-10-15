import { describe, expect, it, vi } from "vitest";
import { operatorApprovalGated } from "../src/approval_gate.js";
import type { PermissionDecision } from "../src/permission.js";
import type { ToolDescriptor } from "../src/tooling.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function rig(options: {
  decide?: (
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<PermissionDecision>;
  autonomous?: () => boolean;
  onAutonomous?: () => void;
  toolName?: string;
  validate?: (input: Record<string, unknown>) => { ok: true } | { ok: false; message: string };
} = {}) {
  const calls: Record<string, unknown>[] = [];
  const asked: { toolName: string; signal: AbortSignal | undefined }[] = [];
  const inner: ToolDescriptor = {
    name: "danger",
    description: "does something heavy",
    inputSchema: { type: "object", properties: {} },
    handler: async (input) => {
      calls.push(input);
      return { content: [{ type: "text", text: "done" }] };
    },
  };
  const decision = deferred<PermissionDecision>();
  const gated = operatorApprovalGated(inner, {
    decide:
      options.decide ??
      ((toolName, _input, signal) => {
        asked.push({ toolName, signal });
        return decision.promise;
      }),
    ...(options.autonomous === undefined ? {} : { autonomous: options.autonomous }),
    ...(options.onAutonomous === undefined ? {} : { onAutonomous: options.onAutonomous }),
    ...(options.toolName !== undefined ? { toolName: options.toolName } : {}),
    ...(options.validate !== undefined ? { validate: options.validate } : {}),
  });
  return { calls, asked, decision, gated, inner };
}

describe("operatorApprovalGated", () => {
  it("keeps the descriptor's name, description and schema", () => {
    const { gated, inner } = rig();
    expect(gated.name).toBe(inner.name);
    expect(gated.description).toBe(inner.description);
    expect(gated.inputSchema).toBe(inner.inputSchema);
  });

  it("runs the wrapped handler only after allow", async () => {
    const { calls, asked, decision, gated } = rig({ toolName: "mcp__kaoiro__danger" });
    const call = gated.handler({ x: 1 }, { signal: new AbortController().signal });
    expect(asked).toEqual([{ toolName: "mcp__kaoiro__danger", signal: expect.any(AbortSignal) }]);
    expect(calls).toHaveLength(0);
    decision.resolve({ allow: true });
    await expect(call).resolves.toEqual({ content: [{ type: "text", text: "done" }] });
    expect(calls).toEqual([{ x: 1 }]);
  });

  it("deny returns an error result and never runs the handler", async () => {
    const { calls, decision, gated } = rig();
    const call = gated.handler({});
    decision.resolve({ allow: false, message: "nope" });
    const result = await call;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not approved");
    expect(result.content[0]!.text).toContain("nope");
    expect(calls).toHaveLength(0);
  });

  it("a rejected decision is a deny", async () => {
    const { calls, gated } = rig({
      decide: () => Promise.reject(new Error("broker gone")),
    });
    const result = await gated.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("broker gone");
    expect(calls).toHaveLength(0);
  });

  it("an already-aborted signal denies without asking", async () => {
    const { asked, calls, gated } = rig();
    const result = await gated.handler({}, { signal: AbortSignal.abort() });
    expect(result.isError).toBe(true);
    expect(asked).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("an abort between the allow and the continuation denies (post-await re-check)", async () => {
    const { calls, decision, gated } = rig();
    const controller = new AbortController();
    const call = gated.handler({}, { signal: controller.signal });
    // Same task: the allow resolves, then the turn is gone before the
    // gate's continuation runs.
    decision.resolve({ allow: true });
    controller.abort();
    const result = await call;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("cancelled");
    expect(calls).toHaveLength(0);
  });

  it("validate runs before the operator is asked", async () => {
    const { asked, calls, gated } = rig({
      validate: (input) =>
        input.mode === "new" ? { ok: true } : { ok: false, message: "bad mode" },
    });
    const result = await gated.handler({ mode: "sideways" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("bad mode");
    expect(asked).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("engine approval policy", () => {
  it.each(["absent", "false", "throws"])("%s policy asks", async policy => {
    const autonomous = policy === "absent" ? undefined : () => {
      if (policy === "throws") throw new Error("unknown policy");
      return false;
    };
    const onAutonomous = vi.fn();
    const r = rig({ onAutonomous, ...(autonomous === undefined ? {} : { autonomous }) });
    const call = r.gated.handler({});
    expect(r.asked).toHaveLength(1);
    r.decision.resolve({ allow: true });
    await call;
    expect(r.calls).toHaveLength(1);
    expect(onAutonomous).not.toHaveBeenCalled();
  });

  it("autonomous policy runs without the broker", async () => {
    const onAutonomous = vi.fn();
    const r = rig({ autonomous: () => true, onAutonomous });
    expect((await r.gated.handler({})).isError).not.toBe(true);
    expect(r.asked).toHaveLength(0);
    expect(r.calls).toHaveLength(1);
    expect(onAutonomous).toHaveBeenCalledTimes(1);
  });

  it("abandoned calls do not validate or evaluate autonomy", async () => {
    const autonomous = vi.fn(() => true);
    const validate = vi.fn(() => ({ ok: true as const }));
    const r = rig({ autonomous, validate });
    expect((await r.gated.handler({}, { signal: AbortSignal.abort() })).isError).toBe(true);
    expect(validate).not.toHaveBeenCalled();
    expect(autonomous).not.toHaveBeenCalled();
    expect(r.asked).toHaveLength(0);
    expect(r.calls).toHaveLength(0);
  });

  it("an abort during the autonomous decision prevents reservation", async () => {
    const controller = new AbortController();
    const onAutonomous = vi.fn();
    const r = rig({ autonomous: () => { controller.abort();return true; }, onAutonomous });
    expect((await r.gated.handler({}, { signal: controller.signal })).isError).toBe(true);
    expect(onAutonomous).not.toHaveBeenCalled();
    expect(r.asked).toHaveLength(0);
    expect(r.calls).toHaveLength(0);
  });

  it("invalid input never evaluates autonomy", async () => {
    const autonomous = vi.fn(() => true);
    const r = rig({ autonomous, validate: () => ({ ok: false, message: "bad" }) });
    expect((await r.gated.handler({})).isError).toBe(true);
    expect(autonomous).not.toHaveBeenCalled();
    expect(r.calls).toHaveLength(0);
  });
});
