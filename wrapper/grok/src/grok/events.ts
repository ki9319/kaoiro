import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AdapterEvent, LogPayload } from "@kaoiro/agent-common";

export function updateEvents(notification: SessionNotification): {
  events: AdapterEvent[];
  log?: LogPayload;
  text?: string;
} {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") {
        return {
          events: [{ kind: "assistant", blocks: ["text"] }],
          log: { kind: "assistant", text: update.content.text },
          text: update.content.text,
        };
      }
      break;
    case "agent_thought_chunk":
      return { events: [{ kind: "assistant", blocks: ["thinking"] }] };
    case "tool_call":
      return {
        events: [
          {
            kind: "assistant",
            blocks: ["tool_use"],
            toolUseIds: [update.toolCallId],
          },
        ],
        log: { kind: "tool_use", tool_name: update.title },
      };
    case "tool_call_update":
      if (update.status === "completed" || update.status === "failed") {
        return {
          events: [{ kind: "tool_result", toolUseIds: [update.toolCallId] }],
        };
      }
      break;
  }
  return { events: [] };
}

export function cancellationKind(meta: unknown): "rejected" | "interrupted" {
  const value = meta as Record<string, unknown> | undefined;
  return value?.cancellationCategory === "PermissionRejected"
    ? "rejected"
    : "interrupted";
}
