// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../../protocol/fixtures/session-lifecycle-query.json" with { type: "json" };
import SessionLifecycleDialog from "../src/lib/SessionLifecycleDialog.svelte";
import { parseSessionLifecycleReply, type DirectoryEntry, type SessionLifecycleEventList } from "../src/lib/protocol";
import { reactiveObject } from "./reactiveObject.svelte";

HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
let mounted: object | null = null;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = null;
  document.body.innerHTML = "";
});
const text = () => document.body.textContent ?? "";
const empty = () => document.querySelector(".session-lifecycle-dialog .empty");
const rows = () => [...document.querySelectorAll(".lifecycle-row")];
const refresh = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "更新")!.click();
async function open(fetchEvents: (id: string) => Promise<SessionLifecycleEventList>, directory: Record<string, DirectoryEntry> = {}, onClose: () => void = () => {}) {
  const state = reactiveObject({ agentId: "host-a.target", refreshKey: 0 });
  mounted = mount(SessionLifecycleDialog, { target: document.body, props: {
    get agentId() { return state.agentId; }, get refreshKey() { return state.refreshKey; },
    label: "Target", fetchEvents, agents: {}, directory, onClose,
  } });
  await tick();
  return state;
}
const settled = async () => { await tick(); await vi.waitFor(() => expect(document.querySelector(".session-lifecycle-dialog .loading")).toBeNull()); };
const raw = (reply: unknown) => async () => parseSessionLifecycleReply(reply);

describe("session lifecycle dialog", () => {
  it("renders actual reset origins, requester and work fallback", async () => {
    await open(raw(fixture.target)); await settled();
    expect(document.querySelector("dialog")?.getAttribute("aria-label")).toBe("Target のセッション履歴");
    expect(rows()[0]!.querySelector("time")?.getAttribute("datetime")).toBe(fixture.target.events[0]!.at);
    expect(document.querySelector("h2")?.textContent).toBe("Target のセッション履歴");
    expect(document.querySelector(".target-id")?.textContent).toBe("host-a.target");
    expect(rows()).toHaveLength(5);
    expect(text()).toContain("要求元: operator");
    expect(text()).toContain("要求元: agent_self");
    expect(text()).toContain("要求元: director");
    expect(text()).toContain("要求者: host-a.director");
    expect(rows()[0]!.querySelector(".requester")?.textContent).toBe("要求者: host-a.director");
    expect(text()).toContain("Example work (wrk_active)");
    expect(text()).toContain("work: wrk_missing");
    expect(rows()[1]!.querySelector(".work")?.textContent).toBe("work: wrk_missing");
    expect(rows()[0]!.querySelector("time")?.textContent).not.toBe("");
    expect(rows()[4]!.textContent).not.toContain("要求元:");
  });
  it.each(["button", "cancel", "backdrop"])("closes a pending history through %s", async action => {
    const close = vi.fn();
    let resolve!: (reply: SessionLifecycleEventList) => void;
    await open(() => new Promise(done => { resolve = done; }), {}, close);
    const modal = document.querySelector("dialog")!;
    if (action === "button") modal.querySelector<HTMLButtonElement>("button[aria-label=閉じる]")!.click();
    else modal.dispatchEvent(new Event(action === "cancel" ? "cancel" : "click", { bubbles: true, cancelable: true }));
    expect(close).toHaveBeenCalledTimes(1);
    await unmount(mounted!); mounted = null;
    resolve(parseSessionLifecycleReply(fixture.target)); await tick();
    expect(document.querySelector(".session-lifecycle-dialog")).toBeNull();
  });
  it("resolves requester names from the persistent directory", async () => {
    await open(raw(fixture.target), { "host-a.director": { display_name: "Archived Director", last_seen: null, persona: { id: "director", name: "Director", sprite_set: "director" } } }); await settled();
    expect(rows()[0]!.querySelector(".requester")?.textContent).toBe("要求者: Archived Director (host-a.director)");
  });
  it.each([
    ["complete empty", { events: [] }, true, false],
    ["partial empty", { events: [], events_incomplete: true }, false, true],
    ["partial nonempty", { ...fixture.target, events_incomplete: true }, false, true],
  ] as const)("distinguishes %s", async (_name, reply, isEmpty, partial) => {
    await open(raw(reply)); await settled();
    expect(empty() !== null).toBe(isEmpty);
    expect(document.querySelector(".incomplete") !== null).toBe(partial);
    expect(document.querySelector("[role=alert]")).toBeNull();
  });
  it("keeps empty hidden during initial loading", async () => {
    await open(() => new Promise(() => {}));
    expect(document.querySelector(".loading")).not.toBeNull();
    expect(empty()).toBeNull();
  });
  it.each(["forbidden", "session_lifecycle_unavailable", "invalid_reply", "timeout"])("shows initial fetch error %s without empty history", async reason => {
    await open(async () => { throw new Error(reason); }); await settled();
    expect(document.querySelector("[role=alert]")?.textContent).toContain(reason);
    expect(empty()).toBeNull();
  });
  it.each([null, { events: null }, { events: [], events_incomplete: null }])("shows actual parser skeleton failure %j as an alert", async reply => {
    await open(raw(reply)); await settled();
    expect(document.querySelector("[role=alert]")?.textContent).toContain("invalid_reply");
    expect(empty()).toBeNull();
  });
  it("retains unreadable-only rows and raw fallback labels", async () => {
    await open(raw({ events: [{ kind: "future_kind", at: "raw-time" }, null] })); await settled();
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.textContent).toContain("読めない行 — kind: future_kind / at: raw-time");
    expect(rows()[1]!.textContent).toBe("読めない行 — kind: unknown / at: unknown");
    expect(empty()).toBeNull();
  });
  it("keeps mixed row order and comma timestamps while displaying triggers and disconnect pairs", async () => {
    await open(raw({ events: [...fixture.comma.events, null, ...fixture.extra.events, { kind: "compact_boundary", at: "2026-01-01T00:00:00Z", trigger: "sdk_auto" }] })); await settled();
    expect(rows()).toHaveLength(4);
    expect(rows()[0]!.textContent).toContain("2026-01-01T00:00:00,123Z");
    expect(rows()[0]!.querySelector(".trigger")).toBeNull();
    expect(rows()[1]!.classList.contains("malformed")).toBe(true);
    expect(rows()[2]!.textContent).toContain("切断: operator (stop)");
    expect(rows()[3]!.querySelector(".trigger")?.textContent).toContain("sdk_auto");
  });
  it("renders long hostile title and raw values only as text", async () => {
    const title = '<img src=x onerror="throw 1">' + "t".repeat(256);
    const id = "<b>director</b>";
    await open(raw({ events: [{ kind: "session_reset_started", at: "not-a-date", details: { origin: "director", requested_by: { kind: "agent", id }, work_id: "wrk_active", work_title: title } }, { kind: "<script>bad</script>", at: "<img src=x>" }] })); await settled();
    expect(text()).toContain(title);
    expect(text()).toContain(id);
    expect(text()).toContain("<script>bad</script>");
    expect(document.querySelector(".events img, .events script, .events b")).toBeNull();
    expect(rows()[0]!.querySelector("time")?.textContent).toBe("not-a-date");
  });
  it("keeps the latest same-target request on older success, rejection and finally", async () => {
    const requests: { resolve: (value: SessionLifecycleEventList) => void; reject: (error: Error) => void }[] = [];
    const fetchEvents = vi.fn((_id: string) => new Promise<SessionLifecycleEventList>((resolve, reject) => requests.push({ resolve, reject })));
    await open(fetchEvents);
    refresh(); await tick(); expect(requests).toHaveLength(2);
    requests[0]!.resolve(parseSessionLifecycleReply(fixture.target));
    await tick();
    expect(document.querySelector(".loading")).not.toBeNull();
    expect(rows()).toHaveLength(0);
    requests[1]!.resolve(parseSessionLifecycleReply({ events: [{ kind: "reconnected", at: "new-time" }] })); await settled();
    expect(text()).toContain("new-time");
    refresh(); await tick(); refresh(); await tick();
    requests[3]!.resolve(parseSessionLifecycleReply(fixture.comma)); await settled();
    requests[2]!.reject(new Error("old-error")); await tick();
    expect(text()).toContain("2026-01-01T00:00:00,123Z");
    expect(text()).not.toContain("old-error");
    expect(document.querySelector("[role=alert]")).toBeNull();
  });
  it("clears previous rows, error and partial state before refreshing", async () => {
    const replies = [() => Promise.resolve(parseSessionLifecycleReply({ ...fixture.target, events_incomplete: true })), () => Promise.reject(new Error("failed refresh")), () => new Promise<SessionLifecycleEventList>(() => {})];
    await open(() => replies.shift()!()); await settled();
    refresh(); await settled(); expect(rows()).toHaveLength(0); expect(document.querySelector(".incomplete")).toBeNull();
    expect(document.querySelector("[role=alert]")?.textContent).toContain("failed refresh");
    refresh(); await tick(); expect(document.querySelector("[role=alert]")).toBeNull(); expect(empty()).toBeNull();
  });
  it("reads the new target and refresh key and ignores the previous target", async () => {
    const pending: ((value: SessionLifecycleEventList) => void)[] = [];
    const fetchEvents = vi.fn((_id: string) => new Promise<SessionLifecycleEventList>(resolve => pending.push(resolve)));
    const state = await open(fetchEvents);
    state.agentId = "host-a.second"; await tick();
    expect(fetchEvents.mock.calls.map(args => args[0])).toEqual(["host-a.target", "host-a.second"]);
    pending[1]!(parseSessionLifecycleReply(fixture.comma)); await settled();
    pending[0]!(parseSessionLifecycleReply(fixture.target)); await tick();
    expect(rows()).toHaveLength(1); expect(text()).not.toContain("wrk_active");
    state.refreshKey += 1; await tick(); expect(fetchEvents).toHaveBeenCalledTimes(3);
  });
});
