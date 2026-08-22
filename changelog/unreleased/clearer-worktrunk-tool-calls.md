---
title: Clearer Worktrunk tool calls
type: change
authors:
  - mavam
created: 2026-08-22T07:20:16.465546Z
---

Worktrunk tool calls now separate the tool name from the action and emphasize the target branch or path:

```text
Worktrunk › create remove-github
```

This makes tool calls easier to scan while keeping them visually distinct from shell commands.
