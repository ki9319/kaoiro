import { expect, it, vi } from "vitest";
import { InterAgentTool, ToolOrigins, type Envelope, type ReplyAuthorization } from "@kaoiro/agent-common";
import { buildKaoiroMcpServer } from "../src/inter_agent_sdk.js";

const config = { agent_id: "self", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: "ws://localhost" };
const args = { to: "peer", conversation_id: "c", kind: "response", body: "reply" };
const accepted = { kind: "accepted" as const, stamp: null };
const stale = { kind: "rejected" as const, reason: "stale_reply_basis", details: { expected_peer_turn: 4 } };
function input(n: number): Envelope {
  return { version: "0", agent_id: "peer", persona: config.persona, display_name: "P", ts: "2026-10-18T00:00:00Z",
    type: "inter_agent_message", state: "thinking", payload: { to: "self", conversation_id: "c", turn_number: n,
      kind: "response", body: `input ${n}` }, ext: {} };
}
function jsonParts(result: any): any[] {
  return result.content.flatMap((part: { text: string }) => { try { return [JSON.parse(part.text)]; } catch { return []; } });
}
async function connect(tool: InterAgentTool, resolve: (id: unknown) => Promise<{ token: string; signal?: AbortSignal } | undefined>) {
  const sdk = buildKaoiroMcpServer(tool, [], resolve);
  type Transport = Parameters<typeof sdk.instance.connect>[0];
  const responses: Array<Record<string, any>> = [];
  const transport: Transport = { start: async () => {}, close: async () => {}, send: async message => { responses.push(message as Record<string, any>); } };
  await sdk.instance.connect(transport);
  return { sdk, call: async (id: number, fields: Record<string, unknown> = {}) => {
    transport.onmessage!({ jsonrpc: "2.0", id, method: "tools/call", params: {
      name: "send_to_agent", arguments: { ...args, ...fields }, _meta: { "claudecode/toolUseId": `tool-${id}` },
    } });
    await vi.waitFor(() => expect(responses.some(response => response.id === id)).toBe(true));
    return responses.find(response => response.id === id)!.result;
  } };
}

it("hands off a fresh same-turn authorization through real SDK MCP registration", async () => {
  const origins = new ToolOrigins(); origins.begin("T");
  const wire: number[] = [];
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1",
    claimRecovery: () => wire.length === 1 ? { envelopes: [input(4)], commit: vi.fn(), rollback: vi.fn() } : undefined,
    sendInterAgent: async envelope => { wire.push(envelope.payload.in_reply_to as number); return [1, 3].includes(wire.length) ? stale : accepted; },
  });
  tool.prepareReplyInput("T", [input(1)]); tool.beginReplyInput("T");
  const rpc = await connect(tool, id => origins.resolve(id));
  try {
    origins.observe("tool-1");
    const original: ReplyAuthorization = jsonParts(await rpc.call(1))[0].reply_authorization;
    origins.observe("tool-2");
    const result = await rpc.call(2, { in_reply_to: original.in_reply_to, reply_ticket: original.reply_ticket });
    const next: ReplyAuthorization = jsonParts(result).find(part => part.reply_authorization_source === "accepted_reply").reply_authorization;
    expect(next.reply_ticket).not.toBe(original.reply_ticket);
    expect(tool.replyBasis.hasMatchingAuthorization({ token: "T" }, "c", "peer", 4)).toBe(true);
    origins.observe("tool-3");
    expect(jsonParts(await rpc.call(3))[0].guidance).toContain("already handed off");
    origins.observe("tool-4");
    expect((await rpc.call(4, { body: "follow-up", in_reply_to: next.in_reply_to, reply_ticket: next.reply_ticket })).isError).not.toBe(true);
    expect(wire).toEqual([1, 4, 1, 4]);
  } finally { await rpc.sdk.instance.close(); tool.endReplyInput("T"); }
});

it("a call awaiting its real SDK origin cannot borrow the accepted reply's input", async () => {
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wire: number[] = [];
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1",
    sendInterAgent: async envelope => { wire.push(envelope.payload.in_reply_to as number); return wire.length === 1 ? accepted : stale; } });
  tool.prepareReplyInput("T", [input(1)]); tool.beginReplyInput("T");
  const lease = tool.replyBasis.prepare({ token: "T" }, "c", "peer", 4)!; lease.activate();
  const rpc = await connect(tool, async id => { if (id === "tool-1") { entered(); await held; } return { token: "T" }; });
  try {
    const old = rpc.call(1); await started;
    const result = await rpc.call(2, { in_reply_to: 4, reply_ticket: lease.authorization.reply_ticket });
    expect(jsonParts(result).some(part => part.reply_authorization_source === "accepted_reply")).toBe(true);
    release(); expect((await old).isError).toBe(true);
    expect(wire).toEqual([4, 1]);
  } finally { release(); await rpc.sdk.instance.close(); tool.endReplyInput("T"); }
});

it("prepares optional metadata before every real SDK serialization", async () => {
  const serializations: boolean[] = [];
  const tool = new InterAgentTool({ config, getState: () => "thinking", send: () => {}, replyBasisMode: () => "v1", sendInterAgent: async () => accepted });
  tool.prepareReplyInput("T", [input(1)]); tool.beginReplyInput("T");
  const lease = tool.replyBasis.prepare({ token: "T" }, "c", "peer", 4)!; lease.activate();
  const descriptors = tool.descriptors(), send = descriptors.find(descriptor => descriptor.name === "send_to_agent")!;
  const handler = send.handler;
  send.handler = async (fields, context) => {
    const result = await handler(fields, context);
    tool.replyBasis.forget("c");
    Object.defineProperty(result, "toJSON", { value: () => {
      serializations.push(jsonParts(result).some(part => part.reply_authorization_source === "accepted_reply"));
      return { content: result.content, ...(result.isError === undefined ? {} : { isError: result.isError }) };
    } });
    return result;
  };
  vi.spyOn(tool, "descriptors").mockReturnValue(descriptors);
  const rpc = await connect(tool, async () => ({ token: "T" }));
  try {
    const result = await rpc.call(1, { in_reply_to: 4, reply_ticket: lease.authorization.reply_ticket });
    expect(result.content[0].text).toContain("sent to peer");
    expect(jsonParts(result).some(part => part.followup_authorization_unavailable === true)).toBe(true);
    expect(serializations.length).toBeGreaterThan(0);
    expect(serializations).not.toContain(true);
  } finally { await rpc.sdk.instance.close(); tool.endReplyInput("T"); vi.restoreAllMocks(); }
});
