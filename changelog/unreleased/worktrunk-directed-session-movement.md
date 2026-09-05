---
title: Worktrunk-directed session movement
type: bugfix
authors:
  - mavam
created: 2026-09-05T15:34:54.474627Z
---

Pi now follows Worktrunk's selected directory, including requests from aliases and foreground hooks. When `/wt land` removes the active worktree, the conversation continues in the selected surviving worktree without waiting for background cleanup. Existing destination subdirectories are preserved, and a later hook failure is reported from the destination session.

Pi no longer guesses destinations from newly created worktrees or session history. If Worktrunk requests no directory change, Pi stays put; if its directory becomes unusable, continuation stops instead of choosing a recovery destination. This requires current Worktrunk's directory-change protocol.
