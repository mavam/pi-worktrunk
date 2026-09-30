---
title: Structured Worktrunk results for codemode
type: feature
authors:
  - mavam
created: 2026-09-30T07:21:51.225291Z
---

You can now use Worktrunk results directly in codemode scripts. Inspection commands return immediately with a status, exit code, bounded output, and parsed stdout JSON when available:

```js
const result = await tools.worktrunk({ command: "list", args: ["--format=json"] });
text(result.status === "completed" ? result.data : result.output);
```

Commands that need approvals or may change worktrees still run after the turn in TUI and RPC mode. They return `status: "queued"`, so end your script and wait for the continuation before doing dependent work. Pi blocks further tool calls during this handoff to prevent work in the old workspace. Command failures retain structured diagnostics, and overlapping Worktrunk calls are rejected before a second command starts.
