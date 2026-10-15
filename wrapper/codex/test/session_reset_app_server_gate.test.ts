import { describe, expect, it, vi } from "vitest";
import type { Socket } from "node:net";
import { PermissionBroker } from "@kaoiro/agent-common";
import { cliAppFixture } from "./fixtures/cli_app_server.js";

type Fixture = Awaited<ReturnType<typeof cliAppFixture>>;
const resets = (f: Fixture) => f.wire.received.filter(e => e.event === "session_reset_request");
const pending = (f: Fixture) => f.envelopes("permission_request");

async function select(f: Fixture, revision: number, approval: "never" | "on-request" | "untrusted", failed = false) {
  const selection = { revision, requested: { sandbox: "workspace-write", network_access: false, approval } };
  const sync = { version: "0" as const, next: selection, control: {
    ...selection, status: failed ? "failed" : "pending", ...(failed ? { reason: "policy_mismatch" } : {}),
    constraints: { approval: "never", enforcement: "os" },
  } };
  if (failed) f.host.applyPermissionSync(sync as Parameters<typeof f.host.applyPermissionSync>[0]);
  else if (revision === 1) f.wire.push("permission_sync", sync);
  else f.wire.push("set_permission", { version: "0", revision, ...selection.requested });
  await vi.waitFor(() => {
    const state = f.host.bridgeToolApproval(f.host.activeInterAgentTurnToken());
    expect(state.next).toBe(approval);
    expect(state.blocked).toBe(failed);
  });
  await f.drain();
}

async function strict(timeout?: number, approval: "on-request" | "untrusted" = "on-request") {
  const f = await cliAppFixture(true, "app-server", "legacy", { approvalAxis: true, ...(timeout === undefined ? {} : { permissionTimeoutMs: timeout }) });
  await select(f, 1, approval);
  await f.inbound(1, "first");
  await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
  expect(f.turns()[0]!.params).toMatchObject({ approvalPolicy: approval });
  expect(f.host.bridgeToolApproval(f.host.activeInterAgentTurnToken()).turn).toBe(approval);
  return f;
}

async function ask(f: Fixture, observe?: (socket: Socket) => void) {
  const before = pending(f).length;
  const reply = f.tool("request_session_reset", { mode: "new" }, observe)
    .catch(error => ({ closed: true, message: String(error) }));
  await vi.waitFor(() => expect(pending(f)).toHaveLength(before + 1));
  const request = pending(f)[before]!.payload as { request_id: string };
  await vi.waitFor(() => expect(f.envelopes("state_change").some(e => e.state === "waiting_permission" && (e.ext as Record<string, unknown> | undefined)?.pending_permission)).toBe(true));
  return { reply, id: request.request_id };
}
function decide(f: Fixture, id: string, allow: boolean) {
  f.wire.push("permission_decision", { version: "0", request_id: id, allow });
}
async function completedWithoutReset(f: Fixture) {
  f.terminal();
  await vi.waitFor(() => expect(f.envelopes("result")).toHaveLength(1));
  await f.drain();
  expect(resets(f)).toHaveLength(0);
}

describe("app-server reset approval through production CLI composition", () => {
  it.each([false, true])("never policy is autonomous with approval axis %s", async axis => {
    const f = await cliAppFixture(axis, "app-server", "legacy", { approvalAxis: axis });
    const broker = vi.spyOn(PermissionBroker.prototype, "decide");
    try {
      if (axis) await select(f, 1, "never");
      await f.inbound(1, "first");await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
      const token = f.host.activeInterAgentTurnToken();
      expect(f.turns()[0]!.params).toMatchObject({ approvalPolicy: "never" });
      expect(f.host.bridgeToolApproval(token)).toEqual({ turn: "never", next: "never", blocked: false });
      expect(f.host.bridgeToolApproval("wrong-token").turn).toBeNull();
      expect(JSON.stringify(await f.tool("request_session_reset", { mode: "new" }))).toContain("reserved");
      expect(broker).not.toHaveBeenCalled();expect(pending(f)).toHaveLength(0);
      expect(f.envelopes("state_change").some(e => e.state === "waiting_permission")).toBe(false);
      expect(resets(f)).toHaveLength(0);
      f.terminal();await vi.waitFor(() => expect(resets(f)).toHaveLength(1));
    } finally { broker.mockRestore();await f.close(); }
  });

  it.each([false, true])("replayed strict approval follows the current app-server axis (axis=%s)", async axis => {
    const f = await cliAppFixture(true, "app-server", "legacy", { approvalAxis: axis });
    const broker = vi.spyOn(PermissionBroker.prototype, "decide");
    try {
      const stored = { revision: 3, requested: {
        sandbox: "workspace-write", network_access: false, approval: "on-request",
      } };
      f.wire.push("permission_sync", { version: "0", next: stored,
        control: { ...stored, status: "pending", constraints: { approval: "never", enforcement: "os" } },
      });
      await f.drain();
      await f.inbound(1, "first");
      await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
      expect(f.turns()[0]!.params).toMatchObject({ approvalPolicy: axis ? "on-request" : "never" });
      if (axis) {
        const call = await ask(f);
        expect(broker).toHaveBeenCalledTimes(1);
        decide(f, call.id, false);
        expect((await call.reply).result.isError).toBe(true);
        await completedWithoutReset(f);
      } else {
        expect(JSON.stringify(await f.tool("request_session_reset", { mode: "new" }))).toContain("reserved");
        expect(broker).not.toHaveBeenCalled();
        expect(pending(f)).toHaveLength(0);
        expect(f.envelopes("state_change").some(e => e.state === "waiting_permission")).toBe(false);
        f.terminal();await vi.waitFor(() => expect(resets(f)).toHaveLength(1));
      }
      expect(f.host.bridgeToolApproval(null).next).toBe(axis ? "on-request" : "never");
    } finally { broker.mockRestore();await f.close(); }
  });

  it("does not log autonomous approval when the policy read abandons the turn", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const f = await cliAppFixture();
    const read = f.host.bridgeToolApproval.bind(f.host);
    const policy = vi.spyOn(f.host, "bridgeToolApproval").mockImplementation(token => {
      const result = read(token);
      f.host.close();
      return result;
    });
    try {
      await f.inbound(1, "first");await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
      const reply = await f.tool("request_session_reset", { mode: "new" }).catch(() => ({ closed: true }));
      expect(reply.closed === true || reply.result?.isError === true).toBe(true);
      expect(policy).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls.some(([text]) => String(text).includes("approved by the agent"))).toBe(false);
      expect(resets(f)).toHaveLength(0);
    } finally { policy.mockRestore();await f.close();stderr.mockRestore(); }
  });

  it.each([false, true])("strict approval respects operator allow=%s", async allow => {
    const f = await strict();
    try {
      const call = await ask(f);decide(f, call.id, allow);
      const reply = await call.reply;
      expect(reply.result.isError === true).toBe(!allow);
      expect(resets(f)).toHaveLength(0);
      f.terminal();await vi.waitFor(() => expect(f.envelopes("result")).toHaveLength(1));
      if (allow) await vi.waitFor(() => expect(resets(f)).toHaveLength(1));
      else { await f.drain();expect(resets(f)).toHaveLength(0); }
    } finally { await f.close(); }
  });

  it("untrusted turns also ask the operator", async () => {
    const f = await strict(undefined, "untrusted");
    try {
      const call = await ask(f);decide(f, call.id, false);
      expect((await call.reply).result.isError).toBe(true);
      await completedWithoutReset(f);
    } finally { await f.close(); }
  });

  it.each([false, true])("records actual wire approval on fresh/resume dispatch (resume=%s)", async resume => {
    const f = await cliAppFixture(true, "app-server", "legacy", {
      approvalAxis: true, ...(resume ? { resume: "thread" } : {}),
    });
    try {
      await select(f, 1, "untrusted");
      await f.inbound(1, "first");await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
      expect(f.sent.some(r => r.method === (resume ? "thread/resume" : "thread/start"))).toBe(true);
      expect(f.turns()[0]!.params).toMatchObject({ approvalPolicy: "untrusted" });
      expect(f.host.bridgeToolApproval(f.host.activeInterAgentTurnToken()).turn).toBe((f.turns()[0]!.params as any).approvalPolicy);
      await completedWithoutReset(f);
    } finally { await f.close(); }
  });

  it("a superseded preparation records only the retried dispatch", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const beforeDispatch = vi.fn(() => held);
    const f = await cliAppFixture(true, "app-server", "legacy", { approvalAxis: true, beforeDispatch });
    try {
      await select(f, 1, "never");
      await f.inbound(1, "first");await vi.waitFor(() => expect(beforeDispatch).toHaveBeenCalledTimes(1));
      expect(f.turns()).toHaveLength(0);
      expect(f.host.bridgeToolApproval(f.host.activeInterAgentTurnToken()).turn).toBeNull();
      await select(f, 2, "on-request");release();
      await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
      expect(beforeDispatch).toHaveBeenCalledTimes(2);
      expect(f.turns()[0]!.params).toMatchObject({ approvalPolicy: "on-request" });
      expect(f.host.bridgeToolApproval(f.host.activeInterAgentTurnToken()).turn).toBe((f.turns()[0]!.params as any).approvalPolicy);
      const call = await ask(f);decide(f, call.id, false);await call.reply;
      await completedWithoutReset(f);
    } finally { release();await f.close(); }
  });

  it("missing dispatch evidence during a live turn asks", async () => {
    // Drop the transport callback's evidence, not the accessor's answer.
    const f = await cliAppFixture(false, "app-server", "legacy", { omitDispatchedApproval: true });
    try {
      await f.inbound(1, "first");await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
      expect(f.host.activeInterAgentTurnToken()).not.toBeNull();
      expect(f.host.bridgeToolApproval(f.host.activeInterAgentTurnToken()).turn).toBeNull();
      const call = await ask(f);decide(f, call.id, false);await call.reply;
      await completedWithoutReset(f);
    } finally { await f.close(); }
  });

  it("broker timeout denies and a late allow reserves nothing", async () => {
    const f = await strict(100);
    try {
      const call = await ask(f);
      expect(JSON.stringify(await call.reply)).toContain("timed out");
      decide(f, call.id, true);await completedWithoutReset(f);
    } finally { await f.close(); }
  });

  it.each(["terminal", "interrupt", "bridge-close", "host-close", "eof"])("%s abandons a strict pending call", async ending => {
    const f = await strict();
    try {
      let socket!: Socket;
      const call = await ask(f, s => { socket = s; });
      if (ending === "terminal") f.terminal();
      if (ending === "interrupt") { f.permissionDecision(call.id, true);void f.host.interrupt(); }
      if (ending === "bridge-close") socket.destroy();
      if (ending === "host-close") f.host.close();
      if (ending === "eof") f.exit();
      const reply = await call.reply;
      expect(reply.closed === true || reply.result?.isError === true).toBe(true);
      decide(f, call.id, true);
      if (ending === "interrupt" || ending === "bridge-close") await completedWithoutReset(f);
      else { await f.drain();expect(resets(f)).toHaveLength(0); }
      if (ending === "terminal" || ending === "bridge-close") {
        await select(f, 2, "never");
        await f.inbound(2, "later");await vi.waitFor(() => expect(f.turns()).toHaveLength(2));
        f.terminal();await vi.waitFor(() => expect(f.envelopes("result")).toHaveLength(2));
        await f.drain();expect(resets(f)).toHaveLength(0);
      }
    } finally { await f.close(); }
  });

  it("a stricter next selection affects a never turn immediately", async () => {
    const f = await cliAppFixture(true, "app-server", "legacy", { approvalAxis: true });
    try {
      await select(f, 1, "never");
      await f.inbound(1, "first");await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
      await select(f, 2, "on-request");
      expect(f.host.bridgeToolApproval(f.host.activeInterAgentTurnToken()).turn).toBe("never");
      const call = await ask(f);decide(f, call.id, false);
      expect((await call.reply).result.isError).toBe(true);
      await completedWithoutReset(f);
    } finally { await f.close(); }
  });

  it("loosening a strict turn takes effect only on the next turn", async () => {
    const f = await strict();
    try {
      const old = f.host.activeInterAgentTurnToken();
      const captured = f.host.bridgeToolApproval(old);
      await select(f, 2, "never");
      const call = await ask(f);decide(f, call.id, false);
      expect((await call.reply).result.isError).toBe(true);
      await completedWithoutReset(f);
      await f.inbound(2, "second");await vi.waitFor(() => expect(f.turns()).toHaveLength(2));
      expect(f.turns()[1]!.params).toMatchObject({ approvalPolicy: "never" });
      expect(captured.turn).toBe("on-request");
      expect(f.host.bridgeToolApproval(old).turn).toBeNull();
      expect(f.host.bridgeToolApproval(f.host.activeInterAgentTurnToken()).turn).toBe("never");
      expect(JSON.stringify(await f.tool("request_session_reset", { mode: "new" }))).toContain("reserved");
      expect(pending(f)).toHaveLength(1);
      f.terminal();await vi.waitFor(() => expect(resets(f)).toHaveLength(1));
    } finally { await f.close(); }
  });

  it("blocked permission state asks even during a live never turn", async () => {
    const f = await cliAppFixture(true, "app-server", "legacy", { approvalAxis: true });
    try {
      await select(f, 1, "never");
      await f.inbound(1, "first");await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
      await select(f, 1, "never", true);
      const call = await ask(f);decide(f, call.id, false);
      expect((await call.reply).result.isError).toBe(true);
      await completedWithoutReset(f);
    } finally { await f.close(); }
  });

  it("calls outside a live turn cancel without consulting policy or broker", async () => {
    const f = await cliAppFixture();
    const broker = vi.spyOn(PermissionBroker.prototype, "decide");
    const policy = vi.spyOn(f.host, "bridgeToolApproval");
    try {
      await f.inbound(1, "first");await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
      f.terminal();await vi.waitFor(() => expect(f.finalized).toHaveLength(1));
      expect(JSON.stringify(await f.tool("request_session_reset", { mode: "new" }))).toContain("cancelled");
      expect(broker).not.toHaveBeenCalled();expect(policy).not.toHaveBeenCalled();
      expect(resets(f)).toHaveLength(0);
    } finally { broker.mockRestore();policy.mockRestore();await f.close(); }
  });

  it.each(["interrupt", "watchdog", "close"])("%s beats an autonomous reservation's already-produced terminal", async ending => {
    const f = await cliAppFixture();
    try {
      await f.inbound(1, "first");await vi.waitFor(() => expect(f.turns()).toHaveLength(1));
      expect(JSON.stringify(await f.tool("request_session_reset", { mode: "new" }))).toContain("reserved");
      const token = f.host.activeInterAgentTurnToken()!;
      f.terminal();
      if (ending === "interrupt") void f.host.interrupt();
      if (ending === "watchdog") f.host.requestInterruptForTurn(token);
      if (ending === "close") f.host.close();
      await vi.waitFor(() => expect(f.finalized.length).toBeGreaterThan(0));
      if (ending !== "close") {
        await vi.waitFor(() => expect(f.turns()).toHaveLength(2));
        f.terminal();await vi.waitFor(() => expect(f.finalized).toHaveLength(2));
      }
      if (ending === "close") await f.running;
      else await f.drain();
      expect(resets(f)).toHaveLength(0);
    } finally { await f.close(); }
  });
});
