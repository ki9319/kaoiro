---
title: Grok permission-switch measurements
date: 2026-10-14
---

# Grok permission-switch measurements

These are the approved design's Linux measurements with Grok Build 1.0.52
and ACP SDK 1.8.0 for [issue #591](https://github.com/sakuraiyuta/kaoiro/issues/591).
They describe observed premises, not guarantees for later engine versions.
Raw records are retained outside the public repository; prompts, responses,
credentials and installation details are omitted here.

| ID | Probe | Observation |
|---|---|---|
| M1 | Initialize and create session | `loadSession: true`; no session modes returned |
| M2 | Set an unknown mode | Succeeded with an empty response; unsuitable as proof of a permission change |
| M3 | Load the same session with another process sandbox | Load succeeded and replayed history; the new process profile was enforced, while the session summary retained the creation profile |
| M4 | Trusted project custom profile | Honoured; custom profiles are outside this unit |
| M5 | Unknown custom profile | Rejected before a session was created |
| M6 | Effective profile report | Neither ACP nor inspect reports it; the observation is the declared projection of the spawned profile |
| M7 | Workspace write, then read-only load using the old stdio bridge | Workspace allowed the cwd write and literal-IP connection; read-only denied both. Its bridge could not connect to the Unix socket because of seccomp. This led to issue #604 |
| M8 | HTTP MCP after load | Both restrictive profiles reached authenticated tools/list. The new load used its new headers; an old token at a new listener received 401 |
| M9 | Cancel during early model thinking | Cancelled response carried a nonempty promptId, equal to requestId and the vendor completion id. Other cancellation positions were not measured |
| M10 | Read-only tools/call after workspace session load | HTTP handler ran once, using only the new generation's token; prompt result had a promptId |
| M11 | Real server permission state | Off controls require enforcement in constraints. The server derives pre-application fallback; an older failed report cannot replace a newer selection. Adding submitted prevents classification as pre-application |
| M12 | Forty short turns, then read-only load | Initialize 129 ms; load response 181 ms; 82 replay updates; spawn to authenticated tools/list 327 ms. This probe did not include tool-heavy history |

## Reproducible implementation checks

`wrapper/grok/test/native-permission-switch.test.ts` exercises the production
`runGrokCli`, engine and broker with a callback ServerLink substitute. Its
three-turn switch reads the filesystem and a local listener's connection
count, checks session continuity and promptId, and requires an HTTP tool call
in every generation. The long-history case uses 30 shell-and-MCP turns before
a load and reports readiness latency. It does not assert a timing threshold.
These checks do not claim a real server or dashboard connection.

The real ServerLink composition test uses a Phoenix wire peer and a fake ACP
child. The Elixir channel tests separately check the server contract. The
committed differential fixtures connect both state implementations; the
Elixir drift test recomputes expectations with the real server state module.
