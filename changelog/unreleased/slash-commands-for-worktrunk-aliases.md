---
title: Worktrunk alias subcommands in Pi
type: feature
authors:
  - mavam
prs:
  - 7
created: 2026-08-22T07:34:19.367321Z
---

Configured Worktrunk aliases now appear as subcommands of Pi's single `/worktree` command. For example, you can run a `wt land` alias directly from Pi:

```text
/worktree land
/worktree land 42
```

Arguments are forwarded to Worktrunk without shell expansion, and project aliases retain Worktrunk's approval checks.
