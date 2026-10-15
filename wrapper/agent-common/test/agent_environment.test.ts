import { expect, it } from "vitest";
import { AGENT_MARKER_ENV, withAgentMarker } from "../src/agent_environment.js";

it.each([undefined, "", "1", "legacy"])("marks a copied environment with inherited marker %s", marker => {
  const inherited = Object.freeze({ KEEP: "yes", EMPTY: "", OMIT: undefined,
    ...(marker === undefined ? {} : { KAOIRO_AGENT: marker }) });
  expect(withAgentMarker(inherited)).toEqual({ KEEP: "yes", EMPTY: "", KAOIRO_AGENT: "1" });
  expect(inherited).toEqual({ KEEP: "yes", EMPTY: "", OMIT: undefined,
    ...(marker === undefined ? {} : { KAOIRO_AGENT: marker }) });
});

it("exposes one immutable marker map for native shell policies", () => {
  expect(AGENT_MARKER_ENV).toEqual({ KAOIRO_AGENT: "1" });
  expect(Object.isFrozen(AGENT_MARKER_ENV)).toBe(true);
});
