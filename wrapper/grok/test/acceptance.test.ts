import "../../../scripts/test/fixtures/test-isolation.mjs";
import { expect, it } from "vitest";
import {
  checkForegroundTool,
  checkToolRoundTrip,
  type ToolEvidence,
} from "./acceptance.js";
it("rejects invalid tool round-trip evidence", () => {
  const evidence: ToolEvidence = {
    calls: [{ name: "list_agents", input: {}, isError: false }],
    text: "marker",
  };
  checkToolRoundTrip(evidence, "list_agents", {}, "marker");
  for (const broken of [
    { ...evidence, calls: [] },
    {
      ...evidence,
      calls: [{ name: "list_agents", input: { wrong: true }, isError: false }],
    },
    { ...evidence, calls: [{ name: "list_agents", input: {}, isError: true }] },
    { ...evidence, text: "missing" },
  ]) {
    expect(() =>
      checkToolRoundTrip(broken, "list_agents", {}, "marker"),
    ).toThrow();
  }
});
it("rejects altered foreground tool arguments", () => {
  const command = "sleep 120";
  const input = { command, block_until_ms: 120_000, is_background: false };
  checkForegroundTool(input, command);
  for (const broken of [
    undefined,
    { ...input, command: "sleep 1" },
    { ...input, block_until_ms: 0 },
    { ...input, is_background: true },
  ]) {
    expect(() => checkForegroundTool(broken, command)).toThrow();
  }
});
