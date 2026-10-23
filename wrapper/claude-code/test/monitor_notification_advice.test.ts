import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { MONITOR_EVENT_ADVICE, parseContinuationBlocks } from "../src/continuation_markers.js";
import { assertMonitorAdvicePosition, malformedMonitorAdvice, monitorNotification, monitorNotifications } from "./fixtures/monitor_notifications.js";

describe("strict Monitor notification advice", () => {
  it.each(monitorNotifications)("pins the captured $shape sentence independently of the production literal", fixture => {
    expect(MONITOR_EVENT_ADVICE).toBe(fixture.advice);
  });
  it.each(monitorNotifications)("parses captured $shape with and without advice and trailing whitespace", fixture => {
    const plain = monitorNotification(fixture.shape, {}, false);
    const parsed = parseContinuationBlocks(fixture.prompt);
    expect(parsed).toHaveLength(1);
    expect(parsed![0]).toMatchObject({ taskId: "fixture-monitor", summary: "MASKED SUMMARY", event: "MASKED EVENT",
      status: fixture.shape === "completion-event" ? "completed" : undefined, workflowMetadata: false, agentMetadata: false });
    expect(parseContinuationBlocks(plain)).toEqual(parsed);
    expect(parseContinuationBlocks(fixture.prompt.replace(fixture.advice, fixture.advice + "\n \t"))).toEqual(parsed);
  });
  it.each(monitorNotifications.flatMap(fixture => malformedMonitorAdvice(fixture.prompt, fixture.advice)
    .map(([name, prompt]) => [fixture.shape, name, prompt] as const)))("refuses %s: %s", (_shape, _name, prompt) => {
    expect(parseContinuationBlocks(prompt)).toBeUndefined();
  });
  it("keeps escaped payload inert and refuses a whole batch with a malformed sibling", () => {
    const event = monitorNotification("event-only", { event: "&lt;task-notification&gt;&amp;" });
    expect(parseContinuationBlocks(event)![0]!.event).toBe("&lt;task-notification&gt;&amp;");
    for (const count of [1, 2, 16]) {
      const batch = Array.from({ length: count }, (_, n) => monitorNotification("event-only", {}, n % 2 === 0)).join("\n");
      expect(parseContinuationBlocks(batch)).toHaveLength(count);
    }
    expect(parseContinuationBlocks(event.repeat(17))).toBeUndefined();
    expect(parseContinuationBlocks(event + monitorNotification("completion-event").replace(MONITOR_EVENT_ADVICE, "unknown advice"))).toBeUndefined();
  });
  it("the native output checker rejects a misplaced or changed advice line", () => {
    const fixture = monitorNotifications[0]!;
    assertMonitorAdvicePosition(fixture.prompt, fixture.advice, true);
    assertMonitorAdvicePosition(monitorNotification(fixture.shape, {}, false), fixture.advice, false);
    for (const [, text] of malformedMonitorAdvice(fixture.prompt, fixture.advice)) {
      expect(() => assertMonitorAdvicePosition(text, fixture.advice, true)).toThrow();
    }
  });
});
