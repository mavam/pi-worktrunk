---
title: Agent-callable Worktrunk aliases
type: feature
authors:
  - mavam
prs:
  - 10
created: 2026-08-22T08:21:19.938104Z
---

The agent can now run configured Worktrunk aliases when you explicitly request a matching action. For example, if your configuration defines a `deploy` alias, you can ask:

```text
Deploy to staging.
```

The agent calls the `worktree_alias` tool with `deploy` and the user-supplied `staging` argument. Pi shows the exact command and pipeline for confirmation before running it, and Worktrunk continues to enforce project-command approvals.
