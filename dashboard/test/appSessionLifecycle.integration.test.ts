// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../protocol/fixtures/session-lifecycle-query.json" with { type: "json" };
import App from "../src/App.svelte";

interface Frame { joinRef: string | null; ref: string | null; topic: string; event: string; payload: Record<string, unknown> }
class ControlledWebSocket {
  static instances: ControlledWebSocket[] = [];
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = ControlledWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: Frame[] = [];
  constructor(public url: string) {
    ControlledWebSocket.instances.push(this);
    queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.({}); } });
  }
  send(data: string): void {
    const [joinRef, ref, topic, event, payload] = JSON.parse(data) as [string | null, string | null, string, string, Record<string, unknown>];
    const frame = { joinRef, ref, topic, event, payload };
    this.sent.push(frame);
    if (event === "list_session_events") return;
    const responses: Record<string, unknown> = {
      phx_join: { delivery_policy_control: "v1" }, list_conversations: { conversations: [] }, list_users: { users: [] },
      get_delivery_policy: { policy: "unknown", confirmed: false, pending: false, wrapper_support: false },
    };
    queueMicrotask(() => this.reply(frame, responses[event] ?? {}));
  }
  reply(frame: Frame, response: unknown, status = "ok"): void {
    this.onmessage?.({ data: JSON.stringify([frame.joinRef, frame.ref, frame.topic, "phx_reply", { status, response }]) });
  }
  push(event: string, payload: Record<string, unknown>): void {
    const join = this.sent.find(frame => frame.event === "phx_join")!;
    this.onmessage?.({ data: JSON.stringify([join.joinRef, null, "agents:lobby", event, { version: "0", ...payload }]) });
  }
  close(): void { this.readyState = ControlledWebSocket.CLOSED; }
  serverClose(): void { this.close(); this.onclose?.({ code: 1006, reason: "test reconnect", wasClean: false }); }
  queries(): Frame[] { return this.sent.filter(frame => frame.event === "list_session_events"); }
}

const TARGET = "host-a.target";
const OTHER = "host-a.other";
const envelope = (id: string, name: string) => ({ version: "0", agent_id: id, display_name: name, ts: "2026-01-01T00:00:00Z", type: "state_change", state: "idle", payload: {}, persona: { id: "p", name, sprite_set: "p" } });
let mounted: object | null = null;
const history = () => document.querySelector<HTMLElement>(".session-lifecycle-dialog");
const historyText = () => history()?.textContent ?? "";
async function flush() { await tick(); await tick(); await tick(); }
async function joined(index = 0): Promise<ControlledWebSocket> {
  await vi.waitFor(() => expect(ControlledWebSocket.instances[index]?.sent.some(frame => frame.event === "phx_join")).toBe(true), { timeout: 4000 });
  await flush();
  return ControlledWebSocket.instances[index]!;
}
async function project(ws: ControlledWebSocket, operator: boolean) {
  ws.push("snapshot", { agents: { [TARGET]: envelope(TARGET, "Target"), [OTHER]: envelope(OTHER, "Other"), "host-a.director": envelope("host-a.director", "Director") } });
  if (operator) ws.push("hosts", { hosts: {} });
  await flush();
}
async function boot(operator = true) {
  mounted = mount(App, { target: document.body });
  const ws = await joined(); await project(ws, operator); return ws;
}
async function detail(name = "Target") {
  document.querySelector<HTMLButtonElement>(`button[aria-label="${name} の詳細を開く"]`)!.click(); await flush();
}
async function openHistory(ws: ControlledWebSocket, name = "Target") {
  await detail(name);
  document.querySelector<HTMLButtonElement>(".session-lifecycle-open")!.click();
  await vi.waitFor(() => expect(ws.queries().length).toBeGreaterThan(0)); await flush();
  return ws.queries().at(-1)!;
}
async function settings() { document.querySelector<HTMLButtonElement>("button[aria-label=設定]")!.click(); await flush(); }
async function closeHistory() { history()!.querySelector<HTMLButtonElement>("button[aria-label=閉じる]")!.click(); await flush(); }
async function refresh() { [...history()!.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "更新")!.click(); await flush(); }
async function reconnect(ws: ControlledWebSocket, operator: boolean) {
  const nextIndex = ControlledWebSocket.instances.length;
  ws.serverClose(); await flush(); window.dispatchEvent(new Event("online"));
  const next = await joined(nextIndex); await project(next, operator); return next;
}

beforeEach(() => {
  ControlledWebSocket.instances = [];
  localStorage.clear();
  vi.stubGlobal("WebSocket", ControlledWebSocket);
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const path = String(input);
    const body = path.includes("/session/ticket") ? { ticket: "example-ticket" }
      : path.includes("/session/auth-methods") ? { token: true, oauth: [] }
      : path.includes("/api/health") ? { status: "ok", build_version: "unknown", build_channel: "dev", build_revision: "unknown", build_dirty: false, protocol_version: "0" }
      : {};
    const status = path.includes("/api/personas") ? 503 : 200;
    return { ok: status === 200, status, json: async () => body };
  }));
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = null; document.body.innerHTML = "";
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("real App session lifecycle wiring", () => {
  it("opens from detail and consumes real query/parser output with all reset origins", async () => {
    const ws = await boot(); const request = await openHistory(ws);
    expect(request.payload).toEqual({ version: "0", agent_id: TARGET });
    ws.reply(request, fixture.target); await flush();
    expect(history()!.querySelector("h2")?.textContent).toBe("Target のセッション履歴");
    expect(history()!.querySelector(".target-id")?.textContent).toBe(TARGET);
    expect(history()!.querySelectorAll(".lifecycle-row")).toHaveLength(5);
    for (const origin of ["operator", "agent_self", "director"]) expect(historyText()).toContain(`要求元: ${origin}`);
    expect(historyText()).toContain("Director (host-a.director)");
    expect(historyText()).toContain("Example work (wrk_active)");
    expect(historyText()).toContain("work: wrk_missing");
    expect(history()!.querySelector(".empty")).toBeNull();
  });
  it("passes persistent directory names into the history dialog", async () => {
    const ws = await boot();
    ws.push("directory", { entries: { "host-a.director": { display_name: "Archived Director", last_seen: null, persona: { id: "director" } } } }); await flush();
    const request = await openHistory(ws); ws.reply(request, fixture.target); await flush();
    expect(history()!.querySelector(".requester")?.textContent).toBe("要求者: Archived Director (host-a.director)");
  });
  it("looks up a deleted ID through settings without keeping two dialogs open", async () => {
    const ws = await boot(); await settings();
    const section = document.querySelector<HTMLElement>(".session-lifecycle")!;
    expect(section.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
    const input = section.querySelector<HTMLInputElement>("input")!;
    input.value = "   "; input.dispatchEvent(new Event("input", { bubbles: true })); await flush();
    section.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true })); await flush();
    expect(ws.queries()).toHaveLength(0);
    input.value = "  host-a.deleted  "; input.dispatchEvent(new Event("input", { bubbles: true })); await flush();
    section.querySelector<HTMLButtonElement>("button")!.click(); await flush();
    expect(document.querySelector(".settings-drawer-content")).toBeNull();
    expect(document.querySelectorAll("dialog[open]")).toHaveLength(1);
    expect(ws.queries()).toHaveLength(1);
    expect(ws.queries()[0]!.payload).toEqual({ version: "0", agent_id: "host-a.deleted" });
    ws.reply(ws.queries()[0]!, fixture.comma); await flush();
    expect(historyText()).toContain("host-a.deleted");
    expect(historyText()).toContain("2026-01-01T00:00:00,123Z");
  });
  it("hides the settings lookup after connection loss", async () => {
    const ws = await boot(); await settings();
    expect(document.querySelector(".session-lifecycle")).not.toBeNull();
    ws.serverClose(); await flush();
    expect(document.querySelector(".session-lifecycle")).toBeNull();
    expect(ws.queries()).toHaveLength(0);
  });
  it("hides both entry points and emits no lifecycle query for a connected viewer", async () => {
    const ws = await boot(false); await detail();
    expect(ws.readyState).toBe(ControlledWebSocket.OPEN);
    expect(document.querySelector(".session-lifecycle-open")).toBeNull();
    await settings(); expect(document.querySelector(".session-lifecycle")).toBeNull();
    expect(ws.queries()).toHaveLength(0);
    expect(history()).toBeNull();
  });
  it.each([
    ["broken skeleton", { events: null }, "invalid_reply"],
    ["unreadable only", { events: [{ kind: "future_kind", at: "raw-time" }] }, "読めない行"],
    ["partial empty", { events: [], events_incomplete: true }, "履歴の一部"],
  ])("keeps %s distinct from empty through real transport", async (_name, reply, expected) => {
    const ws = await boot(); const request = await openHistory(ws);
    ws.reply(request, reply); await flush();
    expect(historyText()).toContain(expected as string);
    expect(history()!.querySelector(".empty")).toBeNull();
  });
  it("renders server error as failure and successful empty as empty", async () => {
    const ws = await boot(); const request = await openHistory(ws);
    ws.reply(request, { reason: "session_lifecycle_unavailable" }, "error"); await flush();
    expect(history()!.querySelector("[role=alert]")?.textContent).toContain("session_lifecycle_unavailable");
    expect(history()!.querySelector(".empty")).toBeNull();
    await refresh(); ws.reply(ws.queries().at(-1)!, fixture.empty); await flush();
    expect(history()!.querySelector(".empty")).not.toBeNull();
    expect(history()!.querySelector("[role=alert]")).toBeNull();
  });
  it.each(["session_reset_started", "session_reset_completed"])("sends another query only for matching %s signals, best-effort", async event => {
    const ws = await boot(); const initial = await openHistory(ws); ws.reply(initial, fixture.empty); await flush();
    const reset = event === "session_reset_started"
      ? { request_id: "reset-example", mode: "new", origin: "operator", agent_id: OTHER }
      : { request_id: "reset-example", mode: "new", to_session_id: "example-session", agent_id: OTHER };
    ws.push(event, reset); await flush(); expect(ws.queries()).toHaveLength(1);
    ws.push("envelope", envelope(TARGET, "Target")); await flush(); expect(ws.queries()).toHaveLength(1);
    ws.push(event, { ...reset, agent_id: TARGET }); await flush(); expect(ws.queries()).toHaveLength(2);
    // A notification may precede recording, so query issuance is the contract.
    ws.reply(ws.queries()[1]!, fixture.empty); await flush();
    await refresh(); expect(ws.queries()).toHaveLength(3);
    await closeHistory(); ws.push(event, { ...reset, agent_id: TARGET }); await flush(); expect(ws.queries()).toHaveLength(3);
  });
  it("retains the latest target and same-target refresh on reversed success/error replies", async () => {
    const ws = await boot(); const oldTarget = await openHistory(ws);
    await closeHistory(); document.querySelector<HTMLButtonElement>(".detail .back")!.click(); await flush();
    const latest = await openHistory(ws, "Other");
    ws.reply(latest, fixture.comma); await flush(); ws.reply(oldTarget, fixture.target); await flush();
    expect(historyText()).toContain(OTHER); expect(historyText()).not.toContain("wrk_active");
    await refresh(); const older = ws.queries().at(-1)!;
    await refresh(); const newer = ws.queries().at(-1)!;
    ws.reply(older, fixture.target); await flush(); expect(history()!.querySelector(".loading")).not.toBeNull();
    ws.reply(newer, fixture.comma); await flush(); expect(historyText()).not.toContain("wrk_active");
    await refresh(); const oldError = ws.queries().at(-1)!;
    await refresh(); const last = ws.queries().at(-1)!;
    ws.reply(last, fixture.comma); await flush(); ws.reply(oldError, { reason: "old-error" }, "error"); await flush();
    expect(historyText()).toContain("2026-01-01T00:00:00,123Z"); expect(historyText()).not.toContain("old-error");
  });
  it.each([false, true])("closes pending history on rejoin (operator=%s) and never reopens it", async operator => {
    const ws = await boot(); const pending = await openHistory(ws);
    const next = await reconnect(ws, operator);
    expect(history()).toBeNull(); ws.reply(pending, fixture.target); await flush(); expect(history()).toBeNull();
    expect(next.queries()).toHaveLength(0);
    if (!operator) expect(document.querySelector(".session-lifecycle-open")).toBeNull();
  });
  it("closes pending history on logout and keeps it closed after fresh login", async () => {
    const ws = await boot(); const pending = await openHistory(ws);
    document.querySelector<HTMLButtonElement>(".logout")!.click(); await flush();
    expect(history()).toBeNull(); ws.reply(pending, fixture.target); await flush(); expect(history()).toBeNull();
    const input = document.querySelector<HTMLInputElement>("input[type=password]")!;
    input.value = "example-token"; input.dispatchEvent(new Event("input", { bubbles: true })); await flush();
    document.querySelector<HTMLFormElement>(".login form")?.requestSubmit();
    if (ControlledWebSocket.instances.length === 1) document.querySelector<HTMLButtonElement>("button[type=submit]")!.click();
    const next = await joined(1); await project(next, true);
    expect(history()).toBeNull(); expect(next.queries()).toHaveLength(0);
  });
});
