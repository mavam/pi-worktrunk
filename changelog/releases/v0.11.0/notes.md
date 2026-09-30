This release lets codemode scripts consume Worktrunk results directly, with structured output for inspection commands and explicit handoffs for commands that move sessions. It also raises the minimum supported Pi version to 0.99.1.

## 💥 Breaking changes

### Require Pi 0.99.1 or later

`pi-worktrunk` now requires Pi 0.99.1 or later and no longer carries compatibility code for earlier versions. It also stops rendering session-transition messages written by very old releases and no longer accepts the obsolete tool-call format that put the Worktrunk command inside `args`.

*By @mavam in #23.*

## 🚀 Features

### Structured Worktrunk results for codemode

You can now use Worktrunk results directly in codemode scripts. Inspection commands return immediately with a status, exit code, bounded output, and parsed stdout JSON when available:

```js
const result = await tools.worktrunk({ command: "list", args: ["--format=json"] });
if (result.status !== "completed") throw new Error(result.output);
text(result.data ?? result.output);
```

Commands that need approvals or may change worktrees still run after the turn in TUI and RPC mode. They return `status: "queued"`, so end your script and wait for the continuation before doing dependent work. Pi blocks further tool calls for the rest of the turn to prevent work in the old workspace. Command failures retain structured diagnostics, and overlapping Worktrunk calls are rejected before a second command starts.

*By @mavam in #23.*
