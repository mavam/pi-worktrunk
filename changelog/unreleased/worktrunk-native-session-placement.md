---
title: Worktrunk-native session placement
type: breaking
authors:
  - mavam
prs:
  - 11
created: 2026-08-22T10:01:09.482363Z
---

The `/wt` command now accepts the full Worktrunk CLI and can place the active Pi session after any command:

```text
/wt switch --create fix-parser
/wt switch fix-parser --go
/wt land
```

Use `--go` to follow a command's target, `--stay` to remain in the current worktree, or `--fork` to create a second resumable session. Pi tracks previous worktrees for `/wt switch -` and recovers automatically when a merge, removal, hook, or alias deletes the current worktree.
