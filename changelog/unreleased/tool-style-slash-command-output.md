---
title: Tool-style slash command output
type: change
authors:
  - mavam
created: 2026-09-05T16:08:37.915879Z
---

Completed `/wt` commands now appear in the terminal transcript with the same Worktrunk header and success/error styling as model-invoked tools, rather than as plain notifications. For example, `/wt land` shows a labeled card containing its output, and the card remains visible after a worktree move or session reload. Slash commands still run without triggering a model response.
