# Daemon home and maintenance — 2026-10-28

Source classification and native lifetime evidence for
[issue 859](https://github.com/sakuraiyuta/kaoiro/issues/859), following the
[approved design](https://github.com/sakuraiyuta/kaoiro/issues/859#issuecomment-6448846854).
No production inventory or account credentials are part of this evidence.

## Versioned producer evidence

| Entry | Both-pin producer/consumer | Decision |
|---|---|---|
| `app-server-control` | Unix transport rendezvous and startup lock | Disposable, with runtime presence/lock refusal |
| `app-server-daemon` | Daemon settings and loaded-thread recovery plus runtime entries | Preserve admitted state; reject runtime authority before copying |
| `packages` | Daemon-managed executable/resource releases, current/version selection | Preserve state, executable modes and links; include size in capacity |
| `tui-thread-reference-capabilities` | TUI records and reads per-thread empty markers | Preserve state: existence affects resumed tool capability |

The upstream commits are `979011409de0a60b52f179721948e65531d26144` (0.161.0)
and `6aaac694803004a63c6f393d153c96d22521a6b9` (0.164.0).

- Control creation: [0.161.0](https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/app-server-transport/src/transport/unix_socket.rs#L44-L133),
  [0.164.0](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server-transport/src/transport/unix_socket.rs#L46-L146).
  Startup holds the home lock until acceptor installation, not throughout the listener lifetime.
- Stale-endpoint checks and clean Drop: [0.161.0 checks](https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/app-server-transport/src/transport/unix_socket.rs#L228-L279),
  [Drop](https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/app-server-transport/src/transport/unix_socket.rs#L338-L365),
  [0.164.0 checks](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server-transport/src/transport/unix_socket.rs#L269-L320),
  [Drop](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server-transport/src/transport/unix_socket.rs#L512-L544).
- Daemon paths: [0.161.0](https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/app-server-daemon/src/lib.rs#L325-L349),
  [0.164.0](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server-daemon/src/lib.rs#L351-L379).
  Both use `settings.rs` and transport `daemon_recovery.rs` for persisted configuration/recovery.
- Package selection and offline executables: [0.161.0](https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/app-server-daemon/src/managed_install.rs#L17-L70),
  [0.164.0](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server-daemon/src/managed_install.rs#L17-L70).
- Marker read/write: [0.161.0](https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/tui/src/app_server_session.rs#L552-L569),
  [0.164.0](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/app_server_session.rs#L622-L639).
- Listener-only stop: [0.161.0](https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/app-server-daemon/src/lib.rs#L615-L649),
  [0.164.0](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server-daemon/src/lib.rs#L658-L692).
  The independent updater separately handles SIGTERM in `update_loop.rs`.

## Credential-free native observations

The pre-design experiments used isolated homes on the dedicated test worker,
network-disabled test execution and explicit child environments. Both pinned
binaries had their actual managed listener and updater concurrently alive.
Package selection was seeded with the pinned binary in the upstream layout;
this is not a network-installer or TUI-marker creation test. No inference turns
or account were used.

| Observation | 0.161.0 | 0.164.0 |
|---|---|---|
| `daemon stop` alone, negative control | Listener stops; updater stays alive | Same |
| Updater TERM then matching native `daemon stop` | Both terminate | Both terminate |
| Control alias after clean listener stop | Removed | Removed |
| Control directory/startup lock | Remain, same lock inode | Same |
| Listener PID record after managed stop | Removed | Removed |
| Updater PID record after TERM | Remains | Remains |
| Updater socket after TERM | Dead socket remains | Socket alias removed |
| Existing home lock via read-only inherited fd | Unheld flock exit 0; held exit 75 | Same |

A separate controlled stale-entry cleanup removed only the experiment's own
stopped updater PID/socket entries, retaining settings/logs/lock files. The
negative observation does not satisfy quiescence merely because stop returned
success. Restart after an owned forced exit recreated a usable Unix listener;
this does not demonstrate history restoration. Both successful lifecycle probes
exited 0 with no helper body stderr. Native diagnostics were captured, so this
is not a zero-native-warning claim. All owned processes, trees and concrete
temporary socket paths were cleaned.

Binary SHA-256:

- 0.161.0: `9a820c17865fa825d04db416818679a9d63bd72e50835c396f496e5684626c9c`
- 0.164.0: `b93f6811d3f653f0fb83be4050d857fb9abbb111dfa2ce160563327daff7f306`

Implementation tests fix CLI admission, snapshot/restore preservation, refusal
at stopped/resumed replacement boundaries, descriptor release and fail-closed
checker errors. Final commit, test runs and single mutations are recorded with
the implementation PR; the pre-design probes do not certify those later bytes.
