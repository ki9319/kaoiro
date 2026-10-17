import { createConnection } from "node:net";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { InterAgentTool, type Envelope, type ToolResult } from "@kaoiro/agent-common";
import { ToolHost } from "../src/toolhost.js";

const config = { agent_id: "self", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: "ws://localhost" };
const args = { to: "peer", conversation_id: "c", kind: "response", body: "reply" };
const input = { version: "0", agent_id: "peer", persona: config.persona, display_name: "P", ts: "2026-10-18T00:00:00Z",
  type: "inter_agent_message", state: "thinking", payload: { to: "self", conversation_id: "c", turn_number: 1, kind: "response", body: "input" }, ext: {} } as Envelope;
function jsonParts(result: ToolResult): Record<string, any>[] {
  return result.content.flatMap(part => { try { return [JSON.parse(part.text)]; } catch { return []; } });
}
async function call(host: ToolHost, fields: Record<string, unknown> = {}) {
  const socket = createConnection(host.socketPath); socket.setEncoding("utf8");
  try {
    await once(socket, "connect");
    const response = new Promise<Record<string, any>>((resolve, reject) => {
      let buffer = "";
      socket.on("error", reject);
      socket.on("data", chunk => { buffer += chunk; if (buffer.includes("\n")) resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n")))); });
    });
    socket.write(JSON.stringify({ id: 1, method: "call_tool", name: "send_to_agent", input: { ...args, ...fields } }) + "\n");
    return await response;
  } finally { socket.destroy(); }
}
function fixture() {
  const wire: number[] = [];
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1",
    sendInterAgent: async envelope => { wire.push(envelope.payload.in_reply_to as number); return { kind: "accepted", stamp: null }; } });
  tool.prepareReplyInput("T", [input]); tool.beginReplyInput("T");
  const original = tool.replyBasis.prepare({ token: "T" }, "c", "peer", 4)!; original.activate();
  return { tool, wire, fields: { in_reply_to: 4, reply_ticket: original.authorization.reply_ticket } };
}

it("returns a live same-turn follow-up through the real exec ToolHost socket", async () => {
  const f = fixture();
  const host = await ToolHost.listen(f.tool.descriptors(), { resolveOrigin: () => ({ token: "T" }) });
  try {
    const response = await call(host, f.fields);
    const next = jsonParts(response.result).find(part => part.reply_authorization_source === "accepted_reply")!.reply_authorization;
    expect(f.tool.replyBasis.hasMatchingAuthorization({ token: "T" }, "c", "peer", 4)).toBe(true);
    expect((await call(host, { in_reply_to: 4, reply_ticket: next.reply_ticket, body: "follow-up" })).result.isError).not.toBe(true);
    expect(f.wire).toEqual([4, 4]);
    expect(f.tool.replyBasis.capture({ token: "T" }, "c", "peer")).toMatchObject({ basis: 1 });
  } finally { host.close(); f.tool.endReplyInput("T"); }
});

it("serializes optional metadata after preparation rather than sending a cached string", async () => {
  const f = fixture(), descriptors = f.tool.descriptors();
  const send = descriptors.find(descriptor => descriptor.name === "send_to_agent")!, handler = send.handler;
  send.handler = async (fields, context) => {
    const result = await handler(fields, context);
    f.tool.replyBasis.forget("c");
    return result;
  };
  const host = await ToolHost.listen(descriptors, { resolveOrigin: () => ({ token: "T" }) });
  try {
    const response = await call(host, f.fields);
    expect(response.result.content[0].text).toContain("sent to peer");
    expect(jsonParts(response.result).some(part => part.reply_authorization_source === "accepted_reply")).toBe(false);
    expect(jsonParts(response.result).some(part => part.followup_authorization_unavailable === true)).toBe(true);
  } finally { host.close(); f.tool.endReplyInput("T"); }
});

it("a bridge call held in origin resolution keeps its old omitted-field basis", async () => {
  const f = fixture();
  let release!: () => void, enter!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const host = await ToolHost.listen(f.tool.descriptors(), { resolveOrigin: async metadata => {
    if (metadata === "hold") { enter(); await held; }
    return { token: "T" };
  } });
  const oldSocket = createConnection(host.socketPath); oldSocket.setEncoding("utf8");
  try {
    await once(oldSocket, "connect");
    const response = once(oldSocket, "data");
    oldSocket.write(JSON.stringify({ id: 2, method: "call_tool", name: "send_to_agent", metadata: "hold", input: args }) + "\n");
    await entered;
    const accepted = await call(host, f.fields);
    expect(jsonParts(accepted.result).some(part => part.reply_authorization_source === "accepted_reply")).toBe(true);
    release(); await response;
    expect(f.wire).toEqual([4, 1]);
  } finally { release(); oldSocket.destroy(); host.close(); f.tool.endReplyInput("T"); }
});

it("discards follow-up authorization when the bridge disconnects before result handoff", async () => {
  const f = fixture(), descriptors = f.tool.descriptors();
  const send = descriptors.find(descriptor => descriptor.name === "send_to_agent")!, handler = send.handler;
  let release!: () => void, enter!: () => void, disconnected!: () => void, result!: ToolResult;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const serverClosed = new Promise<void>(resolve => { disconnected = resolve; });
  send.handler = async (fields, context) => {
    context!.signal!.addEventListener("abort", disconnected, { once: true });
    result = await handler(fields, context); enter(); await held; return result;
  };
  const host = await ToolHost.listen(descriptors, { resolveOrigin: () => ({ token: "T" }) });
  const socket = createConnection(host.socketPath);
  try {
    await once(socket, "connect");
    socket.write(JSON.stringify({ id: 1, method: "call_tool", name: "send_to_agent", input: { ...args, ...f.fields } }) + "\n");
    await entered;
    const next = jsonParts(result).find(part => part.reply_authorization_source === "accepted_reply")!.reply_authorization;
    socket.destroy(); await serverClosed; release();
    await vi.waitFor(() => expect(f.tool.replyBasis.ticketCountForTurn("T")).toBe(1));
    expect(f.tool.replyBasis.capture({ token: "T" }, "c", "peer", 4, next.reply_ticket)).toBe("invalid_reply_ticket");
    expect(f.wire).toEqual([4]);
  } finally { release(); socket.destroy(); host.close(); f.tool.endReplyInput("T"); }
});
