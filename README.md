# 🚦 pi-worktrunk

A [Pi](https://pi.dev) extension that brings Worktrunk status markers,
interactive commands, session continuation, and agent worktree tools under one
roof.

## 🚀 Installation

```sh
pi install npm:pi-worktrunk
```

## 📋 Requirements

- Install [`wt`](https://worktrunk.dev/) and make it available on your `PATH`.
- Run pi from a Git repository that Worktrunk can manage.

## ✨ What it does

- Adds tiny traffic lights to `wt list` so you can see whether pi is working or
  waiting for you
- Gives you a `/worktree` command for interactive worktree management
- Exposes configured Worktrunk aliases as `/worktree` subcommands
- Continues the current pi session in another worktree when you request it
- Gives the model the same Worktrunk-backed controls through one `worktree` tool
- Keeps Worktrunk as the source of truth, with no second layer of worktree magic

## 🚦 Status markers

The extension maps pi lifecycle events to Worktrunk branch markers:

- `session_start` sets `💬`.
- `agent_start` sets `🤖`.
- `agent_end` restores `💬`.
- `session_shutdown` clears the marker.

This adds the current pi state to `wt list`:

```text
wt list
+ feature-auth      ↑ 🤖              ↑1               ../repo.feature-auth
+ review-copy     ? ↑ 💬              ↑1               ../repo.review-copy
```

Marker updates fail quietly when `wt` is unavailable or the current directory is
not a Worktrunk-managed repository.

## 🧭 Interactive commands

Use `/worktree` to show the command reference.

| Command | Behavior |
| --- | --- |
| `/worktree list` | Select and inspect a worktree from `wt list --format=json`. |
| `/worktree create <branch>` | Create a branch and worktree with `wt switch --create --no-cd`. |
| `/worktree create <branch> --continue` | Create a worktree and continue the current pi session there. |
| `/worktree continue [target]` | Select or name a worktree in which to continue the current pi session. |
| `/worktree remove [target]` | Remove a selected or named worktree; Worktrunk deletes its branch when safe. |
| `/worktree status` | Show the current worktree and its local and remote state. |
| `/worktree cd [target]` | Show the path for a branch, path, directory name, or the current worktree. |
| `/worktree settings` | Show the active user and project configuration from `wt config show`. |

The command also supports `ls`, `rm`, and `config` as aliases for `list`,
`remove`, and `settings`.

### 🏷️ Worktrunk aliases

Configured Worktrunk aliases appear as `/worktree` subcommands. For example,
this Worktrunk alias:

```toml
[aliases]
land = "gh pr merge --squash {{ args }}"
```

becomes:

```text
/worktree land
/worktree land 42
```

The extension discovers the effective aliases for the current repository when
the session starts. It forwards quoted and escaped arguments directly to
Worktrunk without shell expansion, shows the command output in Pi, and preserves
Worktrunk's approval checks for project aliases.

An alias can remove the worktree in which Pi is running. If it does, use
`/worktree continue <target>` to continue the session in an existing worktree.

### 📍 Continue a session

Use `/worktree continue [target]` to continue the current session in an existing
worktree. Add `--continue` to `/worktree create <branch>` to create the worktree
and continue there in one operation.

Before switching, the extension shows the source and target directories and asks
for confirmation. It then creates a new pi session in the target worktree, links
it to the source session through Pi's parent-session metadata, and switches the
current pi process to the new session. The source session remains available.
Continuation also keeps Pi's active session storage policy, including a custom
shared session directory.

The copied history keeps its original text. A visible transition message tells
the model about the new working directory and warns that historical absolute
paths can still refer to the source worktree.

## 🧰 Agent tool

The extension registers one `worktree` tool with these actions:

| Action | Parameters | Behavior |
| --- | --- | --- |
| `list` | None | List Worktrunk JSON schema 2 entries. |
| `status` | None | Inspect the current worktree. |
| `create` | `branch` | Create a branch and worktree and return its path. |
| `remove` | `target` | Remove a safe, non-current worktree. |
| `path` | Optional `target` | Resolve a worktree path without changing directories. |
| `settings` | None | Inspect the active Worktrunk configuration. |

The model receives Worktrunk JSON schema 2, while Pi's TUI shows Worktrunk's
native text output. Tool output is limited to 2,000 lines or 50 KB. The
extension saves larger output to a temporary file and returns its path.

The agent tool can create and resolve worktrees, but it can't switch the active
pi session. Use `/worktree continue` for that user-confirmed transition.

## 🛡️ Safety

The extension delegates lifecycle decisions to Worktrunk:

- It refuses to remove the primary or current worktree.
- It doesn't pass `--force`, `--force-delete`, or `--yes`.
- Worktrunk rejects dirty worktrees and retains branches that aren't integrated
  unless you run an explicit Worktrunk command with the corresponding force
  option.
- Project hooks retain Worktrunk's approval gate. If a command reports that a
  hook needs approval, run `wt config approvals add` in a terminal, review the
  commands, and retry.
- Session continuation requires confirmation, preserves the source session, and
  doesn't rewrite historical messages.

## 🔗 Prior art

The session continuation flow was inspired by
[`pi-session-move`](https://github.com/ProbabilityEngineer/pi-session-move),
which demonstrated switching a live pi process into a session copy for another
working directory. This extension uses Pi's `SessionManager.forkFrom()` API for
a narrower Worktrunk-specific flow. It doesn't vendor `pi-session-move` or
rewrite session history.

## ⚙️ Configuration

Use Worktrunk's user and project configuration files:

- User configuration: `~/.config/worktrunk/config.toml`
- Project configuration: `.config/wt.toml`

Run `wt config create` or see the
[Worktrunk configuration reference](https://worktrunk.dev/config/).

## 📄 License

[MIT](LICENSE)
