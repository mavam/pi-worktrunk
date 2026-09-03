---
title: Compact tool displays after worktree moves
type: bugfix
authors:
  - mavam
created: 2026-09-03T18:52:46.980007Z
---

Worktrunk tool calls now retain a compact, single-line display when moving into a newly created or existing worktree. The destination session no longer falls back to a full-width tool panel containing raw JSON arguments or repeats temporary queued and movement notifications. Completed session transitions show the source and destination as emphasized branch names on one line.
