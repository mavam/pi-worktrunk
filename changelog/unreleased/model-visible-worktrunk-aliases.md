---
title: Agent-callable Worktrunk aliases
type: feature
authors:
  - mavam
prs:
  - 10
created: 2026-08-22T08:21:19.938104Z
---

The agent can now run configured Worktrunk aliases when you explicitly request a matching action. For example, if your configuration defines a `land` alias, you can ask:

```text
Land this PR.
```

The agent calls the `worktree_alias` tool with `land`. Pi shows the exact command and pipeline for confirmation before running it, and Worktrunk continues to enforce project-command approvals.
