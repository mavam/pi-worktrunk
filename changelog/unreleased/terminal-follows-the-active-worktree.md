---
title: Terminal follows the active worktree
type: bugfix
authors:
  - mavam
created: 2026-10-14T15:57:42.182661Z
---

After Pi moves the session to another worktree, it now reports the new directory to your terminal. Tabs and splits you open manually can then start in the active worktree instead of the one Pi was launched from, in terminals that use OSC 7 directory reports, such as Ghostty and WezTerm. When Pi exits, it reports the launch directory again.
