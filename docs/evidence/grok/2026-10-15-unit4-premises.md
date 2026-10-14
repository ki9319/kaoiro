---
title: Grok model and effort switching, usage shape and /context
date: 2026-10-15
---

# Grok model and effort switching, usage shape and /context

Linux measurements with Grok Build 1.0.52 and ACP SDK 1.8.0 for
[issue #593](https://github.com/sakuraiyuta/kaoiro/issues/593). They describe
observed premises, not guarantees for later engine versions. Rows M1 to M12
were measured with a scratch ACP client against the real `grok agent stdio`
and with the TUI driven in a pty. Rows N1 to N3 were measured with the
production host and the same pty procedure. Token counts, prompts and model
output were not recorded; only booleans, token differences and digit widths
are given.

| ID | Probe | Observation |
|---|---|---|
| M1 | `session/new` | `configOptions` has two `select` options: `model` (category `model`, four values, `currentValue`) and `reasoning_effort` (category `thought_level`, `xhigh`, `high`, `medium`, `low`) |
| M2 | `initialize` `_meta.modelState` | `currentModelId` and `availableModels[]` with `modelId`, `name`, `description`, `_meta.totalContextTokens`, `_meta.contextWindows[2]`, `_meta.reasoningEfforts[]` (`value`, `default`). `totalContextTokens` equals `contextWindows[0]`; all four models report the same value; `grok-4.5` lists only `high`, `medium`, `low` |
| M3 | `session/set_config_option` on `reasoning_effort` and `model` | Returns the full `configOptions` with the new `currentValue` in 3 to 12 ms. A `session/update` `config_option_update` and a `_x.ai/session_notification` `model_changed` (`model_id`, `reasoning_effort`) follow at once. No session re-creation, no process restart |
| M4 | The turn after a switch | The prompt result `_meta.modelId` and the `turn_completed.usage.modelUsage` key reflect the new model. The usage key is the backend name (`grok-4.7-build`), the config value is `grok-4.7`; they differ for the default model and coincide for `grok-4.7-build-fast` |
| M5 | Invalid value | JSON-RPC error `-32602` "Invalid params"; `currentValue` unchanged |
| M6 | Model switch while the effort is `xhigh`, to `grok-4.5` | Accepted; `reasoning_effort` stays `xhigh` although the model's option list has no `xhigh`. Grok does not reset it |
| M7 | Switch during a running turn (three model calls) | Accepted immediately; the running turn's later model calls use the new model (`modelUsage` has both keys), while the prompt result `_meta.modelId` still names the model at turn start |
| M8 | `session/load` in a second process after switches | The load response carries `configOptions` with the switched values, `_meta["x.ai/sessionDetail"].currentModelId` matches, and a `model_changed` notification is emitted. The selection lives in the session, not in the process |
| M9 | Usage shape | Each model call ends with `_x.ai/session_notification` `response_completed` carrying `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `reasoning_tokens`). `turn_completed.usage` is the turn's sum (`modelCalls`, `numTurns`, `modelUsage` per backend model). `PromptResponse.usage` is null; the numbers are in `_meta` |
| M10 | TUI `/context` after a one-call turn and after a three-call turn | Headline "used / window tokens (percent)" plus the model name. `window` equals `totalContextTokens`. `used` equals the last model call's `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`; the turn sum and the prompt result's turn total do not match after the three-call turn. The TUI also has a `/context-window` command that changes the window per model; it is not reachable over ACP. N1 and N2 refine this row |
| M11 | `/context` through ACP (`session/prompt` and headless `-p`) | Consumed as a command: no text, no usage. The number is only visible in the TUI |
| M12 | Quota | The TUI dialog has a "Usage limit" tab; nothing equivalent appears in `initialize`, `session/new`, updates or vendor notifications |

Production host against the TUI (work unit 4 implementation):

| ID | Probe | Observation |
|---|---|---|
| N1 | Last call's prompt size against the `/context` percentage, four sessions each resumed in the TUI: two plain turns, one tool turn, a tool turn then a plain turn, a three-call tool turn | The TUI percentage, converted back to tokens, was 4 to 9 tokens below the last call's prompt size; the percentage resolution is 26 tokens. Equal after flooring the percentage to two decimals, not after rounding: the TUI floors. The `used` figure matched to the TUI's 0.1k rounding. The window matched `totalContextTokens` |
| N2 | A session whose only model call is its first one (one plain turn), resumed in the TUI | The TUI `used` has four digits and the call's prompt size five (about 46,000 tokens apart); the percentage is correspondingly small. From the second model call of a session the TUI matched (N1), so M10's one-call match is inferred to have come from a session that already had earlier calls |
| N3 | Production host: a tool-call turn, a model switch and an effort switch while idle, then another tool-call turn; each resumed in the TUI | `ext.context` matched the TUI (used to 0.1k, percentage floored to two decimals, window) before and after the switch. After the switch `ext.model` and `ext.effort` were the requested ones with source `config` and nothing pending; two `model_changed` notifications arrived for the two requests; `ext.context` was absent after the switch and present again after the next turn on the new model; the TUI named the switched model. The host logged no disagreement between a Grok report and its last returned value |
