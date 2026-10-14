---
title: Grok Build as a resident ACP engine
status: accepted
date: 2026-10-14
related: [issue-589, issue-590]
---

# ADR-0067 — Grok Build as a resident ACP engine

## Decision

Add engine grok and package @kaoiro/grok. Keep one resident grok agent stdio
child and one ACP session per wrapper. Use SDK 1.8.0 through separable ACP
modules, native _meta.rules for persona/footer, and a stdio MCP bridge to
common tool handlers. Existing engines retain their hosts.

Declare unsupported operations explicitly. Normal peer delivery includes
confirmation; early/yield are none and reply-basis v1 is not negotiated.
Use the existing approval projection, with spawn-only, display-only permission
source metadata. Compatibility settings remain owned by the user settings.
OS sandbox pairs are Linux-only until other platforms are measured; off with
network on remains portable. Shutdown is bounded below the runner reset grace.

## Rationale

ACP provides resident conversation, cancellation and permission requests.
A new process per prompt loses those properties. One engine does not justify
a generic ACP framework; extract common ACP code when another engine uses it.
Metadata-only diagnostics prevent unknown SDK variants from leaking content.

## Consequences

Cold resume, history, catalog probing, context usage and live model/effort
switching belong to later work units. Individual Claude hooks and upstream
reports are outside this work. Production enabling requires operator approval.
