import { expect, it } from "vitest";
import { checkToolRoundTrip, type ToolEvidence } from "./acceptance.js";
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
