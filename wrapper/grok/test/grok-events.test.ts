import "../../../scripts/test/fixtures/test-isolation.mjs";
import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { updateEvents } from "../src/grok/events.js";

function notification(update: SessionUpdate): SessionNotification {
  return { sessionId: "fixture-session", update };
}
describe("ACP update projection", () => {
  it("returns text and its state event without a per-chunk log", () => {
    expect(updateEvents(notification({
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fragment" },
    }))).toEqual({ text: "fragment", events: [{ kind: "assistant", blocks: ["text"] }] });
  });
  it("ignores non-text message content", () => {
    expect(updateEvents(notification({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "", mimeType: "image/png" },
    }))).toEqual({ events: [] });
  });
  it("keeps thought chunks as state events only", () => {
    expect(updateEvents(notification({
      sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private thought" },
    }))).toEqual({ events: [{ kind: "assistant", blocks: ["thinking"] }] });
  });
  it("projects the non-assistant tool log", () => {
    expect(updateEvents(notification({
      sessionUpdate: "tool_call", toolCallId: "tool", title: "probe", status: "in_progress",
    }))).toEqual({
      events: [{ kind: "assistant", blocks: ["tool_use"], toolUseIds: ["tool"] }],
      log: { kind: "tool_use", tool_name: "probe" },
    });
  });
  it.each(["completed", "failed"] as const)(
    "projects a %s tool update without text or a log", status => {
      expect(updateEvents(notification({
        sessionUpdate: "tool_call_update", toolCallId: "tool", status,
      }))).toEqual({ events: [{ kind: "tool_result", toolUseIds: ["tool"] }] });
    },
  );
  it("does not project a log from an in-progress tool update", () => {
    expect(updateEvents(notification({
      sessionUpdate: "tool_call_update", toolCallId: "tool", status: "in_progress",
    }))).toEqual({ events: [] });
  });
});
