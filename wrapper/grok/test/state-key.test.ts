import { describe, expect, it } from "vitest";
import type { Envelope } from "@kaoiro/agent-common";
import { canonicalJson, stateChangeKey } from "../src/grok/state_key.js";

const envelope = (over: Partial<Envelope> = {}): Envelope => ({
  version: "0", agent_id: "a", persona: { id: "p", name: "P", sprite_set: "s" },
  display_name: "Name", ts: "2026-10-15T00:00:00.000Z", type: "state_change",
  state: "thinking", payload: {}, ext: { engine: "grok", permission: { sandbox: "read-only" } },
  ...over,
});
describe("canonicalJson", () => {
  it("ignores key order at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, { z: 1, y: 2 }] } }))
      .toBe(canonicalJson({ a: { c: [1, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  });
  it("gives the same string for an object built with conditional keys in either order", () => {
    const build = (gate: boolean, control: boolean) => ({
      engine: "grok",
      ...(control ? { permission_control: { revision: 1 } } : {}),
      ...(gate ? { permission_gate: { reason: "x" } } : {}),
    });
    const reversed = { permission_gate: { reason: "x" }, permission_control: { revision: 1 }, engine: "grok" };
    expect(canonicalJson(build(true, true))).toBe(canonicalJson(reversed));
  });
  it("keeps array order, and tells different values apart", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson({ a: "1" })).not.toBe(canonicalJson({ a: 1 }));
  });
  it("drops undefined keys and prints null for an undefined array item", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson([undefined])).toBe("[null]");
  });
});
describe("stateChangeKey", () => {
  it("is the same when only the timestamp differs", () => {
    expect(stateChangeKey(envelope({ ts: "2026-10-15T01:00:00.000Z" }))).toBe(stateChangeKey(envelope()));
  });
  it("is the same when only the ext key order differs", () => {
    expect(stateChangeKey(envelope({ ext: { permission: { sandbox: "read-only" }, engine: "grok" } })))
      .toBe(stateChangeKey(envelope()));
  });
  it.each([
    ["the state", { state: "done" as const }],
    ["the ext", { ext: { engine: "grok", permission: { sandbox: "workspace-write" } } }],
    ["the display name", { display_name: "Other" }],
  ])("differs when %s differs", (_label, over) => {
    expect(stateChangeKey(envelope(over))).not.toBe(stateChangeKey(envelope()));
  });
});
