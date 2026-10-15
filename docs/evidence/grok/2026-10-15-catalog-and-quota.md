---
title: Grok launch catalog and its quota measurement
date: 2026-10-15
---

# Grok launch catalog and its quota measurement

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

## Recorder runs on 2026-10-15

These runs are the acceptance measurement of work unit 3c. They are not a
committed test: the native verifier that ran them was removed after review
(issue #646), and only what the probes send is pinned by
`runner/test/grok-catalog.test.ts`.

The method was the same in both runs. The production `probeGrokCatalog` and
`listGrokSessions` ran with only their executable replaced. The replacement
was a launcher that entered a new user and network namespace, brought
loopback up, started a recorder there and then became Grok, so the probe's
process group held both. Grok's two base URLs and all six proxy variables
pointed at the recorder, with `NO_PROXY` empty. The recorder logged the
method and the normalized pathname of each request (the query dropped, an
absolute-form target reduced to its path), and only the fact of a `CONNECT`.
It answered 503 with no body and refused `CONNECT`.

First a positive control ran: `session/new` and one prompt, watched until the
first model request or 45 s. A run counted only if it saw at least one model
request (`POST /v1/responses`). Then the catalog and list probes ran, each
with its own recorder.

| Run | Requests | Model requests | `CONNECT` | Outside the GET set |
|---|---:|---:|---:|---:|
| run 1, positive control | 12 | 2 | 2 | 4 |
| run 1, catalog probe (the reading passed validation) | 6 | 0 | 0 | 0 |
| run 1, list probe | 6 | 0 | 0 | 0 |
| run 2, positive control | 14 | 2 | 2 | 4 |
| run 2, catalog probe (the reading passed validation) | 7 | 0 | 0 | 0 |
| run 2, list probe | 8 | 0 | 0 | 0 |

"Outside the GET set" includes the `CONNECT`s, as in the design r3 table.

Two mutations each failed the measurement, in both runs:

- with the base-URL overrides removed, the positive control saw 0 model
  requests;
- with a catalog probe that also sent `session/new` and a prompt, the catalog
  probe's run showed model requests and requests outside the set.

The recorder could not see some request attempts:

- a second request pipelined on one connection, since it logged only the
  first request of a connection;
- bytes still in a socket's receive queue when the probe's teardown ended
  the recorder;
- a connection completed after the recorder stopped accepting.

Real Grok was not observed doing any of these, but the runs cannot exclude
them. Run 2's recorder logged every method and malformed requests;
run 1's logged only common methods.

Grok's memory workspace for the scratch cwd of each positive control was left
in place (issue #650); the cwd and its session directory were removed.

The measurement holds for Grok 1.0.52 only. Measure it again when Grok is
upgraded ([issue #655](https://github.com/sakuraiyuta/kaoiro/issues/655)).
What the probes send is pinned separately by `runner/test/grok-catalog.test.ts`;
a probe that also sends a prompt, at any point of its operation, fails it.
