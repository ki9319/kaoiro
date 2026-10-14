import { Readable, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";

export interface WireMetadata {
  direction: "in" | "out";
  method?: string;
  variant?: string;
  vendor_kind?: string;
  prompt_id?: string;
  request_id?: string;
  hook_event?: string;
  sdk_diagnostic?: boolean;
  oversized_lines?: number;
}
type Observer = (metadata: WireMetadata) => void;
const observers = new Set<Observer>();
let restoreConsole: (() => void) | undefined;

function safeName(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w./-]{1,120}$/.test(value)
    ? value
    : undefined;
}

function filterSdkConsole(observer: Observer): () => void {
  observers.add(observer);
  if (!restoreConsole) {
    const error = console.error;
    const warn = console.warn;
    console.error = (...args: unknown[]) => {
      const prefix = args[0];
      if (
        typeof prefix === "string" &&
        (prefix === "Invalid message" ||
          prefix === "Error handling notification" ||
          prefix === "Got response to unknown request" ||
          /^ACP connection .* router stopped unexpectedly:/.test(prefix))
      ) {
        for (const onMetadata of observers) {
          onMetadata({ direction: "in", sdk_diagnostic: true });
        }
        return;
      }
      error(...args);
    };
    console.warn = (...args: unknown[]) => {
      if (
        typeof args[0] === "string" &&
        /^Closing ACP connection /.test(args[0])
      ) {
        for (const onMetadata of observers) {
          onMetadata({ direction: "in", sdk_diagnostic: true });
        }
      } else warn(...args);
    };
    restoreConsole = () => {
      console.error = error;
      console.warn = warn;
    };
  }
  return () => {
    observers.delete(observer);
    if (observers.size === 0) {
      restoreConsole?.();
      restoreConsole = undefined;
    }
  };
}

export function metadataTee(direction: "in" | "out", observer: Observer) {
  let buffer = "";
  let bytes = 0;
  let oversized = false;
  const decoder = new TextDecoder();
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      let offset = 0;
      while (offset < text.length) {
        const newline = text.indexOf("\n", offset);
        const end = newline < 0 ? text.length : newline;
        if (!oversized) {
          const part = text.slice(offset, end);
          bytes += Buffer.byteLength(part);
          if (bytes > 4 * 1024 * 1024) {
            buffer = "";
            oversized = true;
            try {
              observer({ direction, oversized_lines: 1 });
            } catch {
              /* Diagnostics must not interrupt the protocol transport. */
            }
          } else buffer += part;
        }
        if (newline < 0) break;
        const line = oversized ? "" : buffer;
        buffer = "";
        bytes = 0;
        oversized = false;
        offset = newline + 1;
        try {
          const msg = JSON.parse(line);
          if (!msg || typeof msg !== "object") continue;
          const note = msg.params?.notification;
          const update = msg.params?.update;
          const vendorKind = msg.method?.startsWith("_x.ai/")
            ? (update?.sessionUpdate ?? note?.type)
            : undefined;
          const hookEvent =
            update?.event_name ?? note?.event ?? note?.hook_event;
          const promptId = msg.result?._meta?.promptId ?? update?.prompt_id;
          observer({
            direction,
            ...(safeName(msg.method) ? { method: safeName(msg.method)! } : {}),
            ...(safeName(msg.params?.update?.sessionUpdate)
              ? { variant: safeName(msg.params.update.sessionUpdate)! }
              : {}),
            ...(safeName(vendorKind)
              ? { vendor_kind: safeName(vendorKind)! }
              : {}),
            ...(safeName(promptId) ? { prompt_id: safeName(promptId)! } : {}),
            ...(safeName(msg.result?._meta?.requestId)
              ? { request_id: safeName(msg.result._meta.requestId)! }
              : {}),
            ...(safeName(hookEvent)
              ? { hook_event: safeName(hookEvent)! }
              : {}),
          });
        } catch {
          /* Invalid JSON is handled by the SDK, without body logging. */
        }
      }
      controller.enqueue(chunk);
    },
  });
}

export interface AcpHandlers {
  update: (notification: acp.SessionNotification) => void;
  vendor: (notification: Record<string, unknown>) => void;
  permission: (
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<acp.RequestPermissionResponse>;
  metadata: Observer;
}

export function connectAcp(
  child: ChildProcessWithoutNullStreams,
  handlers: AcpHandlers,
) {
  const release = filterSdkConsole(handlers.metadata);
  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const output = metadataTee("out", handlers.metadata);
  void output.readable.pipeTo(Writable.toWeb(child.stdin)).catch(() => {});
  const stream = acp.ndJsonStream(
    output.writable,
    input.pipeThrough(metadataTee("in", handlers.metadata)),
  );
  const connection = acp
    .client({ name: "kaoiro" })
    .onNotification(acp.methods.client.session.update, (ctx) =>
      handlers.update(ctx.params),
    )
    .onNotification(
      "_x.ai/session_notification",
      (p) => p as Record<string, unknown>,
      (ctx) => handlers.vendor(ctx.params),
    )
    .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
      handlers.permission(ctx.params, ctx.signal),
    )
    .connect(stream);
  void connection.closed.finally(release).catch(() => {});
  return connection;
}
