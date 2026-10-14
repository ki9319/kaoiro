// An independent model of the event table, not imports from permission_state.
export const pairs = [
  ["danger-full-access", true], ["workspace-write", true],
  ["workspace-write", false], ["read-only", false],
] as const;
export const events = ["workspace", "unsupported", "readonly", "capture", "lane_failed",
  "result_with_prompt_id", "result_without_prompt_id", "rejoin", "rejoin_narrower"];
export type Pick = [number, number];
export type Report = [number, string, number, number?];
export type Row = [number, number, (number | "adopted_server_control")[], number, number, Pick | null];
// Gate codes: 0 open, 1 awaiting next after lane failure, 2 observation, 3 ceiling.
interface Model {
  latest: Report; next: Pick; counter: number; prior: Pick;
  unknown: boolean; gate: number; gateRevision: number;
  captured: Pick | null; cur: number; ceiling: number;
}
const profile = (p: number) => p === 2 ? 1 : p;
const allowed = (p: number, ceiling: number) => ceiling !== 3 || p === 3;
function advance(source: Model, event: number): { state: Model; reports: Report[]; capture: Pick | null } | null {
  const s = structuredClone(source), reports: Report[] = [];
  let capture: Pick | null = null;
  if (event <= 2) {
    if (s.counter >= 3) return null;
    const p = event + 1, revision = ++s.counter;
    s.prior = s.next;
    if (p === 2 || !allowed(p, s.ceiling)) {
      s.latest = [revision, "failed", p]; reports.push(s.latest);
    } else {
      s.next = [revision, p]; s.latest = [revision, "pending", p];
      s.unknown = false; s.gate = 0; reports.push(s.latest);
    }
  } else if (event === 3) {
    if (s.captured) return null;
    if (!s.unknown && s.gate === 0) capture = s.captured = [...s.next];
  } else if (event === 4) {
    if (!s.captured || profile(s.captured[1]) === s.cur) return null;
    const [r, p] = s.captured;
    if (r === s.latest[0]) {
      s.latest = [r, "failed", p];
      // The server's ledger fallback, not the wrapper's local next.
      s.next = s.prior;
    }
    reports.push(s.latest);
    if (!source.unknown && source.next[0] === r) { s.unknown = true; s.gate = 1; s.gateRevision = r; }
    s.captured = null; s.cur = -1;
  } else if (event === 5 || event === 6) {
    if (!s.captured) return null;
    const [r, p] = s.captured;
    reports.push(r === s.latest[0] ? [r, "applying", p, r] : s.latest);
    if (r === s.latest[0]) s.latest = [r, event === 5 ? "applied" : "unknown", p, r];
    reports.push(s.latest);
    if (event === 6 && !s.unknown && s.next[0] === r) { s.gate = 2; s.gateRevision = r; }
    s.cur = profile(p); s.captured = null;
  } else {
    if (event === 8) s.ceiling = 3;
    if (!allowed(s.next[1], s.ceiling)) {
      s.unknown = true; s.gate = 3; s.gateRevision = s.next[0];
    } else {
      s.unknown = false;
      if (s.gate !== 2 || s.next[0] > s.gateRevision) s.gate = 0;
    }
  }
  return { state: s, reports, capture };
}
export function enumerate(depth: number) {
  const rows: Row[] = [], reports: Report[] = [], indexes = new Map<string, number>();
  const intern = (r: Report) => {
    const key = JSON.stringify(r); let n = indexes.get(key);
    if (n === undefined) { n = reports.length; reports.push(r); indexes.set(key, n); }
    return n;
  };
  function visit(parent: number, state: Model, level: number) {
    if (level === depth) return;
    for (let event = 0; event < events.length; event++) {
      const result = advance(state, event); if (!result) continue;
      const id = rows.length;
      rows.push([parent, event, event >= 7 ? ["adopted_server_control"] : result.reports.map(intern), result.state.gate,
        result.state.gate === 0 ? -1 : result.state.gateRevision, result.capture]);
      visit(id, result.state, level + 1);
    }
  }
  for (const p of [0, 1]) {
    const initial: Model = { latest: [0, "pending", p], next: [0, p], counter: 0,
      prior: [0, p], unknown: false, gate: 0, gateRevision: -1, captured: null, cur: p, ceiling: p };
    const id = rows.length;
    rows.push([-1, p, [intern(initial.latest)], 0, -1, null]);
    visit(id, initial, 0);
  }
  return { version: 1, depth, pairs, events, reports, rows,
    rejoin_report: "adopted_server_control" };
}
