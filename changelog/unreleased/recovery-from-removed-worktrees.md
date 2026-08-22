---
title: Recovery from removed worktrees
type: bugfix
authors:
  - mavam
prs:
  - 5
created: 2026-08-22T05:54:52.868505Z
---

The `/worktree continue` command now recovers when another process removes Pi's current worktree. You can continue the session in an existing worktree instead of seeing a misleading message that Worktrunk is missing. If no worktree remains available, the error now identifies the removed working directory.
