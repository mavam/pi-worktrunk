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

In the terminal UI, a spinner above the editor shows that a slash command is
running, for example `Running wt land`, and a second one appears while Pi moves
the session. Completed slash commands appear as Worktrunk cards with the
same header and success/error styling as model-invoked tools. Their output stays
in the transcript, including after a worktree move, without triggering a model
response.

Two bare commands open compact Pi interfaces:

- `/wt list` opens the worktree inspector.
- `/wt switch` opens the worktree picker and moves to the selected worktree.

Pi follows Worktrunk's directory-change directive, using the same protocol as
Worktrunk's shell integration. This includes requests from configured aliases
and foreground hooks. For example, when `/wt remove` removes your feature worktree
and requests the main worktree, Pi continues there without waiting for background
cleanup. Existing destination subdirectories are preserved.

Pi follows a valid directive even if a later hook fails, and reports the failure
in the destination session. Without a directive, Pi stays put as long as its
working directory remains usable. Each invocation uses a private temporary
reply file, which is deleted afterward.

If the working directory has been removed, Pi recovers to a surviving worktree
in the same repository, preferring the main worktree. This also works when
another process deletes the worktree: the next `/wt` command or `worktrunk` tool
call recovers the session instead of trying to launch Worktrunk there. Pi must
have recorded the repository and its worktrees before removal.

Recovery creates a linked session labeled **Session recovered**. A command
requested after the directory became unusable is **not run**; review it in the
new worktree before retrying. If a command removed the directory itself, Pi
preserves its result and doesn't replay it.

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

### ✅ Project-command approvals

Worktrunk asks once before it runs a repository's hooks or aliases, and asks
again whenever they change. When a command needs this approval, Pi shows every
unapproved project command in a confirmation dialog. Approving saves exactly
those commands, as `wt config approvals add` would, and retries the command
once. Aliases ask before they run, because a retry could repeat steps that
already ran. Declining leaves the approvals unchanged and reports the failure.

Without an interactive UI, such as in print or JSON mode, the command fails and
lists the commands to approve in a terminal with `wt config approvals add`. The
model cannot pass `-y`/`--yes` to skip approval.

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

### 🧑‍💻 Codemode

You can call `tools.worktrunk()` from codemode while keeping the tool available
for direct calls. Inspection commands such as `list`, `config show`, `hook show`,
and `step diff` return immediately, so you can inspect their results and chain
another call:

```js
const result = await tools.worktrunk({ command: "list", args: ["--format=json"] });
if (result.status !== "completed") throw new Error(result.output);
text(result.data ?? result.output);
```

Results include `status`, `args`, `cwd`, `output`, and `truncated`. Executed
commands also include `code`. When stdout is a JSON object or array within the
output limit, it is available as `data`; otherwise use `output`. Command
failures return `status: "failed"` with diagnostics. Invalid arguments, blocked
calls, and overlapping calls still throw.

In TUI or RPC mode, mutations, hooks, aliases, and commands not recognized as
inspection commands return `status: "queued"`. They haven't run yet: Pi runs
them after the turn ends, handles approvals and session movement, then returns
the result in a continuation. End your script immediately after queuing one:

```js
return await tools.worktrunk({ command: "switch", args: ["--create", "fix/parser"] });
```

Don't run Worktrunk calls in parallel. While a command is queued, Pi blocks
further tool calls for the rest of the turn to prevent work in the old
workspace. In print or JSON mode, commands execute immediately;
`status: "stopped"` means you must restart Pi in the reported directory rather
than continue the script.

## 🧰 Requirements

- Use Pi 0.99.1 or later. Earlier versions are not supported.
- Install current [`wt`](https://worktrunk.dev/) with the
  `WORKTRUNK_DIRECTIVE_CD_FILE` protocol and make it available on your `PATH`.
- Use TUI or RPC mode for session movement. In print or JSON mode, a directory
  request stops continuation and reports where to restart Pi.
- Run Pi from a Git repository that Worktrunk can manage.

## 🛡️ Safety

- Pi validates that a requested directory belongs to the original repository.
- Recovery only uses previously recorded worktrees whose repository identity
  still matches. If none survive, or the session cannot move, Pi reports where
  to restart or asks you to choose a surviving worktree.
- Rejected directives and cancelled session moves never trigger a fallback move.
- Worktrunk retains control of hooks, project-command approvals, dirty-worktree
  checks, force flags, branch deletion, and command errors.
- Session movement preserves the source session.

## 📄 License

[MIT](LICENSE)
