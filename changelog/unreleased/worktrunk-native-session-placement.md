---
title: Automatic Worktrunk session placement
type: breaking
authors:
  - mavam
prs:
  - 11
created: 2026-08-22T10:01:09.482363Z
---

The `/wt` command now accepts Worktrunk's CLI unchanged and moves the Pi session automatically when a command identifies one destination:

```text
/wt switch main
/wt switch --create fix/parser
/wt land
```

The model uses the same interface through `{"args":["switch","--create","fix/parser"]}`. After a move, it reports Worktrunk's result and resumes the original task in the linked destination session. Configured aliases appear in the tool description. Aliases and options that can change or bypass Worktrunk approval settings require confirmation.

This replaces the `--go`, `--stay`, and `--fork` placement flags, placement environment variables, fork launchers, and the previous structured model tools. Commands with no unique destination stay in the current session. If a command removes the current worktree, Pi recovers in a surviving worktree.
