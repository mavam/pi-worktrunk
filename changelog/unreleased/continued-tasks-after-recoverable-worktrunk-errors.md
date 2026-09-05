---
title: Continued tasks after recoverable Worktrunk errors
type: bugfix
prs:
  - 19
authors:
  - mavam
created: 2026-09-05T19:31:35.960573Z
---

Recoverable Worktrunk errors now return to the model so it can read the diagnostics, adapt its approach, and continue the task. Rejected directory directives and cancelled session switches no longer leave the turn paused when the original worktree is still usable.
