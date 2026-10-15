---
title: Release notes
description: One page per production release, listing what changed since the previous production release.
status: accepted
last_updated: 2026-10-15
---

# Release notes

Each page records one **production release**: the changes between the
previous production release and this one, the operator steps the upgrade
needs, and the issues found during or right after it.

A version tag is created on every develop landing (see
[Build identity and release tags](../operations/build-identity-and-release-tags.md)),
so most tags never reach production on their own. A release note covers the
whole range of tags that went to production together and is named after the
tag that was deployed: `docs/release/<tag>.md`.

Release notes are historical by nature. Like ADRs, they are exempt from the
rule that documentation describes only the current state: do not rewrite an
old note to match later behaviour, and link to the current contract instead.

## Writing a note

Whoever prepares a production release writes the note and lands it on
develop before or together with the release.

1. Collect the range with
   `git log --reverse --format='%h %s' <previous tag>..<new tag>` and the
   issues the commits reference.
2. Group user-visible changes by area and give each its issue number. Leave
   out test-only and plan-only commits unless they change how the project is
   operated.
3. List the operator steps the upgrade needs (configuration changes, new
   runner capabilities, the release class from
   [High-risk change release](../operations/high-risk-change-release.md)).
4. Add known issues as they are found after the release.
5. Add a line to the index below, newest first.

The repository is public. Do not write host names, deployment layout,
per-host results or other details of an operator's environment; keep
production run records outside the repository.

## Releases

| Release | Date | Previous | Highlights |
|---|---|---|---|
| [v2026.10.15.17](v2026.10.15.17.md) | 2026-10-15 | v2026.10.15.9 | HTTP/2 off pending a Bandit fix, display names and persona faces in the timeline, personas shirogane and moegi, `list_agents` names that follow renames |
| [v2026.10.15.9](v2026.10.15.9.md) | 2026-10-15 | v2026.10.15.4 | `KAOIRO_AGENT` marker for managed engines, Codex session reset without a dialog under autonomous approval, Antigravity startup and Grok weekly rate limits |
| [v2026.10.15.4](v2026.10.15.4.md) | 2026-10-15 | v2026.10.14.13 | Grok Build work units 3 and 4: cold resume, session discovery, history replay, launch catalog, live model and effort switching, context usage |
| [v2026.10.14.13](v2026.10.14.13.md) | 2026-10-14 | v2026.10.10.2 | Grok Build engine (work units 1 and 2), authenticated HTTP MCP for Grok, permission gate stop in the dashboard |
