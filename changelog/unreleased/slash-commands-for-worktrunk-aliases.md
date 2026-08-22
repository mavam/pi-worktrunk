---
title: Slash commands for Worktrunk aliases
type: feature
authors:
  - mavam
created: 2026-08-22T07:34:19.367321Z
---

Configured Worktrunk aliases now appear in Pi as same-named slash commands. For example, you can run a `wt land` alias directly from Pi:

```text
/land
/land 42
```

Arguments are forwarded to Worktrunk without shell expansion, and project aliases retain Worktrunk's approval checks.
