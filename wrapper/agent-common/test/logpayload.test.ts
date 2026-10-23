import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { MAX_LOG_BYTES, logEntryToPayload } from "../src/logpayload.js";

describe("logEntryToPayload (issue #624)", () => {
  it("clips multi-byte assistant text at a character boundary within MAX_LOG_BYTES", () => {
    const payload = logEntryToPayload(
      { kind: "assistant", text: "あ".repeat(7000) },
      new Map(),
    );
    expect(payload.kind).toBe("assistant");
    expect(payload.truncated).toBe(true);
    const text = payload.text ?? "";
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(text).not.toContain("�");
  });

  it("clips multi-byte tool output the same way", () => {
    const payload = logEntryToPayload(
      { kind: "tool_result", output: `ab${"\u{1F600}".repeat(5000)}` },
      new Map(),
    );
    const output = payload.output ?? "";
    expect(payload.truncated).toBe(true);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(output).not.toContain("�");
  });
});
