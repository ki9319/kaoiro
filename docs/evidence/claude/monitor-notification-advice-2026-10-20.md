---
title: Claude Monitor notification advice
status: implementation-validation-pending
last_updated: 2026-10-20
---

# Claude Monitor notification advice

Target: [issue #697](https://github.com/sakuraiyuta/kaoiro/issues/697).
Runtime: **SDK 0.3.293 / bundled CLI 2.1.293**. The standalone CLI is not
the wrapper's runtime. This extends the [background notification evidence](background-notification-admission-2026-10-14.md).

## Grammar and provenance

A Monitor event or completion-with-event block may end with this exact line,
immediately after `</event>` and before `</task-notification>`:

```text
If this event is something the user would act on now, send a PushNotification. Routine or benign output doesn't need one.
```

Only the whole remaining body may match, and its preceding field must be
`event`. The line is optional and may occur once per block. Existing whitespace
framing is retained; text inside the line is not normalized. Unknown prose,
changed text, duplicate lines, a line without an event, a line before the
event, outside the block, or followed by another element remain malformed.
The change adds no source or authority fallback. Agent, Bash and Workflow
still reject an event field under their existing source-specific proof rules.

`test/fixtures/monitor_notifications.json` was extracted from genuine
user/system task-notification rows on CLI 2.1.293. It preserves both event-only
and completion-with-event skeletons and advice bytes; task/call ids, output
path, summary and event scalars are masked. The fixture does not import the
production literal. Genuine 2.1.284 and 2.1.289 transcript rows independently
show the same sentence and terminal position. Static inspection of CLI
2.1.296 finds the same template and emission conditions; that is not a
2.1.296 admission measurement.

## Emission prerequisites

Read-only inspection of bundled CLI 2.1.293 shows that the body builder adds
the line only for a non-housekeeping notification when both the GrowthBook
gate `tengu_kairos_push_notifications` and settings value
`agentPushNotifEnabled` are true (both default false). Monitor availability
separately requires `tengu_amber_sentinel`. Housekeeping notices omit the line.

The production wrapper omits `settingSources`; the current SDK defaults to
`["user", "project", "local"]`. The historical 2026-06-22 SDK-default note in
`sdk-boundaries-2026.md` is not the behavior of this pinned SDK.

Before implementation, a real built `runClaudeCli({})`, default Host, SDK and
bundled CLI at `d4ce26cc7cf3be2e7596487fe8bd96429ddd58e9` generated the line in
an isolated environment with `settingSources` omitted, a throwaway user
`settings.json` containing `agentPushNotifEnabled: true`, and the two gates
seeded in the throwaway global config's `cachedGrowthBookFeatures`. The
genuine completion-with-event row identified CLI 2.1.293. With the setting
absent under the same composition, the line was absent. With the setting
present but `settingSources: []`, it was also absent. Therefore the earlier
empty-sources background probe cannot reproduce this defect. No operator
settings, credentials or live feature service were used.

Prerequisite run: `fuji-d4ce26c-697shape-1020210722-6b68.8bcd58aa9f1b417b`,
helper result `pass`, exit 0. This measured generation, not fixed-wrapper
send acceptance. The event-only path shares the inspected body builder;
fixed-wrapper runtime observations are recorded separately below.

## Implementation validation

The implementation validation records will name the code commit, native
send/refusal observations, isolated guard mutations and restored package
gates. Until those measurements are recorded, this document claims only the
pre-implementation generation observation above.

On every SDK bump, rerun the notification-shape and send-admission probes as
part of the release-class gate required by ADR-0063's 2026-10-10 Amendment.
A changed sentence is not silently accepted.
