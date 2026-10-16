import { createHash, randomBytes } from "node:crypto";
import type { DetachedReplyBasis } from "@kaoiro/agent-common";
import { marker, reportInstruction } from "./continuation_markers.js";

type Input = Record<string, unknown>;
export type ContinuationSource = "Agent" | "Monitor" | "Bash" | "Workflow";
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Input)[k])}`).join(",")}}`;
};
const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const backgroundStart = (frame: Input): boolean => frame.task_type === "local_workflow"
  ? frame.is_backgrounded !== false && frame.parent_task_id === undefined
  : frame.is_backgrounded === true || frame.task_type === "monitor_ws";
const record = (value: unknown): Input | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Input : undefined;

export interface LaunchCapability {
  readonly token: string;
  readonly callId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly source: "Agent" | "Monitor";
  readonly subtype?: "command" | "ws" | undefined;
  readonly basis: DetachedReplyBasis;
  readonly originalDigest: string;
  readonly effectiveDigest: string;
  readonly effective: Input;
  taskId?: string | undefined;
  runId?: string | undefined;
  state: "prepared" | "armed" | "draining" | "closed";
  remainingIdleMs: number;
  consumed?: string | undefined;
  quarantined?: string | undefined;
}
interface Call {
  name: string;
  source?: ContinuationSource | undefined;
  originalDigest: string;
  capability?: LaunchCapability | undefined;
  start?: Input;
  successTask?: string | undefined;
  rejected?: boolean;
}
export interface SourceRun {
  taskId: string;
  runId: string;
  callId?: string | undefined;
  source?: ContinuationSource | undefined;
  taskType?: string | undefined;
  background: boolean;
  terminal?: Input;
  retiredRuns: Set<string>;
  uncertain: boolean;
  explicitStop: boolean;
  stops: Set<string>;
}
interface ControlWindow { pairs: Map<string, string>; deadline: number }

/** Classification outlives capabilities, so overflow cannot turn a Monitor into Bash. */
export class ContinuationRegistry {
  readonly #calls = new Map<string, Call>();
  readonly #tokens = new Map<string, LaunchCapability>();
  readonly #runs = new Map<string, SourceRun>();
  readonly #stopAttempts = new Map<string, { taskId: string; runId: string }>();
  readonly #windows = new Map<number, ControlWindow>();
  #nextWindow = 0;
  #full = false;
  #invalid = false;
  #lastTick = performance.now();
  #busy = false;
  constructor(readonly sessionId: string, readonly warn: (message: string) => void = () => {}) {}

  observeCall(callId: string, name: string, input: Input): Call | undefined {
    if (this.#invalid) return undefined;
    const old = this.#calls.get(callId);
    if (old) {
      if (old.name !== name || old.originalDigest !== hash(input)) {
        old.rejected = true; if (old.capability) old.capability.state = "closed";
        this.warn("native continuation conflicting tool call identity");
      }
      return old;
    }
    if (this.#calls.size >= 8192) {
      if (!this.#full) this.warn("native continuation source index capacity reached; unknown sources refused");
      this.#full = true; return undefined;
    }
    const source = (["Agent", "Monitor", "Bash", "Workflow"] as string[]).includes(name) ? name as ContinuationSource :
      name === "SendMessage" ? "Agent" : undefined;
    const call: Call = { name, source, originalDigest: hash(input) };
    this.#calls.set(callId, call);
    return call;
  }

  prepare(callId: string, name: string, input: Input, promptId: string, basis: DetachedReplyBasis): Input | undefined {
    const call = this.observeCall(callId, name, input);
    if (!call || call.rejected) return undefined;
    if (call.capability) return call.capability.state === "prepared" ? structuredClone(call.capability.effective) : undefined;
    if (name !== "Agent" && name !== "Monitor" && name !== "SendMessage") return undefined;
    if (this.#tokens.size >= 64) { this.warn("native continuation capacity reached; return instrumentation suspended"); return undefined; }
    let field: string;
    let subtype: "command" | "ws" | undefined;
    if (name === "Agent") {
      if (typeof input.prompt !== "string" || typeof input.subagent_type !== "string") return undefined;
      field = "prompt";
    } else if (name === "Monitor") {
      const ws = record(input.ws);
      if (typeof input.description !== "string" || (typeof input.command === "string") === (typeof ws?.url === "string")) return undefined;
      subtype = typeof input.command === "string" ? "command" : "ws";
      field = "description";
    } else {
      if (typeof input.to !== "string" || typeof input.message !== "string" ||
          (input.recipient !== undefined && input.recipient !== input.to) ||
          (input.recipient_kind !== undefined && input.recipient_kind !== "agent")) return undefined;
      const target = this.#runs.get(input.to);
      if (!target || target.source !== "Agent" || !target.terminal || target.uncertain || target.stops.size ||
          [...this.#tokens.values()].some(c => c.state === "prepared" && c.effective.to === input.to)) return undefined;
      field = "message";
    }
    let token: string;
    do { token = randomBytes(32).toString("base64url"); } while (this.#tokens.has(token));
    const text = input[field] as string;
    const updated = text + (name === "Monitor" ? ` ${marker(token)}` : reportInstruction(token, name === "SendMessage"));
    if (Buffer.byteLength(updated) > 65536) {
      this.warn("native continuation text length limit reached; instrumentation refused"); return undefined;
    }
    const effective = structuredClone({ ...input, [field]: updated });
    const capability: LaunchCapability = { token, callId, sessionId: this.sessionId, promptId,
      source: name === "Monitor" ? "Monitor" : "Agent", subtype, basis,
      originalDigest: hash(input), effectiveDigest: hash(effective), effective,
      state: "prepared", remainingIdleMs: 10000 };
    call.capability = capability; this.#tokens.set(token, capability);
    return structuredClone(effective);
  }

  outcome(callId: string, input: Input, response: unknown, failed = false): void {
    const call = this.#calls.get(callId);
    const cap = call?.capability;
    if (!call || !cap || cap.state === "closed") return;
    const result = record(response);
    const task = call.name === "Agent" && result?.isAsync === true && result.status === "async_launched" ? result.agentId :
      call.name === "Monitor" ? result?.taskId :
      call.name === "SendMessage" && result?.success === true ? result.resumedAgentId : undefined;
    if (failed || !result || typeof task !== "string" || hash(input) !== cap.effectiveDigest ||
        (call.name === "Agent" && result.prompt !== cap.effective.prompt) ||
        (call.name === "SendMessage" && task !== cap.effective.to)) {
      call.rejected = true; cap.state = "closed"; this.#tokens.delete(cap.token); return;
    }
    call.successTask = task;
    this.#arm(call);
  }

  rejectCall(callId: string): void {
    const call = this.#calls.get(callId);
    if (!call) return;
    call.rejected = true;
    if (call.capability) { call.capability.state = "closed"; this.#tokens.delete(call.capability.token); }
  }

  #arm(call: Call): void {
    const cap = call.capability, start = call.start;
    if (!cap || cap.state !== "prepared" || call.rejected || !start || !call.successTask) return;
    const run = this.#runs.get(call.successTask);
    const taskType = cap.source === "Agent" ? "local_agent" : cap.subtype === "ws" ? "monitor_ws" : "local_bash";
    if (start.task_id !== call.successTask || typeof start.run_id !== "string" || start.tool_use_id !== cap.callId ||
        start.task_type !== taskType || (taskType !== "monitor_ws" && start.is_backgrounded !== true) ||
        (cap.source === "Agent" ? start.prompt !== (cap.effective.prompt ?? cap.effective.message) : start.description !== cap.effective.description) ||
        !run || run.runId !== start.run_id || run.uncertain || run.explicitStop) {
      cap.state = "closed"; this.#tokens.delete(cap.token); return;
    }
    cap.taskId = call.successTask; cap.runId = start.run_id;
    cap.state = run.terminal ? "draining" : "armed";
  }

  observeFrame(frame: Input, now = performance.now()): void {
    if (this.#invalid || frame.type !== "system" || frame.session_id !== this.sessionId ||
        !["task_started", "task_progress", "task_notification", "task_updated"].includes(String(frame.subtype)) ||
        typeof frame.task_id !== "string" || typeof frame.run_id !== "string") return;
    const taskId = frame.task_id, runId = frame.run_id;
    const callId = typeof frame.tool_use_id === "string" ? frame.tool_use_id : undefined;
    const call = callId ? this.#calls.get(callId) : undefined;
    let run = this.#runs.get(taskId);
    if (run && run.runId !== runId) {
      if (run.retiredRuns.has(runId)) return;
      for (const cap of this.#tokens.values()) if (cap.taskId === taskId && cap.runId !== runId) cap.state = "closed";
      const retiredRuns = new Set([...run.retiredRuns, run.runId]);
      if (retiredRuns.size > 256) { run.uncertain = true; return; }
      run = { taskId, runId, callId, source: call?.source, taskType: String(frame.task_type ?? ""),
        background: backgroundStart(frame), retiredRuns, uncertain: frame.subtype !== "task_started" || !call,
        explicitStop: false, stops: new Set() };
      this.#runs.set(taskId, run);
    } else if (!run) {
      if (this.#runs.size >= 8192) { this.warn("native continuation task history capacity reached"); return; }
      run = { taskId, runId, callId, source: call?.source, taskType: typeof frame.task_type === "string" ? frame.task_type : undefined,
        background: backgroundStart(frame), retiredRuns: new Set(),
        uncertain: frame.subtype !== "task_started" || !call, explicitStop: false, stops: new Set() };
      this.#runs.set(taskId, run);
    } else if (callId && run.callId && run.callId !== callId) {
      run.uncertain = true;
    }
    const backgrounded = record(frame.patch)?.is_backgrounded;
    if (frame.subtype === "task_updated" && run.taskType === "local_bash" && typeof backgrounded === "boolean") run.background = backgrounded;
    if (frame.subtype === "task_started" && call) {
      if (call.start && hash(call.start) !== hash(frame)) { call.rejected = true; if (call.capability) call.capability.state = "closed"; }
      else { call.start = structuredClone(frame); this.#arm(call); }
    }
    if (frame.subtype === "task_notification" && ["completed", "failed", "stopped", "killed"].includes(String(frame.status))) {
      const interrupted = ["stopped", "killed"].includes(String(frame.status)) && [...this.#windows.values()].some(w =>
        now <= w.deadline && w.pairs.get(taskId) === runId);
      if (!run.terminal) run.terminal = structuredClone(frame);
      else if (hash(run.terminal) !== hash(frame)) run.uncertain = true;
      if (run.stops.size || interrupted) run.explicitStop = true;
      for (const cap of this.#tokens.values()) if (cap.taskId === taskId && cap.runId === runId) {
        if (run.explicitStop) cap.state = "closed";
        else if (cap.state === "armed") cap.state = "draining";
      }
    }
    this.#collectClosed();
  }

  stopAttempt(callId: string, taskId: string): void {
    const run = this.#runs.get(taskId);
    if (!run) return;
    this.#stopAttempts.set(callId, { taskId, runId: run.runId }); run.stops.add(callId);
  }
  stopOutcome(callId: string, succeeded: boolean): void {
    const attempt = this.#stopAttempts.get(callId);
    if (!attempt) return;
    this.#stopAttempts.delete(callId);
    const run = this.#runs.get(attempt.taskId);
    if (!run || run.runId !== attempt.runId) return;
    run.stops.delete(callId);
    if (succeeded) this.stopTask(attempt.taskId);
  }
  stopTask(taskId: string): void {
    const run = this.#runs.get(taskId);
    if (!run) return;
    run.explicitStop = true;
    for (const cap of this.#tokens.values()) if (cap.taskId === taskId && cap.runId === run.runId) cap.state = "closed";
    this.#collectClosed();
  }
  beginInterrupt(now = performance.now()): number {
    this.#expireWindows(now);
    const id = ++this.#nextWindow;
    this.#windows.set(id, { deadline: now + 5000,
      pairs: new Map([...this.#runs.values()].filter(r => !r.terminal && !r.uncertain).map(r => [r.taskId, r.runId])) });
    return id;
  }
  endInterrupt(id: number, success: boolean, now = performance.now()): void {
    const window = this.#windows.get(id);
    if (!window) return;
    if (!success) this.#windows.delete(id);
    else window.deadline = Math.min(window.deadline, now + 1000);
  }
  #expireWindows(now: number): void { for (const [id, window] of this.#windows) if (now > window.deadline) this.#windows.delete(id); }
  #collectClosed(): void { for (const [token, cap] of this.#tokens) if (cap.state === "closed") this.#tokens.delete(token); }
  tick(busy: boolean, now = performance.now()): void {
    const elapsed = Math.max(0, now - this.#lastTick); this.#lastTick = now;
    if (!this.#busy) for (const cap of this.#tokens.values()) if (cap.state === "draining") {
      cap.remainingIdleMs -= elapsed; if (cap.remainingIdleMs <= 0) cap.state = "closed";
    }
    this.#busy = busy; this.#collectClosed(); this.#expireWindows(now);
  }
  eligible(cap: LaunchCapability): boolean {
    const run = cap.taskId ? this.#runs.get(cap.taskId) : undefined;
    return !this.#invalid && (cap.state === "armed" || cap.state === "draining") && !!run &&
      run.runId === cap.runId && !run.uncertain && !run.explicitStop && run.stops.size === 0;
  }
  byToken(token: string): LaunchCapability | undefined { return this.#tokens.get(token); }
  byExecution(callId: string, taskId: string, runId: string): LaunchCapability | undefined {
    const cap = this.#calls.get(callId)?.capability;
    return cap?.sessionId === this.sessionId && cap.callId === callId && cap.taskId === taskId &&
      cap.runId === runId && this.eligible(cap) ? cap : undefined;
  }
  byTask(taskId: string): LaunchCapability | undefined {
    const matching = [...this.#tokens.values()].filter(cap => cap.taskId === taskId && this.eligible(cap));
    return matching.length === 1 ? matching[0] : undefined;
  }
  source(taskId: string): SourceRun | undefined { return this.#runs.get(taskId); }
  quarantine(token: string, occurrence: string): void {
    const cap = this.#tokens.get(token);
    if (cap?.source === "Agent" && !cap.consumed) cap.quarantined ??= occurrence;
  }
  invalidate(): void {
    this.#invalid = true;
    for (const cap of this.#tokens.values()) cap.state = "closed";
    this.#tokens.clear(); this.#windows.clear();
  }
}
