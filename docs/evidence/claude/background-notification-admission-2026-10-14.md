---
title: Claude background notification admission (issue #595)
status: measured
last_updated: 2026-10-14
---

# Claude background notification admission (issue #595)

Target: [issue #595](https://github.com/sakuraiyuta/kaoiro/issues/595),
plan [issue-595](../../plans/issue-595-background-promotion-and-workflow-notifications.md).
Runtime: SDK 0.3.293, native CLI 2.1.293, Linux x64. The fixed code is the
built `wrapper/claude-code` at commit `e3cc8b07`. The pre-fix control is
production release `64aa00ae`, which has the same `wrapper/claude-code` and
`wrapper/agent-common` sources as develop `6c0c806c`.

## Method

Each case runs `runClaudeCli` with the real `AgentHost`, SDK and native CLI.
Only two parts are replaced: the model provider (a loopback HTTP endpoint
returning scripted tool calls) and the server link (a stub that records each
`sendInterAgent`). HOME, the config directory, cwd and TMPDIR are throwaway
directories, and `settingSources` is empty. A *fold* case keeps the wrapper
turn live with a foreground Bash, so the notification reuses the root
`prompt_id`. An *idle* case ends the root turn first, so the notification
opens a fresh `prompt_id`.

A case passes only when all of the following hold:

- the probe exits 0;
- the number of sends reaching the stub is 2 for fold cases (one before and
  one after the notification), 1 for idle cases and 1 for `foreground`;
- no `unbound_tool_call` tool result appears;
- the turn starts are `[wrapper]` for fold cases and
  `[wrapper, sdk_notification]` for idle cases.

Promotion cases must also show `task_started(is_backgrounded: false)` and
then `task_updated(patch.is_backgrounded: true)` for the same task and run.
Escaped cases must show a hook `<summary>` (or Agent `<result>`) that
differs from the SDK frame text.

## Native sequences

Bash moved to the background by its timeout (`timeout: 5000`, no
`run_in_background`): `task_started` (`local_bash`, `is_backgrounded: false`),
`background_tasks_changed`, `task_updated` (`patch.is_backgrounded: true`),
`task_updated` (status patch), `task_notification`, then a root
`UserPromptSubmit` that reuses the live wrapper turn's `prompt_id`.

Workflow: `background_tasks_changed`, then `task_started` (`local_workflow`,
`workflow_name`, script `prompt`, no `is_backgrounded`), `task_progress`, a
`task_updated` status patch, and `task_notification`. The completion arrives
both while a wrapper turn is live (same `prompt_id`) and after it ended
(fresh `prompt_id`). The prompt carries `<result>` (the return value) and
`<diagnostics>`.

## Field representation

| Prompt field | SDK value | Representation in the prompt |
|---|---|---|
| `<summary>` (Bash, Workflow) | `summary` | `&`, `<` and `>` escaped once; `"`, `'` and LF unchanged; `&amp;` becomes `&amp;amp;` |
| `<result>` (Agent) | `summary` | Same escape |
| `<result>` (Workflow, object return) | none | JSON text with `&`, `<` and `>` escaped |
| `<output-file>` | `output_file` | Unchanged, including a path containing `<&>"'&amp;` |
| `<task-id>`, `<tool-use-id>`, `<status>` | same names | Unchanged |

A Bash summary uses the tool `description` when given and the command
otherwise.

## Results

Fixed build (`e3cc8b07`):

| Case | Sends | Unbound | Turn starts | Result |
|---|---:|---:|---|---|
| `foreground` | 1 | 0 | wrapper | pass |
| `bash-fold` (explicit background) | 2 | 0 | wrapper | pass |
| `bash-idle` (explicit background) | 1 | 0 | wrapper, sdk_notification | pass |
| `bash-late-promote` | 2 | 0 | wrapper | pass |
| `bash-late-promote-redirect` (`2>&1` in the command) | 2 | 0 | wrapper | pass |
| `workflow-idle` | 1 | 0 | wrapper, sdk_notification | pass |
| `workflow-fold` | 2 | 0 | wrapper | pass |
| `workflow-failed-idle` (stack with `<anonymous>`) | 1 | 0 | wrapper, sdk_notification | pass |
| `workflow-escaped-idle` (description with `<xml> &`) | 1 | 0 | wrapper, sdk_notification | pass |
| `bash-symbols-fold` | 2 | 0 | wrapper | pass |
| `bash-symbols-idle` | 1 | 0 | wrapper, sdk_notification | pass |
| `bash-command-idle` (no description, `2>&1`) | 1 | 0 | wrapper, sdk_notification | pass |
| `bash-entity-idle` (`&amp;`) | 1 | 0 | wrapper, sdk_notification | pass |
| `bash-special-path-idle` (output path with `<&>"'&amp;`) | 1 | 0 | wrapper, sdk_notification | pass |
| `agent-symbols-fold` | 2 | 0 | wrapper | pass |
| `agent-symbols-idle` | 1 | 0 | wrapper, sdk_notification | pass |
| `agent-entity-idle` (`&amp;`) | 1 | 0 | wrapper, sdk_notification | pass |

Pre-fix release (`64aa00ae`), same probe and checker:

| Case | Sends | Unbound | Turn starts | Result |
|---|---:|---:|---|---|
| `bash-idle` (control) | 1 | 0 | wrapper, sdk_notification | pass |
| `bash-late-promote` | 1 | 1 | wrapper | fail |
| `bash-late-promote-redirect` | 1 | 1 | wrapper | fail |
| `workflow-idle` | 0 | 1 | wrapper | fail |
| `workflow-fold` | 1 | 1 | wrapper | fail |
| `bash-symbols-idle` | 0 | 1 | wrapper | fail |
| `agent-symbols-idle` | 0 | 1 | wrapper | fail |

Native mutations: one guard was removed from the fixed source, the package
rebuilt (build exit 0) and one case re-run. Each check failed (exit 1):

| Mutation | Case | Check result |
|---|---|---|
| `task_updated` handling removed | `bash-late-promote` | sends 1, unbound 1 |
| Workflow registration disabled | `workflow-idle` | sends 0, unbound 1, no notification turn |
| Workflow match branch disabled | `workflow-fold` | sends 1, unbound 1 |
| Text match reduced to raw equality | `bash-symbols-idle` | sends 0, unbound 1, no notification turn |
| Text match reduced to raw equality | `agent-symbols-idle` | sends 0, unbound 1, no notification turn |

The unit suite `wrapper/claude-code/test/background_notification_admission.test.ts`
replays these frame shapes. Removing each of its 22 guards one at a time
(promotion, Workflow registration and match, text comparison and escape
order, output-file raw equality, run-id rules, record keeping on a
mismatched notification, task-type and subagent limits, record cap and
warning, session-change clearing) makes at least one of its tests fail.

## Limits

The Workflow `<result>` escaping was measured only for an object return
value on this CLI. A promoted `local_agent` was not measured and is not
admitted. The stub server link records sends; it does not measure server
acceptance or peer delivery.
