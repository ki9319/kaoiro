import { describe, expect, expectTypeOf, it } from "vitest";
import fixture from "../../protocol/fixtures/session-lifecycle-query.json" with { type: "json" };
import type { SessionLifecycleEventKind } from "../../protocol/src/index";
import { parseSessionLifecycleReply, SESSION_LIFECYCLE_KINDS } from "../src/lib/protocol";

const at = "2026-01-01T00:00:00Z";
const normal = (kind = "compacting", fields: Record<string, unknown> = {}) => ({ kind, at, ...fields });
const parse = (value: unknown) => parseSessionLifecycleReply({ events: [value] }).events[0];
const director = { origin: "director", requested_by: { kind: "agent", id: "host-a.director" }, work_id: "wrk_active" };
expectTypeOf<typeof SESSION_LIFECYCLE_KINDS[number]>().toEqualTypeOf<SessionLifecycleEventKind>();

describe("session lifecycle display parser", () => {
  it.each(Object.entries(fixture).filter(([name]) => name !== "viewer"))("reads actual server fixture %s without unreadable rows", (_name, reply) => {
    const result = parseSessionLifecycleReply(reply);
    expect(result.incomplete).toBe(false);
    expect(result.events).toHaveLength((reply as { events: unknown[] }).events.length);
    expect(result.events.every(row => row.status === "ok")).toBe(true);
  });

  it("retains ten thousand rows and long titles without silent truncation", () => {
    const title = "t".repeat(256);
    const events = Array.from({ length: 10_000 }, (_, index) => normal("session_reset_started", { details: { ...director, work_id: `wrk_${index}`, work_title: title } }));
    const result = parseSessionLifecycleReply({ events });
    expect(result.events).toHaveLength(10_000);
    for (const index of [0, 9_999]) expect(result.events[index]).toMatchObject({ status: "ok", resetAttribution: { ...director, work_id: `wrk_${index}`, work_title: title } });
  });

  it("extracts actual reset origins, title and ID fallback without storage details", () => {
    const rows = parseSessionLifecycleReply(fixture.target).events;
    expect(rows.map(row => row.status === "ok" ? row.resetAttribution : undefined)).toEqual([
      { ...director, work_title: "Example work" },
      { ...director, work_id: "wrk_missing" },
      { origin: "agent_self" }, { origin: "operator" }, null,
    ]);
    expect(rows[0]).not.toHaveProperty("details");
  });

  it.each(SESSION_LIFECYCLE_KINDS)("displays known kind %s without duplicating storage validation", kind => {
    // Non-display details deliberately remain outside this parser's contract.
    const details = ["session_reset_started", "disconnected"].includes(kind) ? null : { revision: 0, previous: null, extra: "ignored" };
    expect(parse(normal(kind, { details }))).toEqual({ status: "ok", kind, at, trigger: null, resetAttribution: null, disconnect: null });
  });

  it.each([null, false, 0, "reply", []])("rejects nonobject skeleton %j", raw => {
    expect(() => parseSessionLifecycleReply(raw)).toThrow("invalid_reply");
  });
  it.each([undefined, null, {}, "events", 3])("rejects non-array events %j", events => {
    expect(() => parseSessionLifecycleReply({ events })).toThrow("invalid_reply");
  });
  it.each([null, "true", 1, {}, []])("rejects invalid incomplete marker %j", events_incomplete => {
    expect(() => parseSessionLifecycleReply({ events: [], events_incomplete })).toThrow("invalid_reply");
  });
  it.each([undefined, false, true])("normalizes incomplete marker %j", marker => {
    const raw = marker === undefined ? { events: [] } : { events: [], events_incomplete: marker };
    expect(parseSessionLifecycleReply(raw)).toEqual({ events: [], incomplete: marker === true });
  });

  it.each([null, [], false, 7, "row"])("retains nonobject row %j", value => {
    expect(parse(value)).toEqual({ status: "malformed", rawKind: null, rawAt: null });
  });
  it.each([
    {}, { kind: "", at }, { kind: 2, at }, { kind: "compacting", at: "" },
    { kind: "compacting", at: 2 }, { kind: "future_kind", at },
  ])("retains unreadable row %j", value => {
    expect(parse(value)).toEqual({ status: "malformed", rawKind: typeof value.kind === "string" && value.kind !== "" ? value.kind : null, rawAt: typeof value.at === "string" && value.at !== "" ? value.at : null });
  });
  it("preserves mixed row count, order and raw display values", () => {
    const raw = [normal(), null, { kind: "future_kind", at: "raw-time" }, normal("reconnected")];
    const rows = parseSessionLifecycleReply({ events: raw }).events;
    expect(rows.map(row => row.status)).toEqual(["ok", "malformed", "malformed", "ok"]);
    expect(rows[2]).toEqual({ status: "malformed", rawKind: "future_kind", rawAt: "raw-time" });
  });

  it.each([undefined, null, "sdk_auto", "manual", "future-trigger"])("accepts display trigger %j", trigger => {
    expect(parse(normal("compact_boundary", { trigger }))).toMatchObject({ status: "ok", trigger: trigger ?? null });
  });
  it.each(["", 1, false, [], {}])("marks invalid display trigger %j unreadable", trigger => {
    expect(parse(normal("compact_boundary", { trigger }))).toMatchObject({ status: "malformed" });
  });

  it.each([undefined, null])("accepts legacy reset and disconnect details %j", details => {
    expect(parse(normal("session_reset_started", { details }))).toMatchObject({ status: "ok", resetAttribution: null });
    expect(parse(normal("disconnected", { details }))).toMatchObject({ status: "ok", disconnect: null });
  });
  it.each(["operator", "agent_self"])("keeps only origin for %s", origin => {
    expect(parse(normal("session_reset_started", { details: { origin, extra: "ignored" } }))).toEqual({ status: "ok", kind: "session_reset_started", at, trigger: null, disconnect: null, resetAttribution: { origin } });
  });
  it.each([undefined, null, "Title"])("extracts optional director title %j", work_title => {
    const result = parse(normal("session_reset_started", { details: { ...director, work_title, extra: 1 } }));
    expect(result).toMatchObject({ status: "ok", resetAttribution: work_title == null ? director : { ...director, work_title } });
    if (result?.status === "ok" && work_title == null) expect(result.resetAttribution).not.toHaveProperty("work_title");
  });
  it.each([
    "details", [], 1, { ...director, origin: "future" },
    { ...director, requested_by: null }, { ...director, requested_by: [] },
    { ...director, requested_by: { kind: "user", id: "host-a.director" } },
    { ...director, requested_by: { kind: "agent", id: "" } },
    { ...director, requested_by: { kind: "agent", id: { length: 1 } } },
    { ...director, work_id: undefined }, { ...director, work_id: "" }, { ...director, work_id: 2 },
    { ...director, work_title: "" }, { ...director, work_title: 2 }, { ...director, work_title: [] },
  ])("retains malformed reset attribution %j", details => {
    expect(parse(normal("session_reset_started", { details }))).toMatchObject({ status: "malformed" });
  });
  it.each(fixture.disconnect_pairs.events)("extracts server disconnection pair $details.origin/$details.reason", row => {
    expect(parse({ ...row, details: { ...row.details, extra: 1 } })).toEqual({ status: "ok", kind: "disconnected", at: row.at, trigger: null, resetAttribution: null, disconnect: row.details });
    expect(parse({ ...row, details: { ...row.details, extra: 1 } })).not.toHaveProperty("details");
  });
  it.each(["details", [], { origin: "runner", reason: "crash" }, { origin: ["operator"], reason: "stop" }, { origin: "operator", reason: ["stop"] }, { origin: "future", reason: "stop" }])("retains invalid disconnection %j", details => {
    expect(parse(normal("disconnected", { details }))).toMatchObject({ status: "malformed" });
  });
});
