---
title: "Issue #595: background promotion and Workflow notifications"
status: in_progress
last_updated: 2026-10-14
---

# Issue #595: background promotion and Workflow notifications

Plan for [issue #595](https://github.com/sakuraiyuta/kaoiro/issues/595).
Independent design review approved this plan in round 2 (must 0; cumulative
must 1) on 2026-10-14. Follow-up to the issue #422 acceptance work.
Related: issue #426 (stage 2 is out of scope) and issue #214 (C6 lands after
this change).

## Problem and rationale

A Claude Code peer gets `unbound_tool_call` from `send_to_agent` after
background work completes, with no Agent subagent involved. Two separate
paths fail (items 1 and 2), and item 3 also affects existing paths. Items 1
and 2 were reproduced on production release `64aa00ae` with SDK
0.3.293 and CLI 2.1.293 through `runClaudeCli`, the real SDK and CLI, and a
loopback model endpoint. Explicit `run_in_background: true` Bash controls
passed in the same setup, both folded into the live turn and as an
independent notification turn.

1. **Bash moved to the background by its timeout.** The native sequence is
   `task_started` (`task_type: local_bash`, `is_backgrounded: false`), then
   `background_tasks_changed`, then `task_updated` with
   `patch.is_backgrounded: true`, then `task_updated` with a status patch, then
   `task_notification`, then a root `UserPromptSubmit` that reuses the live
   wrapper turn's `prompt_id`. The host registers a background task only from
   `task_started.is_backgrounded` (`wrapper/claude-code/src/host.ts:2762-2764`
   on develop `6c0c806c`). `task_updated` reaches the
   `unrecognized task_* message` warning (`host.ts:2766-2781`) and is dropped.
   `#rememberNotification` (`host.ts:2194-2196`) then creates no candidate,
   the same-ID notification hook fails the match, and `#admitPrompt` taints
   the owner (`host.ts:2301-2312`). PreToolUse refuses to bind a tainted owner
   (`host.ts:2471`), so every later root `send_to_agent` in that turn is
   unbound.
2. **Workflow completion.** `task_started` carries
   `task_type: local_workflow`, `workflow_name` and the script as `prompt`,
   and has no `is_backgrounded` field. The tool result says the workflow
   launched in the background. The completion arrives as `task_notification`
   and then as a root `UserPromptSubmit` with a fresh `prompt_id` after the
   wrapper turn ended. The notification prompt carries `<task-id>`,
   `<tool-use-id>`, `<output-file>`, `<status>`, `<summary>`, `<result>` (the
   script's return value) and `<diagnostics>` (a path and fixed guidance
   text). The workflow is never registered, and the matcher accepts only
   `local_bash` and `local_agent` (`host.ts:2284-2297`). The hook therefore
   opens a foreign root occupancy (`host.ts:2331`), which grants no send
   authority.
3. **Escaped text in the hook prompt.** Design review found a third gap that
   also affects the existing paths. The CLI XML-escapes `<summary>` (and the
   Agent `<result>`) in the hook prompt, but the SDK frame carries the raw
   text. The host compares raw strings, so any Bash, Agent or Workflow
   notification whose text contains `&`, `<` or `>` is not admitted. The
   measurements are in "Notification text comparison" below.

Line numbers were rechecked on develop `6c0c806c`. They differ by up to four
lines from the investigation, which cited `64aa00ae`. `wrapper/claude-code`
and `wrapper/agent-common` are unchanged between the two commits.

The fix belongs at the admission boundary. The safeguards there are sound;
they lack evidence for two native task shapes.

## Options

| Option | Summary | Decision |
|---|---|---|
| A. Bounded repair of the existing admission | Track the measured promotion edge for `local_bash`, register `local_workflow` explicitly, add a Workflow-specific match. Keep every existing check. | **Adopted** |
| B. Rework task lifecycle tracking | Normalize started, updated and notification events into one per-run task state for all types. | Rejected for now. It overlaps the issue #214 C6 root/fold rework and the issue #426 stage 2 hand-back work, and its scope is several times larger. |
| C. Use `background_tasks_changed` membership as the background signal | Covers late promotion and workflows with one level signal. | Rejected. The SDK type documentation says its ordering relative to the task bookends is unspecified and tells consumers not to correlate it with the edge stream. |
| D. Treat any `task_notification` as a candidate | Smallest change. | Rejected. A foreground Bash also emits `task_notification` (measured: empty `output_file`, no prompt follows). Registering it would widen admission without evidence. |

## Scope

1. Replace `#backgroundTaskIds: Set<string>` with a bounded task record map
   keyed by `task_id`. Each record holds `runId` (optional), `taskType` and
   `background: boolean`. Records need no session field: a frame naming
   another session clears them (the existing session-change path) before
   any task frame is applied, so every record belongs to the host's current
   session.
2. Create records from `task_started`. Apply
   `task_updated.patch.is_backgrounded` to `local_bash` records under the
   rules below. Create notification candidates only from records with
   `background: true`.
3. Register `local_workflow` records and add a Workflow branch to the
   notification match.
4. Bind the notification frame to its record by `session_id` and `run_id`.
5. Compare the text fields (`<summary>`, and `<result>` for Agent) through
   one function for all task types, Bash and Agent included. The CLI
   XML-escapes these fields in the hook prompt, and the existing Bash and
   Agent matches fail for any summary containing `&`, `<` or `>`. Other
   fields keep raw equality. A late-promoted Bash whose command contains
   `2>&1` would stay unbound without this, so the class is closed here
   rather than only for Workflow (director decision during design,
   2026-10-14).
6. Update the docs listed at the end.

Out of scope:

- Agent hand-back admission (issue #426 stage 2) and the task lifecycle rework
  (issue #214).
- Promotion of a foreground `local_agent` to the background. The SDK documents
  it, but it is not measured. A promoted Agent keeps today's behaviour: it
  gets no candidate, and its notification taints or opens a foreign
  occupancy. File a follow-up if needed.
- `task_updated` status patches. They stay out of the `task` envelope, and
  the existing fail-visible warning stays. Changing the dashboard task
  lifecycle belongs to issue #214.
- Workflows launched by a subagent (`parent_task_id` present). They are not
  registered.

## Decision rules

### Task records

| Event | Rule |
|---|---|
| `task_started`, `local_bash` or `local_agent` | Create a record. `background = (is_backgrounded === true)`. |
| `task_started`, `local_workflow` | Create a record when `is_backgrounded !== false` and `parent_task_id` is absent. `background = true`. Measured: the field is absent and the tool launches in the background. If the SDK ever sends `false`, the workflow is treated as foreground. |
| `task_started`, other types | No record. These types have no matcher. |
| `task_started` for a `task_id` that already has a record, same `run_id` (both present and equal, or both absent) | Keep the record. `background` stays true if either the record or the new start says background; a repeated start never undoes a promotion. |
| `task_started` for a `task_id` that already has a record, newer `run_id` | Replace the record. The SDK keeps `task_id` and gives a resumed task a new `run_id`, and run ids of one task sort by plain string comparison in opening order. |
| `task_started` for a `task_id` that already has a record, older `run_id` or `run_id` on one side only | Ignore the frame and keep the record. |
| Record cap reached (64) | Do not record. Warn once per overflow. This fails closed to today's behaviour. |
| `task_notification` that matches its record | Matching means the record exists and `run_id` matches it: both absent, or both present and equal. Remove the record. Create a candidate only when `background` is true. The existing candidate cap (16) still applies. |
| `task_notification` that does not match | Ignore the frame. Keep the record, so a later notification for the current run still matches. |
| Clear points | Clear all records wherever `#clearNotificationCandidates` runs today: close, interrupt, fail-stop, session change, a notification result under a wrapper turn, and stream EOF. |

### When to trust `task_updated`

The host applies `patch.is_backgrounded` only when **all** of the following
hold:

- a record with the same `task_id` exists;
- the record's `taskType` is `local_bash`;
- the frame's `run_id` equals the record's `runId`, or both are absent.

Any other `task_updated` is ignored by the registry, with no buffering:

| Case | Result |
|---|---|
| Duplicate `is_backgrounded: true` | Idempotent; `background` stays true. |
| `is_backgrounded: false` on a matching record | Set `background` to false. The latest fact for the same run wins, and the effect fails closed. |
| Update before `task_started` (unknown task) | Ignored. A later `task_started` creates a foreground record. Not observed natively. |
| Update after `task_notification` (record removed) | Ignored. It never re-creates a record or a candidate. |
| Different `session_id` | The frame first clears every record (session change), so nothing is promoted. |
| `run_id` mismatch, or present on only one side | Ignored. This includes a late frame from an earlier run. |
| Status-only patch | Ignored by the registry. The existing warning stays. |
| `local_agent` or `local_workflow` record | Ignored (see Out of scope). |

The admission checks after the candidate exists are unchanged: one-use
candidates, `session_id`, `task_id`, `tool_use_id`, `status`, consumed
candidate exclusion, child-origin (`agent_id`) rejection, foreign occupancy,
the 10-second idle clock, and owner tainting on a mismatched same-ID
notification.

### Notification text comparison

Measured on release `64aa00ae`, SDK 0.3.293, CLI 2.1.293: 18 native cases
for explicit background Bash and background Agent, idle and fold, plus the
Workflow traces from design review r1. Each case records the SDK
`task_notification` frame and the hook prompt for the same task.

| Prompt field | SDK value it is compared with | Representation in the prompt | Rule |
|---|---|---|---|
| `<summary>` (Bash, Workflow) | `summary` | XML-escaped: `&` to `&amp;`, `<` to `&lt;`, `>` to `&gt;`. `"`, `'` and LF unchanged. A value already containing `&amp;` becomes `&amp;amp;` (one pass). | `notificationTextMatches` |
| `<result>` (Agent) | `summary` | Same escape as above | `notificationTextMatches` |
| `<output-file>` | `output_file` | Not escaped. A path containing `<&>"'&amp;` is identical in both. | Raw equality |
| `<task-id>`, `<tool-use-id>` | `task_id`, `tool_use_id` | Identical in every case | Raw equality |
| `<status>` | `status` | Identical | Raw equality |

Before this change every Bash and Agent case whose summary contained `&`, `<`
or `>` was rejected, both folded and independent. The existing matches
compare raw strings. A Bash summary uses the tool `description` when one is
given and the command otherwise, so a common command such as one containing
`2>&1` is enough to break admission.

Rule: `notificationTextMatches(trusted, shown)` returns true only when
`shown` (the prompt value) equals `trusted` (the SDK value) or
`xmlEscape(trusted)` exactly. `xmlEscape` replaces `&` with `&amp;` first,
then `<` with `&lt;` and `>` with `&gt;`, and changes nothing else. It is
used for the text fields above and nowhere else. Fields that the CLI does
not transform keep raw equality, so an escaped path is rejected.

- The prompt value is never decoded. Decoding would let prompt content
  change tag boundaries and would make `&amp;lt;` ambiguous.
- The raw form is accepted as well as the escaped one, so a text without
  `&`, `<` or `>` matches exactly as before. A CLI version that stops
  escaping would still match. Accepting it adds no path to a different task.
  The candidate is looked up by the parsed `task_id` and bound to the SDK
  frame by `session_id` and `run_id` (the hook carries no run id). The
  prompt's `tool_use_id`, `status` and output file are then compared under
  their existing rules, and the text comparison is a second check on top.
  The text never selects a candidate.
- A trusted value containing `&amp;` matches only itself or `&amp;amp;`.

The output-file result marks where the transform stops, between fields the
CLI transforms and fields it does not. Neither the field choice nor the
transform changed.

### Workflow match

Trusted fields come from the SDK `task_notification` frame and the
`local_workflow` record created by `task_started`. Each prompt field is
compared with them:

| Prompt field | Rule |
|---|---|
| `<task-id>` | Must name a candidate whose record type is `local_workflow` |
| `<tool-use-id>` | Must equal the frame's `tool_use_id` (existing check) |
| `<status>` | Must equal the frame's `status` (existing check) |
| `<output-file>` | Must be present, non-empty and single, and equal to the frame's `output_file` (raw) |
| `<summary>` | Must be present, and `notificationTextMatches(frame.summary, value)` |
| `<result>` | Optional and **never compared**. It is the script's return value, has no SDK counterpart, and is model- or script-controlled. |
| `<diagnostics>` | Optional and never compared |

The Agent branch compares the SDK summary with `<result>` and allows the
output file to be omitted. The Workflow branch does neither. The Bash branch
requires `<result>` to be absent; the Workflow branch does not.

The existing parser (`host.ts:710-736`) rejects text outside the
`<task-notification>` blocks, requires `<task-id>` and `<status>`, and checks
the `<output-file>` tag shape. Any field that appears zero times or more than
once parses as `undefined`. The matcher requires the text fields it
compares (`<summary>`, or `<result>` for Agent) and the Bash and Workflow
`<output-file>` to be defined, so each appears exactly once. Two existing
optional comparisons stay as they are: `<tool-use-id>` is compared as an
optional value, so it matches when both the candidate and the prompt lack
it (`host.ts:2286`), and the Agent branch may omit `<output-file>`. No new
required guard is added. `<result>` and `<diagnostics>` are not compared for
Workflow and may be absent. The Agent `<result>` is escaped (measured).
For a Workflow script that returns an object, this pinned CLI escapes `&`,
`<` and `>` inside the JSON text of `<result>` as well, and the real parser
reads the prompt as one well-formed notification (measured with a returned
object containing `<summary>`, `</task-notification>` and `&amp;`). Other
return types and other CLI versions are not measured. If raw Workflow
`<result>` text ever contains a tag such as `<summary>` or
`</task-notification>`, parsing fails or the match fails. Either way the
hook is not admitted (the owner taints, or a foreign occupancy opens), which
fails closed. This is not widened here, and a negative control pins it.

## Verification plan

Native tests use the built CLI and the pinned SDK and CLI with only the model
provider and Phoenix as loopback fixtures, following
`wrapper/claude-code/test/cli_delivery_policy_native.test.ts`. Unit fixtures
in `host.test.ts` replay the measured frame shapes field for field:
`run_id`, the `background_tasks_changed` frames, the status-patch
`task_updated`, the foreground notification with an empty `output_file`, and
the Workflow prompt with `<result>` and `<diagnostics>`. A single hand-written
`is_backgrounded: true` start does not satisfy this plan.

### Acceptance

1. **Native, Bash promotion.** Confirmed wrapper input sends once. Then
   `Bash({ command: "printf START; sleep 7; printf BG_DONE", timeout: 5000 })`
   runs without `run_in_background`. The test asserts that the trace contains
   `started(false)` and then `updated(true)` for the same task and run,
   followed by the notification. A foreground `sleep 4` Bash keeps the turn
   live, the notification folds into the same `prompt_id`, and the next
   `send_to_agent` reaches the transport. A run without the
   `started(false) → updated(true)` pair is reported as not reproduced, not as
   passed.
2. **Native, Workflow, idle.** A scratch workflow script with one child agent
   runs. The root ends its turn, the completion opens a fresh `prompt_id`, the
   host starts an `sdk_notification` turn (`onTurnStart` with that kind), and
   `send_to_agent` reaches the transport.
3. **Native, Workflow, fold.** The same workflow, followed by a foreground
   `sleep 5` Bash that keeps the wrapper turn live. The completion folds into
   the same `prompt_id`, the owner is not tainted, and the next
   `send_to_agent` reaches the transport.
4. **Native, escaped text.** Positive runs whose text the CLI escapes, each
   ending with `send_to_agent` reaching the transport:
   - a Workflow whose script throws (stack with `<anonymous>`), and a
     Workflow whose description contains `<xml> &`;
   - an explicit background Bash whose description contains `&`, `<` and
     `>`, idle and folded;
   - an explicit background Bash with no description and `2>&1` in the
     command, so the summary carries the command;
   - a background Agent whose result contains `<`, `&` and `>`, idle and
     folded;
   - a Bash and an Agent whose text already contains `&amp;` (shown as
     `&amp;amp;`);
   - acceptance 1 repeated with `2>&1` in the promoted command.
   A Bash whose output path contains `<&>"'&amp;` stays admitted under raw
   path equality.
5. **Existing controls stay green.** An explicit background Bash folded into
   the live turn, the same Bash as an independent notification, foreground
   only, and the current `host.test.ts` notification suite.

### Negative controls

Each row is a test that passes when the host behaves as listed. "Red" in the
table means a mutation: the named guard is removed in the implementation,
the named test fails, and the guard is restored before the next mutation.
Rejecting a bad input is a passing test, not a red result.

| Control | Expected |
|---|---|
| Promotion handling disabled | Acceptance 1 is red (`unbound_tool_call`) |
| Workflow registration disabled | Acceptance 2 and 3 are red |
| Workflow type branch disabled, registration kept | Acceptance 2 and 3 are red |
| `session_id` change on `task_updated` | Records cleared; no promotion |
| `run_id` mismatch on `task_updated` (earlier run, present on one side only) | No promotion |
| `task_updated` before `task_started` | No promotion |
| `task_updated` after `task_notification` | No record or candidate re-created |
| `is_backgrounded: false` after `true` | No candidate |
| Notification `run_id` differs from the record (with a different summary), then the correct notification for the current run arrives | No candidate from the first; the second is admitted |
| A record from before a session change, then a notification for the same task in the new session | Not admitted |
| Notification `run_id` present on one side only, then the correct notification | Same as above |
| Repeated `task_started` for the same run after `updated(true)` | `background` stays true; the notification is admitted |
| `task_started` for an older run after the current run's start | Ignored; the current run's notification is admitted |
| Mismatched `task_id`, `tool_use_id`, `output-file` path or `summary` in the prompt (Bash and Workflow separately) | Not admitted |
| `notificationTextMatches` reduced to raw equality | Acceptance 4 is red |
| `xmlEscape` replaces `&` after `<` and `>` | Acceptance 4 is red (double-escaped `&amp;lt;`) |
| Summary that differs from the trusted text after escaping (Bash, Agent, Workflow separately) | Not admitted |
| Prompt summary that is the decoded form of an escaped trusted value (trusted `a&lt;b`, shown `a<b`) | Not admitted |
| `notificationTextMatches` applied to `<output-file>` too | A prompt whose `<output-file>` is the escaped form of the frame path is admitted, so the raw-path test is red |
| Workflow prompt with no `<output-file>` | Not admitted |
| Workflow `<result>` containing a nested `<summary>` tag | Not admitted (pins the fail-closed parse) |
| The same candidate consumed twice | The second hook is not admitted |
| `send_to_agent` from a child (`agent_id` set) during the admitted turn | Unbound |
| Notification during a foreign occupancy | Folds without a token; send unbound |
| `local_agent` record with `updated(true)` | No promotion (pins the scope limit) |
| Workflow `task_started` with `parent_task_id` | Not registered |
| Record cap reached | New task not recorded; warning emitted |

The full `wrapper` suite runs with exit code 0 and the reported pass count.
Each mutation records the guard it removed, the failing test and the exit
code.

### Release class

The change alters which root hooks the wrapper admits, so it can affect
completing a turn on the default wiring. It is a TL candidate under
[High-risk change release](../operations/high-risk-change-release.md). Treat
it as high risk unless the implementation reviewer writes a reason that it
answers no to both questions.

## Overlap with issue #214 C6

This lands first; the C6 owner carries it over. The frozen branch
`issue-214-server-queue` (`bcc56f31`) does not touch the regions this change
edits; that was read from its `host.ts` diff against develop. No rebase was
performed, and this is not a verified rebase: the branch also lacks changes
that landed on develop after it was frozen. The meaning overlaps in these
places:

| Region (develop line, `bcc56f31` line) | Overlap | What C6 must keep |
|---|---|---|
| SDK message loop task registration (`2762`, `2768`) | The record map replaces `#backgroundTaskIds` here | Record creation and `task_updated` handling run before `#rememberNotification` on every frame |
| `#rememberNotification` and `#clearNotificationCandidates` (`2194-2232`, `2200-2238`) | Candidates now come from records, and clears also drop records | Every C6 reset, fail-stop or session path that clears candidates also clears records |
| `#admitPrompt` matcher (`2282-2297`, `2288-2303`) | New Workflow branch | C6 root/fold readiness must classify a matched Workflow hook like a matched Bash hook: fold with a same-ID owner, independent turn on a fresh ID when idle |
| Notification candidate clocks and occupancy (`2331`, `2337`) | Unchanged here | C6 changes to clock pausing must cover Workflow candidates. Like Bash candidates, they arrive both during a live wrapper turn (measured: same-ID fold) and when idle (measured: fresh ID). |

C6 also re-runs this plan's native acceptance tests on its final input path.
Landing #214 alone does not fix this issue, because `bcc56f31` has the same
gaps.

## Docs to update

- `docs/reference/engines/claude-events.md`: replace the
  "`task_updated` (undocumented; out of scope)" row. Describe the
  `is_backgrounded` promotion as used for admission only, the record rules,
  and the Workflow notification match. Mention that a promoted `local_agent`
  is not admitted. In the Agent paragraph and the new Bash and Workflow
  text, state that `<summary>` and the Agent `<result>` accept the trusted
  value or its XML escape, that the output file and IDs need raw equality,
  and that the prompt is never decoded.
- `docs/reference/inter-agent/reply-basis.md` (Claude row): name the
  notification sources (explicit or promoted background Bash, background
  Agent, Workflow).
- `docs/evidence/claude/`: add a dated evidence page with the measured native
  sequences and the per-field representation table in general form (field
  names, order and transforms, no local paths), and the mutation results
  from implementation.
