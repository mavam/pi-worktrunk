---
title: Clearer Worktrunk tool results
type: bugfix
authors:
  - mavam
created: 2026-09-29T18:16:12.935491Z
---

The `worktrunk` tool now tells the model that calls must be sequential, and its "still pending" error explains how to proceed. Read-only commands such as `config alias show` no longer tell the model to continue in the worktree after a switch, and failed aliases report their steps and exit code.
