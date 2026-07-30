# 🚦 pi-worktrunk

A [pi](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent)
extension that brings Worktrunk status markers, interactive commands, and agent
worktree tools under one roof.

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
| `/worktree remove [target]` | Remove a selected or named worktree; Worktrunk deletes its branch when safe. |
| `/worktree status` | Show the current worktree and its local and remote state. |
| `/worktree cd [target]` | Show the path for a branch, path, directory name, or the current worktree. |
| `/worktree settings` | Show the active user and project configuration from `wt config show`. |

The command also supports `ls`, `rm`, and `config` as aliases for `list`,
`remove`, and `settings`.

### 📍 Working-directory behavior

Pi doesn't expose an extension API for changing the active session's working
directory. `/worktree create`, `/worktree list`, and `/worktree cd` therefore
return the target path without changing the current pi session. Start another pi
session in that path when you want to work there.

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

The extension requests Worktrunk's JSON schema 2 explicitly. Tool output is
limited to 2,000 lines or 50 KB. The extension saves larger output to a
temporary file and returns its path.

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

## ⚙️ Configuration

Use Worktrunk's user and project configuration files:

- User configuration: `~/.config/worktrunk/config.toml`
- Project configuration: `.config/wt.toml`

Run `wt config create` or see the
[Worktrunk configuration reference](https://worktrunk.dev/config/).

## 📄 License

[MIT](LICENSE)
