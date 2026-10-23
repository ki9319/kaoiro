import "../../../scripts/test/fixtures/test-isolation.mjs";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { PermissionControlExt, PermissionObservation, PermissionSelection, PermissionSubmission, PermissionSyncMessage } from "@kaoiro/protocol";
import * as grok from "../src/permission_state.js";
import { applyPermissionSyncState as codexSync, createPermissionState as codexInitial } from "../../codex/src/permission_state.js";
import { pairs, type Row, type Report } from "./differential/scenarios.js";
const directory = new URL("../../../protocol/fixtures/permission-differential/", import.meta.url);
// Rejoin input and expected output both come from the server fixture. These
// rows check adoption; the Elixir drift test independently validates the input.
const scenarios = JSON.parse(readFileSync(new URL("scenarios.json", directory), "utf8")) as {
  rows: Row[]; reports: Report[]; rejoin_report: string;
};
const expected = JSON.parse(readFileSync(new URL("expected.json", directory), "utf8")) as {
  rows: [[number, string, number, number | null], [number, number], number][]; controls: PermissionControlExt[];
};
const pick = (r: number, p: number): PermissionSelection => ({ revision: r,
  requested: { sandbox: pairs[p]![0], network_access: pairs[p]![1] } });
const pairIndex = (s: PermissionSelection) => pairs.findIndex(p => p[0] === s.requested.sandbox && p[1] === s.requested.network_access);
const compact = (s: PermissionControlExt) => [s.revision, s.status, pairIndex(s)];
const report = (s: PermissionControlExt): Report => s.submitted
  ? [s.revision, s.status, pairIndex(s), s.submitted.revision]
  : [s.revision, s.status, pairIndex(s)];
const now = "2026-01-01T00:00:00Z";
interface Snapshot { state: grok.PermissionState; submission: PermissionSubmission | null; ceiling: PermissionSelection }
it("agrees with actual server transitions for every bounded event sequence", () => {
  const snapshots: Snapshot[] = [];
  let compared = 0, excluded = 0, captures = 0, gated = 0;
  for (const [id, row] of scenarios.rows.entries()) {
    const [parent, event, reportIndexes, gateCode, gateRevision, capture] = row;
    const server = expected.rows[id]!;
    if (parent < 0) {
      const initial = pick(0, event);
      snapshots.push({ state: grok.createPermissionState(initial, true), submission: null, ceiling: initial });
      continue;
    }
    const prior = snapshots[parent]!;
    let { state, submission, ceiling } = prior;
    const reports: Report[] = [];
    if (event <= 2) {
      const selection = pick(server[0][0], event + 1);
      const reason = !grok.withinCeiling(selection, ceiling) ? "exceeds_launch_ceiling"
        : event === 1 ? "unsupported_permission_pair" : undefined;
      state = grok.requestPermission(state, selection, reason);
      expect(state.latest?.rolled_back_to, `originated relay report ${id}`).toBeUndefined();
      reports.push(report(state.latest!));
    } else if (event === 3) {
      submission = grok.capturePermission(state, "execution");
      expect(submission ? [submission.revision, pairIndex(submission)] : null, `capture ${id}`).toEqual(capture);
      if (submission) {
        captures++;
        expect([submission.revision, pairIndex(submission)]).toEqual(server[1]);
      } else gated++;
    } else if (event === 4) {
      state = grok.permissionLaneFailed(state, submission!, "load", now);
      if (state.latest?.revision === submission!.revision) {
        expect(state.latest.rolled_back_to, `originated lane report ${id}`).toBeUndefined();
      }
      reports.push(report(state.latest!));
      submission = null;
    } else if (event === 5 || event === 6) {
      const s = submission!;
      state = grok.beginPermissionExecution(state, s);
      reports.push(report(state.latest!));
      if (event === 5) {
        const observation: PermissionObservation = { ...s, session_id: "session", turn_id: "prompt",
          permission: { sandbox: s.requested.sandbox, approval: "on-request", enforcement: "os" },
          network_access: grok.effectiveNetworkAccess(s.requested) };
        state = grok.permissionObservationApplied(state, observation).state;
      } else state = grok.permissionObservationFailed(state, s, now);
      reports.push(report(state.latest!));
      submission = null;
    } else {
      expect(server[1], `rejoin server next ${id}`).toEqual(expected.rows[parent]![1]);
      if (event === 8) ceiling = pick(0, 3);
      const message: PermissionSyncMessage = { version: "0", control: expected.controls[server[2]]!,
        next: pick(...server[1]) };
      // Compare the sync functions with the same pre-state. Codex cannot
      // represent unknown next, so supply the server's last known next there.
      const codex = codexSync({ ...codexInitial(state.baseline, true), latest: state.latest,
        next: state.next ?? pick(...expected.rows[parent]![1]), current: state.current,
        lastEffective: state.lastEffective, appliedRevisions: state.appliedRevisions,
        blocked: state.gate?.reason === "observation_unavailable"
          ? { revision: state.gate.revision, reason: state.gate.reason } : null,
      }, message);
      state = grok.applyPermissionSyncState(state, message, ceiling, now);
      if (!grok.withinCeiling(message.next, ceiling)) excluded++;
      else {
        compared++;
        expect(compact(state.latest!), `Codex latest ${id}`).toEqual(compact(codex.latest!));
        expect(state.next, `Codex next ${id}`).toEqual(codex.next);
      }
    }
    expect(reports, `reports ${id}`).toEqual(reportIndexes.filter((i): i is number => typeof i === "number")
      .map(i => scenarios.reports[i]));
    expect(compact(state.latest!), `latest ${id}`).toEqual(server[0].slice(0, 3));
    const unknown = gateCode === 1 || gateCode === 3;
    expect(state.next ? [state.next.revision, pairIndex(state.next)] : null, `next ${id}`)
      .toEqual(unknown ? null : server[1]);
    expect(state.gate?.reason ?? null, `gate ${id}`).toBe(gateCode === 0 ? null
      : gateCode === 2 ? "observation_unavailable" : "awaiting_server_next");
    if (gateCode) expect(state.gate?.revision, `gate revision ${id}`).toBe(gateRevision);
    snapshots.push({ state, submission, ceiling });
  }
  console.log(JSON.stringify({ scenarios: snapshots.length, codex_sync_compared: compared,
    codex_sync_excluded: excluded, captures, gated_captures: gated }));
  expect(compared).toBeGreaterThan(0); expect(excluded).toBeGreaterThan(0); expect(gated).toBeGreaterThan(0);
}, 30_000);

it("rejoining wrappers report the entire adopted server control, including rollback", () => {
  expect(scenarios.rejoin_report).toBe("adopted_server_control");
  let rejoined = 0, rollbacks = 0;
  for (const [id, [parent, event, reports]] of scenarios.rows.entries()) {
    if (parent < 0 || event < 7) continue;
    expect(reports, `rejoin report marker ${id}`).toEqual(["adopted_server_control"]);
    const server = expected.rows[id]!;
    const control = expected.controls[server[2]]!;
    // Revision zero has no newer server control to adopt.
    if (control.revision === 0) continue;
    const baseline = pick(0, event === 8 ? 3 : 0);
    const message: PermissionSyncMessage = { version: "0", control, next: pick(...server[1]) };
    const restored = grok.applyPermissionSyncState(grok.createPermissionState(baseline, true), message, baseline, now);
    expect(restored.latest, `adopted control report ${id}`).toEqual(control);
    rejoined++;
    if (control.rolled_back_to) rollbacks++;
  }
  expect(rejoined).toBeGreaterThan(0);
  expect(rollbacks).toBeGreaterThan(0);
  console.log(JSON.stringify({ rejoined_control_reports: rejoined, rollback_reports: rollbacks }));
});
