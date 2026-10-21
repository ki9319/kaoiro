---
title: SDK 0.3.306 native notification and peer framing
status: measured
last_updated: 2026-10-22
---

# SDK 0.3.306 native notification and peer framing

This follows [issue #700](https://github.com/sakuraiyuta/kaoiro/issues/700)
on candidate `3df476dcfa29a6af6616bfe9fb5e9d1d1ad27ff2`, based on develop
`18adea69`. The initial [upgrade record](sdk-0.3.306-2026-10-22.md) used an
older base; its suite results do not establish acceptance of this candidate.
The runtime remains SDK **0.3.306 / CLI 2.1.306**, Linux x64 native executable
SHA-256 `520bc6c1f40af466bd03a278b5ae1af1a2938bc7de5b9e5cb15526da20d71cfe`.

## Native method and observations

The [structured observations](native-shapes-2026-10-22.json) record the
measurement snapshots. Both invoke the built production CLI, which constructs
the actual Host, transport, SDK and bundled executable. Only the external
provider and Phoenix service are loopback fixtures. Every case owns fresh
HOME/config/cwd/TMPDIR, uses a placeholder API key and removes its directories
and directly spawned child. No model service or production peer is contacted.
The runtime source is unchanged from the candidate; only tests and evidence
are updated after these observations.

Monitor uses the six cases in
`wrapper/claude-code/test/monitor_notification_advice_native.test.ts`, following
[the original measurement](../monitor-notification-advice-2026-10-20.md).
All six pass: completion with event, event-only persistent command, setting
absent, gate absent, background Bash, and event folded into a live owner.
Each records one send at the Phoenix transport. Completion/event-only
skeletons and the exact advice bytes/position match the previous frozen
capture. Both absent-input controls omit the advice; the live fold keeps the
newer reply number. This proves transport admission, not server acceptance
or delivery to another real peer.

The first unchanged-provider attempt failed before notification generation:
CLI 2.1.306 defers Monitor and the MCP send tool. The fixture now calls the
real `ToolSearch` with `select:Monitor,mcp__kaoiro__send_to_agent` when those
tools are not offered. Native notification text is never supplied by the
fixture. This is a test-provider adaptation; product tool settings are unchanged.

Peer measurement follows the production composition and background Agent
hand-back used for the recorded golden introduced by
[`b7d22219`](https://github.com/sakuraiyuta/kaoiro/commit/b7d22219e5c4a6ca189c3864dc7b6d5c08872cfb)
and the report-token boundary in
[`9b1b3f37`](https://github.com/sakuraiyuta/kaoiro/commit/9b1b3f37be653e9654727653c5c5fde5abfb3999).
The scripted provider launches `Agent(run_in_background: true)` in auto mode,
returns JSON `<severity>0</severity>` for the native classifier, and has the
real child invoke `SubagentHandback` with the marker found in its actual
injected prompt. It never invents a native row, hook frame or task identity.
The native transcript's queued frame and complete root user row are compared
with the old golden, normalizing only the task identity and random report
marker. The complete preamble, descendant warning, report indentation and
frame boundaries are byte-equal to the old capture. The current
`matchesPeerOpener` accepts the real row/frame. A subsequent genuine native
root sends once through the existing wrapper proof to the Phoenix fixture,
and both wrapper results complete.

The new transcript also carries `queueSkipSlashCommands: true` and
`origin.handbackReportText`; the old golden did not retain these fields.
`origin.body`, `handback`, sender/task identity and the proof-relevant framing
remain present. No runtime change is needed. The transcript observation is
not a claim that every SDK replay frame includes `origin.body`.

The peer fixture is a new redacted capture, not an edited old-version row.
Historical captures remain available under their original filenames. The
background-notification admission suite retains its explicitly historical
0.3.293 traces; its scope is broader than this bump's live Bash control.

## Catalog

The production `runProbe` was repeated with a forwarding-only observation of
`initializationResult().models`; it exits 0, returns 13 models and emits no
stderr. The prompt never yields a user message. The new raw fixture is
`test/fixtures/claude-agent-sdk-0.3.306.models.json`, SHA-256
`83de29af21e4ea4a93b65aa9a15a354a66f2eba3f96f150b02207d0a96efda27`.
Compared with the previous raw fixture, `supportsThinkingOff` is newly present
on all 13 rows. Model aliases, resolved ids, effort levels and the production
catalog projection are unchanged. No synthetic canonical Haiku row is added.

## Validation boundary

The frozen candidate's six wrapper suites, runner, server and dashboard,
wrapper/runner typechecks, and the ToolSearch wiring's red/restored control
are recorded separately in the implementation handoff. The new fixture and
version/binary pins must be reviewed together. This record does not authorize
a production rollout or permission-setting change.
