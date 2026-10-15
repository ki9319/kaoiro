---
title: Grok launch catalog and the quota check
date: 2026-10-15
---

# Grok launch catalog and the quota check

Linux measurements with Grok Build 1.0.52 (`grok 1.0.52 (0920c8169e27)
[stable]`) for work unit 3c
([issue #646](https://github.com/sakuraiyuta/kaoiro/issues/646), designed in
[issue #592](https://github.com/sakuraiyuta/kaoiro/issues/592) r2 and r3).
They describe observed premises, not guarantees for later engine versions.
Only methods, URL pathnames, counts and model ids were recorded. Prompts,
model output, headers and token values were not.

## Recorder at Grok's API base (design r2)

A loopback HTTP recorder logged the method and path of each request,
answered 503 and refused `CONNECT`. `GROK_CLI_CHAT_PROXY_BASE_URL`,
`GROK_XAI_API_BASE_URL` and all proxy variables pointed at it, and Grok ran
inside `unshare --user --map-root-user --net`, so only loopback existed.

| Run | Requests seen |
|---|---|
| `grok models` | `GET /v1/models` x2, `GET /v1/settings` x6 |
| `initialize` + `session/list` | `GET /v1/models` x2, `GET /v1/settings` x5 |
| `initialize` + `session/new` | `GET /`, `GET /v1/models` x2, `GET /v1/settings` x4 |
| `initialize` + `session/new` + one `session/prompt` | the GETs above, refused `CONNECT`s for the configured MCP servers, and `POST /v1/responses` x7 (retries) |

The prompt never reached a model, and `grok usage` reported no usage for any
of the four sessions. A syscall trace of the list probe counted 7 connects to
the recorder's loopback port and 1 `AF_UNIX` connect, with no other address.

On the host network, through a forwarder that passed only `GET /v1/models`,
`/v1/settings`, `/v1/feedback/config` and `/` upstream and refused everything
else, `grok models` printed the live list (4 models), `initialize` +
`session/list` sent no request at all (the model state came from Grok's
cache), and one prompt sent `POST /v1/responses` x7, all refused. The
forwarder was a one-off measurement and is not committed.

## Grok's built-in model list

When `GET /v1/models` fails, `grok models` prints a built-in list of 2 models
with a different default, exits 0 and writes nothing to stderr. Inside the
namespace, `initialize` did the same: it fetched `/v1/models`, got 503, and
returned the same 2 models with no field that marks them. On the host
network with a fresh cache, `initialize` returned the cached 4 models
without fetching. Nothing in either answer separates the built-in list from
a live one.

## Model requests are what the check counts (design r3)

The recorder logged the method and the URL pathname (an absolute-form proxy
target reduced to its pathname, the query dropped), and only the fact of a
`CONNECT`. All six proxy variables pointed at it, with `NO_PROXY` empty, in a
nested `unshare --net`.

| Run | Base URLs | Requests | Model requests (`POST /v1/responses`) | `CONNECT` | Outside the GET set |
|---|---|---:|---:|---:|---:|
| `initialize` | overridden | 9 | 0 | 0 | 0 |
| `initialize` + `session/list` | overridden | 9 | 0 | 0 | 0 |
| `initialize` + `session/new` | overridden | 9 | 0 | 0 | 0 |
| one `session/prompt` | overridden | 27 | 6 | 6 | 12 |
| the same prompt | removed | 23 | 0 | 23 | 23 |

With the base URLs removed, Grok sends its model traffic through `CONNECT`
tunnels, where the path cannot be seen, so a check that counts only
`POST /v1/responses` fails rather than passes. `initialize` also fetched
`GET /v1/bundle/archive` and `GET /v1/subagents/bundle`; with `/`,
`/v1/models`, `/v1/settings` and `/v1/feedback/config` they are the measured
GET set. A syscall sample of the design review counted 10 `AF_INET` connects,
all to the recorder, and 1 `AF_UNIX` connect to the system bus socket: a
network namespace leaves filesystem Unix sockets reachable, so the claim is
no IP connection to anything but the recorder.

## The committed check

`runner/test/grok-catalog-quota.native.test.ts` runs the production
`probeGrokCatalog` and `listGrokSessions` with only their executable replaced
by a launcher that enters a new network namespace, starts the recorder there
and then becomes Grok. One run on 2026-10-15:

| Run | Requests | Model requests | `CONNECT` | Outside the GET set |
|---|---:|---:|---:|---:|
| positive control: `session/new` + one prompt, until the first model request | 12 | 2 | 2 | 4 |
| catalog probe (`initialize`; the reading passed validation) | 6 | 0 | 0 | 0 |
| list probe (`initialize` + `session/list`) | 6 | 0 | 0 | 0 |

Both mutations fail the check: with the base-URL override removed, the
positive control sees 0 model requests; with a catalog probe that sends
`session/new` and one prompt, the catalog probe's run has model requests and
requests outside the set. The test leaves Grok's memory workspace for its
scratch cwd in place (issue #650) and removes the cwd and its session
directory.
