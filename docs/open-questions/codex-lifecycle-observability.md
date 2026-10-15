---
title: Transition observability and resume support for the Codex engine
description: Codex compaction registration and lifecycle acceptance remain deferred pending issue 662.
status: deferred
urgency: low
blocks: []
opened: 2026-08-31
decided: 2026-08-31
---

# Transition observability and resume support for the Codex engine

## 背景

Resume in [ADR-0055](../adr/0055-compaction-resume-and-lifecycle-log.md)
depends on local observation of `compact_boundary`, and `request_compact` is
Claude-only (Codex has no `/compact` path and assumes engine-side
auto-compaction). For now, Codex session_lifecycle records will also contain
only the disconnect-related events known to the server.

## 選択肢

- A: Investigate a Codex SDK method for observing compaction and add a producer
  if it is observable
- B: Retain the engine-side auto-compaction premise and leave it out of scope

## 影響

The Codex agent's timeline contains only disconnect-related events, so behavior
caused by compaction cannot be investigated afterward.

## 判断材料

Whether a confirmed compaction-boundary event appears in the Codex SDK event
specification ([codex-sdk-events](../reference/engines/codex-exec-events.md)).

Re-measured 2026-09-14 (issue #347): `@openai/codex-sdk` 0.153.4 ships no
compaction symbol in `dist/` and `codex exec --help` offers no compaction
option, so `request_compact` stays Claude-only. Reconfirmed unchanged at
0.156.1 (issue #399, 2026-09-23). Unmeasured: whether a
`/compact` prompt passed to `codex exec` compacts (the Track S measurement
exists only for Claude). If it does, reusing the Codex approval gate that now
serves `request_session_reset` (ADR-0043 amendment) can be considered for
`request_compact` — a working `/compact` alone does not prove the whole
descriptor carries over. Candidate for a separate issue.

## 暫定方針

B (operator ruling 2026-08-31: treat this, including surrounding unimplemented
and unsupported areas, as a future task. Claude-only support is sufficient for a
while).

## App-server follow-up (2026-10-15)

The designer of [issue #661](https://github.com/sakuraiyuta/kaoiro/issues/661#issuecomment-6187334587)
reported `thread/compact/start` and `thread/compacted` symbols in CLI 0.160.0.
This is a reported binary-symbol observation, not independent verification of
runtime semantics or of the repository's 0.161.0 pin. Re-measure on the pinned
CLI and establish completion, cancellation, resume, and lifecycle behavior in
[issue #662](https://github.com/sakuraiyuta/kaoiro/issues/662). Codex
`request_compact` remains unregistered. Its eventual bridge registration can
use the same engine-policy gate as `request_session_reset`.
