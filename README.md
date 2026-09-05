# 🚦 pi-worktrunk

A [Pi](https://pi.dev) extension that runs Worktrunk commands, follows worktree
changes with linked sessions, and reports Pi status in `wt list`.

## 🚀 Installation

```sh
pi install npm:pi-worktrunk
```

## ✨ Usage

`/wt` accepts the same arguments as the `wt` CLI:

```text
/wt list
/wt switch main
/wt switch --create fix/parser
/wt remove
/wt config show
```

Pi passes arguments directly to Worktrunk. Worktrunk flags and configured aliases
work without extension-specific syntax.

Two bare commands open compact Pi interfaces:

- `/wt list` opens the worktree inspector.
- `/wt switch` opens the worktree picker and moves to the selected worktree.

Pi follows Worktrunk's directory-change directive, using the same protocol as
Worktrunk's shell integration. This includes requests from configured aliases
and foreground hooks. For example, when `/wt remove` removes your feature worktree
and requests the main worktree, Pi continues there without waiting for background
cleanup. Existing destination subdirectories are preserved.

Pi follows a valid directive even if a later hook fails, and reports the failure
in the destination session. Without a directive, Pi stays put: it doesn't infer
a destination from newly created worktrees or session history. Each invocation
uses a private temporary reply file, which is deleted afterward.

Each move creates a linked Pi session in the destination. The source session
remains available through `/resume`.

### 🏷️ Worktrunk aliases

Your configured aliases pass directly through `/wt`. For example, if you define
aliases named `land` and `deploy`, you can run:

```text
/wt land
/wt deploy staging
```

Model calls run configured aliases and other Worktrunk commands without an
additional Pi confirmation. Worktrunk continues to enforce its own safety checks
and project-command approvals.

## 🚦 Status markers

The extension maps Pi lifecycle events to Worktrunk branch markers:

- `session_start` sets `💬`.
- `agent_start` sets `🤖`.
- `agent_end` restores `💬`.
- `session_shutdown` clears the marker.

## 🧰 Agent tool

The extension registers one `worktrunk` tool. Its `command` field enumerates the
built-in commands and configured aliases. Its optional `args` array passes the
remaining arguments directly to `wt` without shell expansion:

```json
{ "command": "switch", "args": ["--create", "fix/parser"] }
```

At startup, the extension generates the tool reference from the installed
Worktrunk binary. The description therefore matches its command tree, options,
arguments, and examples without requiring a matching pi-worktrunk release.
Repository aliases are discovered at the same time. Agent calls run without an
additional Pi confirmation. Commands that move to another worktree stop the old
model turn, switch to a linked session, report Worktrunk's result, and resume the
task there.

## 🧰 Requirements

- Install current [`wt`](https://worktrunk.dev/) with the
  `WORKTRUNK_DIRECTIVE_CD_FILE` protocol and make it available on your `PATH`.
- Use TUI or RPC mode for session movement. In print or JSON mode, a directory
  request stops continuation and reports where to restart Pi.
- Run Pi from a Git repository that Worktrunk can manage.

## 🛡️ Safety

- Pi validates that a requested directory belongs to the original repository.
- If the current directory becomes unusable without a valid directive, Pi stops
  continuation rather than choosing a recovery destination.
- Worktrunk retains control of hooks, project-command approvals, dirty-worktree
  checks, force flags, branch deletion, and command errors.
- Session movement preserves the source session.

## 📄 License

[MIT](LICENSE)
