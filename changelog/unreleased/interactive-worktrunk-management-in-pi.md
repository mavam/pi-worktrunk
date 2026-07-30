---
title: Interactive Worktrunk management in pi
type: feature
authors:
  - mavam
  - codex
prs:
  - 2
created: 2026-07-30T06:25:28.286095Z
---

Pi now provides a `/worktree` command and a `worktree` agent tool for listing,
inspecting, creating, resolving, and safely removing Worktrunk worktrees:

```sh
/worktree create feature/auth
/worktree list
```

Both interfaces keep Worktrunk as the source of truth and preserve its hook
approval and removal safeguards. This integration requires Worktrunk 0.70 or
later.
