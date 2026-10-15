---
title: Grok session directory, transcript shape and the replayed history
date: 2026-10-15
---

# Grok session directory, transcript shape and the replayed history

Linux measurements with Grok Build 1.0.52 over stdio ACP for
[issue #645](https://github.com/sakuraiyuta/kaoiro/issues/645). They describe
observed premises, not guarantees for later engine versions. Only names,
lengths, key paths and booleans were recorded; prompts, model output and
credentials are omitted. The scratch sessions and their directories were
removed.

| Probe | Observation |
|---|---|
| `session/new` in a cwd with space, `'`, `(`, `)`, `!`, `*`, `~`, `#`, `&`, `%`, `+`, `,`, `;`, `=`, `@`, `$` and non-ASCII text | The group directory name equals `encodeURIComponent(cwd)` with `! ' ( ) *` replaced by `%21 %27 %28 %29 %2A` (uppercase hex). `~` and `.` stay as they are. Plain `encodeURIComponent` does not match |
| `session/new` in a cwd of 541 bytes (571 bytes encoded) | The group is a directory named `<hex>-<hex>` (57 characters, not the encoded cwd). It holds a `.cwd` file whose content equals the cwd exactly, with no trailing newline, and the session directory |
| `updates.jsonl` right after `session/new` | The file already exists, before any prompt |
| `updates.jsonl` of 40 sessions (775 lines) | Every line is a JSON object with `method`, `params` and an integer `timestamp`. `session/update` carries `user_message_chunk` (`_meta`, `content`), `agent_thought_chunk`, `agent_message_chunk`, `tool_call` (`_meta`, `rawInput`, `title`, `toolCallId`) and `tool_call_update` in two shapes: a progress update with `kind`, `locations`, `rawInput`, `title` and `content` but no `status`, and a final one with `content` and `status`. `_x.ai/session/update` carries `hook_execution`, `turn_completed` and `background_tasks` |
| Native acceptance: a tool-call turn, then a resumed host with a hydration request | The replay sent a reset, then `user` (with the marker), `tool_use` (string id, object input), `tool_result` (the same id and tool name, string output) and a last `assistant`, then the completion. Every entry's time fell inside the turn's wall-clock window. With the seconds read as milliseconds the same test failed (times in January 1970) |
