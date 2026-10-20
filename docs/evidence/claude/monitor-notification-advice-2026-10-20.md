---
title: Claude Monitor notification advice
status: measured
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

Code and test commit: `0730142eb01f7ac115b26e27a5c818d06b6e6dc1`.
Only `continuation_markers.ts` changes production behavior. The fixture
matches the design extraction (SHA-256
`0a9f2c23232e5bb7a09a35cfb4850491a9f55b1244bb6af0a9c3d87def3a2250`).

The committed `monitor_notification_advice_native.test.ts` launches the built
CLI with its default constructors and external loopback provider/Phoenix
fixtures. Every case omits `settingSources` and uses fresh throwaway
HOME/config/cwd/TMPDIR. The cache seeds the Monitor gate and, except in its
contrast, the push gate. The child environment disables remote feature
fetching while retaining cache reads, as described below. No real
credentials or peer messages are used. An owned HTTP barrier keeps the
command from producing its event before the root ends; no notification text
is injected.

The positional assertion is retained in `test/fixtures/monitor_notifications.ts`
and called on the actual native blocks. Its test rejects changed/misplaced
trailers. Native observations cover:

- A completion-with-event notification with the exact terminal line, followed
  by an existing-conversation response using the launch's original reply
  number. Its genuine user/system transcript opener has a different prompt
  id from the completed root.
- A command Monitor requested with `persistent: true`, whose event-only
  notification arrives while the command remains alive. The genuine opener
  has no status/completion fields, carries the exact line and permits a
  fresh-conversation inform. Thus the event-only shape is measured, not
  inferred solely from the shared body builder. This does not claim that
  the CLI honors an unlimited lifetime; the probe ends its own session.
- The same default composition with the user setting absent, and separately
  with the push gate absent but the user setting present. Both genuine
  notifications omit the line and both retain send admission.
- A background Bash completion control that retains admission.
- A Monitor launched under reply number 1, followed by a new confirmed root
  under reply number 3. Its event folds into that live owner while a
  foreground Bash remains active (and is later promoted by its timeout).
  The real provider request contains the native notification in a tool
  result, without a new user transcript row; the send retains number 3.
  This distinguishes preservation from incorrectly replacing the current
  owner's basis with the older Monitor basis. The CLI's delivery lifecycle
  logs only wrapper starts, so it is not used to count native owners.
  This is an existing-owner preservation control, not a detector of the
  terminal-advice parser change.

All native cases reach the recording Phoenix transport once, with no unbound
result. The default-configuration focused run also passes typecheck and the
parser/proof/host suites. Run
`fuji-0730142-697focus-1020212813-3a0e.ad86efdcc3f64bed`: helper `pass`, exit 0.
This measures wrapper acceptance at the transport boundary, not production
server acceptance or peer delivery.

### Isolated mutations

The source and verifier were committed before mutation. Each change was
applied alone to the real parser in an isolated run; the compiled native
wrapper was rebuilt for the native controls. Neither a build failure nor an
unrelated refusal counts as a red.

| Mutation | Corresponding failing assertions | Result |
| --- | --- | --- |
| M1: remove the terminal-advice branch | Captured positive parser/proof cases; native completion response expects a send and observes none | red, exit 1 |
| M2: remove only the preceding-event condition | No-event terminal advice must be malformed, in both captured shapes through parser and proof | red, exit 1 |
| M3: replace whole-remainder equality with prefix matching | Duplicate advice and extra suffix must be malformed; marker/extra tagged-element controls also fail | red, exit 1 |

On M1's rebuilt native wrapper, the explicit refusal control confirms
`native_notification_malformed`, an `unbound_tool_call` result and no
outgoing send. The default positive fails its send-count assertion on that
same mutation. Restoring the exact parser bytes returns the unit control and
rebuilt native positive to green. M2's before-event input is not claimed as
its detector: whole-remainder equality still refuses that case independently.

Mutation/control run:
`fuji-0730142-697mut-1020213016-9b79.57309dcf293ecfa2`, helper `pass`, exit 0
(the expected-red child commands individually exit 1). The unchanged source
SHA-256 before and after is
`1e951e26e4c130ddd7683a33c35f35d3211db40d1546a668f21766c3453e010b`.
Native cases emit the SDK's `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning for the
explicitly allowed fixture tools; PreToolUse hooks and the wrapper's send
proof remain active. Synthetic host rigs emit their existing
`supportedModels()` retry warning. These runs report no unhandled errors.

### Deterministic feature inputs with network access

The initial native results above were obtained without network access.
[CI run 39425272327](https://github.com/sakuraiyuta/kaoiro/actions/runs/39425272327)
at `dcf92e82e466e82104fcc2f68cf9c6791ac8cdaf` exposed an invalid test
assumption: omitting the push gate from the disk cache does not force it off.
The pinned CLI prefers a fetched GrowthBook feature payload over its disk
cache. With network access, the unmodified `gate-absent` test reproduced
the CI positional assertion failure: a genuine notification contained the
advice. A separate fresh-config observation showed the previously absent
gate become `true` in the CLI's saved cache.

The native fixture now sets both of these child-only environment values:

```text
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF=1
```

In SDK 0.3.293 / CLI 2.1.293, the first stops remote feature fetching; the
second permits disk feature reads while that traffic is disabled in the
fixture's first-party provider mode. Disabling fetching alone also disables
the seeded Monitor gate, so both values are needed. This changes test inputs,
not production configuration or notification text. The optional
`gate-absent` contrast is retained rather than dropped.

Fresh-config probes with network available measured the advice absent with
the push gate omitted, present with the push gate seeded `true`, and absent
with the user setting omitted despite a seeded `true` gate. Each checks the
actual line's terminal position after `</event>`. These observations support
the two test environment inputs; the gate's emission condition also remains
grounded in the inspected bundled CLI. Cache seeding by itself is not a
network-independent control.

On every SDK bump, rerun the notification-shape and send-admission probes as
part of the release-class gate required by ADR-0063's 2026-10-10 Amendment.
A changed sentence is not silently accepted.
