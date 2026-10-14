---
title: Terminal follows the active worktree
type: bugfix
authors:
  - mavam
prs:
  - 27
created: 2026-10-14T15:58:19.244653Z
---

After Pi moves the session to another worktree, it now reports the new directory to your terminal. Tabs and splits you open manually can then start in the active worktree instead of the one Pi was launched from, in terminals that use OSC 7 directory reports, such as Ghostty and WezTerm. When Pi exits, it reports the launch directory again.
