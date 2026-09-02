---
title: Run Worktrunk tools in print mode
type: bugfix
authors:
  - alexkarpandrus
created: 2026-09-01T20:25:07.484824Z
---

Model-triggered Worktrunk calls now execute before Pi’s non-interactive print and JSON sessions exit. This prevents queued `/wt` continuations from using a disposed extension context and makes commands such as `worktrunk list` return bounded output normally. Commands that move Pi sessions still require TUI or RPC mode, and Pi stops cleanly if a command removes its current worktree.
