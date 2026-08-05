---
title: Continue pi sessions in Worktrunk worktrees
type: feature
authors:
  - mavam
  - codex
prs:
  - 3
created: 2026-08-05T07:12:22Z
---

Use `/worktree continue [target]` to continue the current pi session in an
existing Worktrunk worktree. You can also create a worktree and continue there
in one operation:

```sh
/worktree create feature/auth --continue
```

The extension asks for confirmation, creates a linked session copy in the
target worktree, and switches the current pi process to it. It preserves the
source session and records a visible working-directory transition without
rewriting historical messages.
