---
title: Complete Worktrunk command guidance
type: change
authors:
  - mavam
prs:
  - 12
created: 2026-08-24T12:25:16.370655Z
---

Pi agents now receive the generated Worktrunk command tree with its arguments, meaningful options, and canonical examples. The tool enumerates built-in commands, commands added by the installed Worktrunk version, and configured aliases separately from their remaining arguments, making calls such as worktree creation unambiguous:

```json
{"command":"switch","args":["--create","video-backgrounds"]}
```

Pi asks for confirmation before running hooks or administrative commands that change approvals, state, shell integration, or plugins.
