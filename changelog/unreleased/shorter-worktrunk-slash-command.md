---
title: Shorter Worktrunk slash command
type: breaking
authors:
  - mavam
prs:
  - 8
created: 2026-08-22T08:12:09.785993Z
---

The interactive slash command is now `/wt`, replacing `/worktree`.

Before:

```text
/worktree status
```

After:

```text
/wt status
```

Update saved prompts and workflows that invoke the old command. The `worktree` agent tool keeps its existing name.
