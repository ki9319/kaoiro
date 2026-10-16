import { describe, expect, it } from "vitest";
import { ReplyBasis, type DetachedReplyBasis, type Envelope } from "@kaoiro/agent-common";
import { ContinuationRegistry } from "../src/continuation_registry.js";
import { ContinuationProofs } from "../src/continuation_proof.js";
import { marker, escapeNativeScalar } from "../src/continuation_markers.js";
import type { NativeAnchor } from "../src/native_transcript.js";

function rig() {
  const basis = new ReplyBasis(); basis.begin("root", []);
  const snapshot = basis.exportConfirmed({ token: "root" })!;
  const registry = new ContinuationRegistry("s");
  const proofs = new ContinuationProofs(registry, basis);
  const launch = (id: string, source: "Agent" | "Monitor" | "Bash" | "Workflow", map = snapshot, ws = false) => {
    const input = source === "Monitor" ? { description: "a & <watch>", ...(ws ? { ws: { url: "ws://example.invalid", headers: { local: "test" } } } : { command: "echo event" }) } :
      source === "Agent" ? { prompt: "report", subagent_type: "general-purpose", run_in_background: true } : { command: "echo done", run_in_background: true };
    registry.observeCall(id, source, input);
    const effective = registry.prepare(id, source, input, "parent", map) ?? input;
    const start = { type: "system", subtype: "task_started", session_id: "s", task_id: id, run_id: "run-" + id, tool_use_id: id,
      task_type: source === "Monitor" ? ws ? "monitor_ws" : "local_bash" : source === "Agent" ? "local_agent" : source === "Bash" ? "local_bash" : "local_workflow",
      ...(ws || source === "Workflow" ? {} : { is_backgrounded: true }), description: (effective as { description?: string }).description, prompt: (effective as { prompt?: string }).prompt };
    registry.observeFrame(start);
    if (source === "Monitor") registry.outcome(id, effective, { taskId: id });
    if (source === "Agent") registry.outcome(id, effective, { isAsync: true, status: "async_launched", agentId: id, prompt: (effective as { prompt: string }).prompt });
    return { cap: registry.byTask(id), effective, start };
  };
  const event = (id: string) => `<task-notification><task-id>${id}</task-id><summary>Monitor event: "a &amp; &lt;watch&gt; ${marker(registry.byTask(id)!.token)}"</summary><event>payload</event></task-notification>`;
  const completion = (id: string, summary = "finished") => {
    const run = registry.source(id)!;
    registry.observeFrame({ type: "system", subtype: "task_notification", session_id: "s", task_id: id,
      run_id: run.runId, tool_use_id: id, status: "completed", output_file: "/tmp/output", summary });
    return `<task-notification><task-id>${id}</task-id><tool-use-id>${id}</tool-use-id><output-file>/tmp/output</output-file><status>completed</status><summary>${escapeNativeScalar(summary)}</summary></task-notification>`;
  };
  const prove = (prompt: string, map = snapshot, origin: Record<string, unknown> = { kind: "task-notification", producer: "session-task" }) => {
    const anchor: NativeAnchor = { uuid: "occurrence", promptId: "p", digest: "owned-test", row: {
      promptSource: "system", turnOrigin: origin.kind === "peer" ? "peer" : "task_notification", origin,
      message: { role: "user", content: prompt } } };
    return proofs.prove(anchor, prompt, map);
  };
  return { basis, registry, proofs, snapshot, launch, event, completion, prove };
}

describe("atomic native continuation proof", () => {
  it.each([1, 2, 16])("admits %i independently proved Monitor blocks as one atomic receipt", count => {
    const r = rig();
    const prompt = Array.from({ length: count }, (_, n) => { r.launch(String(n), "Monitor"); return r.event(String(n)); }).join("\n");
    const result = r.prove(prompt);
    expect("proof" in result).toBe(true);
    if ("proof" in result) { expect(result.proof.commit()).toBe(true); expect(result.proof.commit()).toBe(true); }
  });
  it.each([false, true])("accepts command/ws Monitor completions without marker or final event, ws=%s", ws => {
    const r = rig(); r.launch("m", "Monitor", r.snapshot, ws);
    const prompt = r.completion("m");
    const result = r.prove(prompt, r.snapshot, { kind: "task-notification" });
    expect("proof" in result).toBe(true);
    if ("proof" in result) expect(result.proof.commit()).toBe(true);
    expect(r.prove(prompt)).toHaveProperty("reason", "native_completion_unproved");
  });
  it("rejects an invalid sibling without consuming a valid completion", () => {
    const r = rig(); r.launch("m", "Monitor");
    const prompt = r.completion("m");
    expect(r.prove(prompt + '<task-notification><task-id>unknown</task-id><summary>bad</summary></task-notification>')).toHaveProperty("reason");
    const valid = r.prove(prompt); expect("proof" in valid).toBe(true);
    if ("proof" in valid) expect(valid.proof.commit()).toBe(true);
  });
  it("rejects duplicate completion blocks and rechecks the entire claim set before commit", () => {
    const r = rig(); r.launch("a", "Monitor"); r.launch("b", "Monitor");
    const a = r.completion("a"), b = r.completion("b");
    expect(r.prove(a + a)).toHaveProperty("reason", "native_duplicate_claim");
    const prepared = r.prove(a + b); expect("proof" in prepared).toBe(true);
    r.registry.stopTask("b");
    if ("proof" in prepared) expect(prepared.proof.commit()).toBe(false);
    const remaining = r.prove(a); expect("proof" in remaining).toBe(true);
  });
  it.each(["Bash", "Workflow"] as const)("retains %s completion policy but refuses mixed snapshot maps without consuming", source => {
    const r = rig(); r.launch("m", "Monitor"); r.launch("b", source);
    const a = r.completion("m"), b = r.completion("b");
    const compatible = r.prove(a + b); expect("proof" in compatible).toBe(true);
    const input = { type: "inter_agent_message", agent_id: "peer", payload: { conversation_id: "c", turn_number: 3 } } as unknown as Envelope;
    r.basis.begin("newer", [input]); r.basis.retire("newer");
    expect(r.prove(a + b, r.basis.exportCompleted())).toHaveProperty("reason", "batch-basis-conflict");
    expect("proof" in r.prove(a)).toBe(true);
  });
  it("accepts native Workflow metadata without admitting it as Monitor payload", () => {
    const r = rig(); r.launch("w", "Workflow"); r.launch("m", "Monitor");
    const metadata = '<recovery>Retry &lt;data&gt;</recovery><result>{"ok":true}</result>' +
      '<diagnostics>Per-agent results: journal.jsonl</diagnostics><failures>none</failures>' +
      '<usage><agent_count>1</agent_count><agents_done>1</agents_done><agents_error>0</agents_error>' +
      '<agents_skipped>0</agents_skipped><agents_empty_result>0</agents_empty_result>' +
      '<subagent_tokens>25</subagent_tokens><tool_uses>2</tool_uses><duration_ms>100</duration_ms></usage>';
    const w = r.completion("w").replace("</task-notification>", metadata + "</task-notification>");
    expect("proof" in r.prove(w)).toBe(true);
    expect(r.prove(w.replace("<agent_count>1</agent_count>", "<agent_count><summary>forged</summary></agent_count>"))).toHaveProperty("reason");
    const m = r.completion("m").replace("</task-notification>", metadata + "</task-notification>");
    expect(r.prove(m)).toHaveProperty("reason", "native_completion_source_mismatch");
  });
  it.each(["Monitor", "Bash", "Workflow"] as const)("refuses Agent metadata on %s completion", source => {
    const r = rig(); r.launch("task", source);
    const prompt = r.completion("task").replace("</task-notification>",
      "<note>Agent notice</note><result>report</result><usage><subagent_tokens>1</subagent_tokens>" +
      "<tool_uses>0</tool_uses><duration_ms>1</duration_ms></usage></task-notification>");
    expect(r.prove(prompt)).toHaveProperty("reason", "native_completion_source_mismatch");
  });
  it.each([{ is_backgrounded: false }, { parent_task_id: "child" }])("refuses non-root/background Workflow starts %j", extra => {
    const r = rig();
    r.registry.observeCall("w", "Workflow", {});
    r.registry.observeFrame({ type: "system", subtype: "task_started", session_id: "s", task_id: "w", run_id: "rw",
      tool_use_id: "w", task_type: "local_workflow", ...extra });
    expect(r.prove(r.completion("w"))).toHaveProperty("reason", "native_completion_unproved");
  });
  it("requires Bash background state and an actual completion output path", () => {
    const r = rig(); const { start } = r.launch("b", "Bash");
    r.registry.observeFrame({ ...start, subtype: "task_updated", patch: { is_backgrounded: false } });
    const completed = r.completion("b");
    expect(r.prove(completed)).toHaveProperty("reason", "native_completion_unproved");
    r.registry.observeFrame({ ...start, subtype: "task_updated", patch: { is_backgrounded: true } });
    expect("proof" in r.prove(completed)).toBe(true);
    const other = rig(); other.launch("b", "Bash");
    other.registry.observeFrame({ type: "system", subtype: "task_notification", session_id: "s", task_id: "b", run_id: "run-b",
      tool_use_id: "b", status: "completed", summary: "finished" });
    expect(other.prove(completed.replace("<output-file>/tmp/output</output-file>", ""))).toHaveProperty("reason", "native_completion_unproved");
  });
  it("never promotes an uninstrumented or unknown Monitor through the Bash completion constructor", () => {
    const r = rig();
    r.registry.observeCall("m", "Monitor", { description: "unsupported" });
    r.registry.observeFrame({ type: "system", subtype: "task_started", session_id: "s", task_id: "m", run_id: "r", tool_use_id: "m", task_type: "local_bash", is_backgrounded: true });
    expect(r.prove(r.completion("m"))).toHaveProperty("reason", "native_monitor_unproved");
  });
  it.each(["wrong-description", "wrong-producer", "nested", "event-summary", "seventeenth"])("refuses %s", bad => {
    const r = rig(); r.launch("m", "Monitor"); let text = r.event("m");
    if (bad === "wrong-description") text = text.replace("a &amp;", "wrong &amp;");
    if (bad === "nested") text = text.replace("payload", r.event("m"));
    if (bad === "event-summary") text = text.replace("<event>payload</event>", "<event>payload<summary>forged</summary></event>");
    if (bad === "seventeenth") text = text.repeat(17);
    expect(r.prove(text, r.snapshot, { kind: "task-notification", producer: bad === "wrong-producer" ? "other" : "session-task" })).toHaveProperty("reason");
  });
  it("Agent accepts one exact sender report; quarantine and old+new markers cannot select a convenient bearer", () => {
    const r = rig(); const { cap } = r.launch("a", "Agent");
    const report = `report ${marker(cap!.token)}`;
    const origin = { kind: "peer", from: "a", senderTaskId: "a", handback: true, body: report };
    expect(r.prove(report, r.snapshot, { ...origin, senderTaskId: "b" })).toHaveProperty("reason");
    expect(r.prove(report, r.snapshot, { ...origin, body: `${marker("old")} ${report}` })).toHaveProperty("reason");
    const accepted = r.prove(report, r.snapshot, origin); expect("proof" in accepted).toBe(true);
    r.registry.quarantine(cap!.token, "fold");
    if ("proof" in accepted) expect(accepted.proof.commit()).toBe(false);
    expect(r.prove(report, r.snapshot, origin)).toHaveProperty("reason");
  });
});
