# AGENTS.md

The entry point for agents working in the kaoiro repository.

**Before starting work, read
[docs/specs/agent-operations.md](docs/specs/agent-operations.md).**
It is the source of truth for operating rules when multiple agents work
concurrently in the same work tree (both implementers and dispatchers),
regardless of engine.

Project structure, commands, and branch operation are in
[CLAUDE.md](CLAUDE.md). The filename comes from Claude Code, but the content
is engine-independent, so read the same file.

Before changing the runner startup path or the wrapper turn lifecycle,
check [docs/operations/high-risk-change-release.md](docs/operations/high-risk-change-release.md)
to determine whether the change is high risk.

Keep these six points in mind even before opening the source of truth.

1. If you find a discrepancy that changes the task's actual scope, send a
   query to the dispatch source **before implementation**, not together
   with the completion report.
2. Do not touch outside the assigned subdirectory. Report problems found
   there only.
3. Do not revert or stage another agent's uncommitted changes. Do not use
   `git add -A`; explicitly add only files you changed.
4. Do not amend a pushed commit. Always make corrections as new commits.
5. An inter-agent conversation ends only after both parties have sent
   `done=true`.
6. Write everything that remains in the repository in English: commit
   messages (subject: `type(scope): summary`), issue / PR titles, bodies,
   and comments, docs, and code comments. Conversations and inter-agent
   messages stay in the session language. See Language in CLAUDE.md for
   details.

For the rule requiring issue numbers in documents to link to their GitHub
issues, follow [Documentation writing rules](docs/contributing/documentation.md#writing-rules).
