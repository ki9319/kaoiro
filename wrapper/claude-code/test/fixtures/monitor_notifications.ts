import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

// Extracted from genuine SDK 0.3.306 / CLI 2.1.306 user/system notifications.
// Only task/call ids, output path, summary and event scalars were replaced.
export const monitorNotifications = JSON.parse(readFileSync(new URL("./monitor_notifications.json", import.meta.url), "utf8")) as Array<{
  shape: "completion-event" | "event-only"; cli_version: string; prompt: string; advice: string;
}>;

export function monitorNotification(shape: string, fields: Record<string, string> = {}, advice = true): string {
  const fixture = monitorNotifications.find(value => value.shape === shape)!;
  let text = fixture.prompt;
  for (const [tag, value] of Object.entries(fields)) {
    text = text.replace(new RegExp(`<${tag}>[^<]*</${tag}>`), () => `<${tag}>${value}</${tag}>`);
  }
  return advice ? text : text.replace(fixture.advice + "\n", "");
}

export function malformedMonitorAdvice(text: string, advice: string): Array<[string, string]> {
  const without = text.replace(advice + "\n", "");
  return [
    ["one character changed", text.replace(advice, advice.replace("If", "if"))],
    ["outside the block", without + "\n" + advice],
    ["two copies", text.replace(advice, advice + "\n" + advice)],
    ["non-whitespace suffix", text.replace(advice, advice + "x")],
    ["without event", text.replace(/<event>[^<]*<\/event>\n/, "")],
    ["before event", without.replace("<event>", advice + "\n<event>")],
    ["marker in the sentence", text.replace(advice, advice + " [kaoiro-continuation:x]")],
    ["tagged element after the sentence", text.replace(advice, advice + "\n<result>unexpected</result>")],
  ];
}

export function assertMonitorAdvicePosition(block: string, advice: string, present: boolean): void {
  const end = block.indexOf("</event>");
  assert.notEqual(end, -1, "native Monitor notification must contain an event");
  assert.equal(block.slice(end + "</event>".length).trim(), present ? advice + "\n</task-notification>" : "</task-notification>");
}
