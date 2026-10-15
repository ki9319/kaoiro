---
title: Grok cold resume and session discovery
date: 2026-10-15
---

# Grok cold resume and session discovery

Linux measurements with Grok Build 1.0.52 over stdio ACP for work unit 3a
([issue #644](https://github.com/sakuraiyuta/kaoiro/issues/644), designed in
[issue #592](https://github.com/sakuraiyuta/kaoiro/issues/592)). They describe
observed premises, not guarantees for later engine versions. Only method
names, key paths, counts, booleans and model ids were recorded. Prompts,
model output and token values are omitted. Scratch cwds, their sessions and
their memory workspaces were deleted.

| Observation | Result |
|---|---|
| `initialize` capabilities | `loadSession: true`, `sessionCapabilities: {list, resume, close}` |
| `session/list {cwd}` | Only that cwd's sessions. Entries carry `sessionId`, `cwd`, `title`, `updatedAt` and `_meta.x.ai/session`. Without `cwd` the list is paged with `nextCursor`. An `initialize` + `session/list` process answered in about 0.1 to 0.45 s, ran no hooks and created no session |
| A session just made by `session/new` | Not listed at once. After 1.5 s it is listed, in the same process and in a fresh one. A process killed right after `session/new` leaves no session |
| `session/resume` in a fresh process | No history replay before the response. The response carries `configOptions`, `models` and `_meta.x.ai/sessionDetail`. Non-history `session/update` `available_commands_update` follows |
| Unknown id, or a session made under another cwd | `-32603` for both `session/resume` and `session/load` |
| Model after a switch and a turn | Kept by the session. A fresh process resuming or loading it reports the switched model |
| `_meta.rules` given at creation | Survive a fresh-process resume (design review measurement) |
| A second process resuming a session another process holds | Succeeds, both while the owner is idle and during its turn (design review measurement) |
| Sandbox after a resume under another profile | Tool runs follow the new process's launch profile, not the profile saved with the session (design review measurement; the native test `native-resume` pins a `workspace` session resumed `read-only`) |
| Memory workspace name | `~/.grok/memory-v2/workspaces/<cwd basename without leading dots, lowercased>-<8 hex>` |

The native tests `wrapper/grok/test/native-resume.test.ts` and
`runner/test/grok_sessions.native.test.ts` (`KAOIRO_LIVE_GROK=1`) check the
resume, two further resumes with no drift, a differing pick applied before the
first prompt, the other-cwd refusal, the launch profile, and discovery under
the exact cwd. They remove only their own scratch cwd and its session group.
The memory workspace Grok makes for each cwd stays: its name carries the cwd
basename and a hash, and nothing measured ties that hash to the full cwd, so a
workspace of another cwd with the same basename cannot be told apart. Their
buildup is tracked in issue #650.
