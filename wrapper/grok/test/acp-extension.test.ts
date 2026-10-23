import "../../../scripts/test/fixtures/test-isolation.mjs";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  connectAcp,
  metadataTee,
  notification,
  type AcpExtension,
  type WireMetadata,
} from "../src/acp/connection.js";
import { AcpSession } from "../src/acp/session.js";

function fakeChild() {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  stdin.resume();
  return {
    child: { stdout, stdin } as unknown as ChildProcessWithoutNullStreams,
    emit: (message: unknown) =>
      stdout.write(JSON.stringify({ jsonrpc: "2.0", ...(message as object) }) + "\n"),
    end: () => {
      stdout.end();
      stdin.end();
    },
  };
}
const handlers = () => ({
  update: vi.fn(),
  permission: vi.fn(),
  metadata: vi.fn(),
});
const sessionUpdate = {
  method: "session/update",
  params: {
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    },
  },
};

describe("connectAcp without an extension", () => {
  it("registers ACP methods only and adds no vendor metadata", async () => {
    const { child, emit, end } = fakeChild();
    const h = handlers();
    const connection = connectAcp(child, h);
    emit({
      method: "_x.example/notice",
      params: { update: { sessionUpdate: "turn_completed", prompt_id: "p" } },
    });
    emit(sessionUpdate);
    await vi.waitFor(() => expect(h.update).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.metadata).toHaveBeenCalledTimes(2));
    expect(h.metadata.mock.calls.map(([m]) => m)).toEqual([
      { direction: "in", method: "_x.example/notice", variant: "turn_completed" },
      { direction: "in", method: "session/update", variant: "agent_message_chunk" },
    ]);
    connection.close();
    end();
  });
});

describe("connectAcp with an extension", () => {
  it("routes an extra notification and merges vendor fields in order", async () => {
    const { child, emit, end } = fakeChild();
    const h = handlers();
    const seen: unknown[] = [];
    const extension: AcpExtension<WireMetadata & { vendor_id?: string }> = {
      notifications: [
        notification(
          "_x.example/notice",
          (params) => ({ parsed: params }),
          (value) => seen.push(value),
        ),
      ],
      wireFields: (message) =>
        String(message.method).startsWith("_x.example/")
          ? { vendor_id: "notice" }
          : {},
    };
    const connection = connectAcp(child, h, extension);
    emit({ method: "_x.example/notice", params: { n: 1 } });
    await vi.waitFor(() => expect(seen).toEqual([{ parsed: { n: 1 } }]));
    await vi.waitFor(() => expect(h.metadata).toHaveBeenCalledTimes(1));
    expect(Object.keys(h.metadata.mock.calls[0]![0])).toEqual([
      "direction",
      "method",
      "vendor_id",
    ]);
    connection.close();
    end();
  });

  it.each([
    ["a name without the leading underscore", "vendor/thing"],
    ["an ACP method name", "session/update"],
  ])("rejects %s", (_label, method) => {
    const { child, end } = fakeChild();
    expect(() =>
      connectAcp(child, handlers(), {
        notifications: [notification(method, (p) => p, () => {})],
      }),
    ).toThrow(/must start with "_"/);
    end();
  });

  it("accepts an underscore-prefixed name", () => {
    const { child, end } = fakeChild();
    const connection = connectAcp(child, handlers(), {
      notifications: [notification("_x.example/ok", (p) => p, () => {})],
    });
    connection.close();
    end();
  });
});

describe("metadataTee with a failing vendor extractor", () => {
  it("drops that line's metadata and keeps the transport and later lines", async () => {
    const seen: WireMetadata[] = [];
    const tee = metadataTee(
      "in",
      (m) => seen.push(m),
      (message) => {
        if (message.method === "boom") throw new Error("extractor failed");
        return {};
      },
    );
    const input = Buffer.from(
      JSON.stringify({ method: "boom" }) + "\n" +
        JSON.stringify({ method: "fine" }) + "\n",
    );
    const reader = tee.readable.getReader();
    const writer = tee.writable.getWriter();
    const chunks: Uint8Array[] = [];
    const read = (async () => {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        chunks.push(result.value);
      }
    })();
    await writer.write(input);
    await writer.close();
    await read;
    expect(Buffer.concat(chunks).equals(input)).toBe(true);
    expect(seen).toEqual([{ direction: "in", method: "fine" }]);
  });
});

describe("AcpSession.open", () => {
  function session() {
    const request = vi.fn(async (method: string) =>
      method === "session/new" ? { sessionId: "s1" } : {},
    );
    const acpSession = new AcpSession({
      agent: { request },
    } as unknown as ConstructorParameters<typeof AcpSession>[0]);
    return { acpSession, request };
  }
  it("sends the injected value as session/new _meta", async () => {
    const { acpSession, request } = session();
    await acpSession.open("/work", [], { vendor: "value" });
    expect(request).toHaveBeenLastCalledWith("session/new", {
      cwd: "/work",
      mcpServers: [],
      _meta: { vendor: "value" },
    });
  });
  it("sends no _meta when nothing is injected", async () => {
    const { acpSession, request } = session();
    await acpSession.open("/work", []);
    expect(request).toHaveBeenLastCalledWith("session/new", {
      cwd: "/work",
      mcpServers: [],
    });
  });
});
