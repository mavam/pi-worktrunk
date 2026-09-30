---
title: Show progress for running /wt commands
type: feature
authors:
  - mavam
created: 2026-09-30T15:29:22.506266Z
---

The terminal UI now shows a spinner above the editor while a `/wt` command runs, for example `Running wt land`, and again while Pi moves the session to a new worktree. Previously, slow commands such as aliases or `wt list` in large repositories left the screen blank until the result card appeared. The spinner steps aside for approval dialogs and worktree pickers.
