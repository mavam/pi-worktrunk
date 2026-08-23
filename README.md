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
/wt land
/wt config show
```

Pi passes arguments directly to Worktrunk. Worktrunk flags and configured aliases
work without extension-specific syntax.

Two bare commands open compact Pi interfaces:

- `/wt list` opens the worktree inspector.
- `/wt switch` opens the worktree picker and moves to the selected worktree.

After other successful commands, Pi moves when Worktrunk reports a destination
or creates exactly one worktree. If the command removes the current worktree,
Pi recovers in a surviving worktree. Pi stays put when no unique destination can
be identified or when a command fails without removing the current worktree.

Each move creates a linked Pi session in the destination. The source session
remains available through `/resume`.

### 🏷️ Worktrunk aliases

Configured aliases pass directly through `/wt`:

```text
/wt land
/wt deploy staging
```

Worktrunk continues to enforce project-command approvals. Model calls that run
aliases, unknown commands, configuration overrides, another working directory,
or approval-bypass options require Pi confirmation first.

## 🚦 Status markers

The extension maps Pi lifecycle events to Worktrunk branch markers:

- `session_start` sets `💬`.
- `agent_start` sets `🤖`.
- `agent_end` restores `💬`.
- `session_shutdown` clears the marker.

## 🧰 Agent tool

The extension registers one `worktrunk` tool. It accepts a non-empty argument
array and passes every item directly to `wt` without shell expansion:

```json
{ "args": ["switch", "--create", "fix/parser"] }
```

The tool description lists repository aliases and their pipeline labels when
Worktrunk provides that metadata. Alias calls and sensitive global options
require confirmation. Commands that move to another worktree stop the old model
turn, switch to a linked session, report Worktrunk's result, and resume the task
there.

## 🧰 Requirements

- Install [`wt`](https://worktrunk.dev/) and make it available on your `PATH`.
- Run Pi from a Git repository that Worktrunk can manage.

## 🛡️ Safety

- Pi stays put rather than choosing between several destinations.
- Recovery takes precedence when a command removes the current worktree.
- Worktrunk retains control of hooks, dirty-worktree checks, force flags, branch
  deletion, and command errors. Pi confirms model calls that could alter or
  bypass Worktrunk approval settings.
- Session movement preserves the source session.

## 🧹 Uninstall

```sh
pi remove npm:pi-worktrunk
```

## 📄 License

[MIT](LICENSE)
