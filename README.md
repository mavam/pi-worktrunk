# 🚦 pi-worktrunk

A [Pi](https://pi.dev) extension that connects Worktrunk commands, session
placement, status markers, and agent tools.

## 🚀 Installation

```sh
pi install npm:pi-worktrunk
```

## 🧰 Requirements

- Install [`wt`](https://worktrunk.dev/) and make it available on your `PATH`.
- Run Pi from a Git repository that Worktrunk can manage.

## ✨ Usage

`/wt` accepts the same commands and arguments as the `wt` CLI:

```text
/wt list --full
/wt switch feature-auth
/wt switch --create fix-parser
/wt merge
/wt config show
/wt land
```

Pi passes unknown commands to Worktrunk instead of maintaining a separate
subcommand list. Configured Worktrunk aliases therefore work under `/wt` without
extra setup.

Two bare commands use Pi's interface:

- `/wt list` opens a worktree inspector.
- `/wt switch` opens a worktree picker.

Other forms preserve their Worktrunk arguments and output.

### 🧭 Place the session

Pi adds three modifiers that control where the conversation continues after the
Worktrunk command finishes:

| Modifier | Behavior |
| --- | --- |
| `--go` | Continue in a linked session copy in the command's target worktree. |
| `--stay` | Run the command without moving the active session. |
| `--fork` | Create a linked session copy in the target worktree while keeping the active session in place. |

Use only one placement modifier per command. Pi consumes modifiers before the
first literal `--`. Arguments after `--` pass to Worktrunk unchanged:

```text
/wt deploy --go
/wt deploy -- --go
```

The second command passes `--go` to the `deploy` alias.

Without a modifier, Pi uses these defaults:

- `/wt switch --create <branch>` creates the worktree and keeps the session in
  place.
- `/wt switch <target>` follows the target.
- Commands that remove the current worktree recover the session in a surviving
  worktree.
- Other commands keep the session in place.

Pi only moves when Worktrunk returns a target or the worktree changes identify
one target. It stays rather than guessing when an alias creates several
worktrees or produces no destination.

### ↩️ Return to an earlier worktree

Pi stores the worktrees through which the conversation has moved:

```text
/wt switch -
```

This toggles to the previous surviving worktree. If a merge, removal, hook, or
alias deletes the current worktree, Pi walks backward through the same trail.
It falls back to the primary worktree when the trail has no surviving entry.

Each move creates a linked Pi session copy for the destination. The source
session remains available through `/resume`.

### 🌱 Work in parallel

`--fork` creates another resumable Pi session without moving the current one:

```text
/wt switch --create fix-parser --fork
```

Without a launcher, Pi prints the new session path and the corresponding
`pi --session` command.

Set `PI_WORKTRUNK_FORK_COMMAND` to launch the session automatically. Pi runs the
command from the target worktree and provides these environment variables:

- `PI_WORKTRUNK_TARGET_CWD`
- `PI_WORKTRUNK_TARGET_SESSION`

For example, point the variable at a script that opens a tmux window, a Zellij
pane, or another terminal with:

```sh
pi --session "$PI_WORKTRUNK_TARGET_SESSION"
```

### 🏷️ Worktrunk aliases

Configured aliases pass directly through `/wt`:

```toml
[aliases]
deploy = "make deploy {{ args }}"
```

```text
/wt deploy staging
/wt deploy staging --stay
```

Worktrunk continues to enforce project-command approvals.

The extension also registers a `worktree_alias` agent tool when aliases exist.
The tool shows the exact invocation and pipeline step labels for confirmation
before it runs. It passes arguments directly to Worktrunk without shell
expansion.

## ⚙️ Configuration

Set `PI_WORKTRUNK_POSTURE` to choose the default session-placement policy:

| Value | Behavior |
| --- | --- |
| `infer` | Create stays, switch follows, removal recovers. This is the default. |
| `follow` | Follow a unique target produced by any successful command. |
| `stay` | Stay unless the current worktree is removed. |
| `ask` | Confirm each optional move. |

Explicit `--go`, `--stay`, and `--fork` modifiers override the posture. Recovery
from a removed working directory always takes precedence.

Print and JSON modes never replace the active session. `--go` reports the
resolved destination, while `--fork` creates a resumable session without
launching another interactive process. Ephemeral Pi sessions cannot move or
fork because they have no session file to copy.

## 🚦 Status markers

The extension maps Pi lifecycle events to Worktrunk branch markers:

- `session_start` sets `💬`.
- `agent_start` sets `🤖`.
- `agent_end` restores `💬`.
- `session_shutdown` clears the marker.

This adds the current Pi state to `wt list`:

```text
wt list
+ feature-auth      ↑ 🤖              ↑1               ../repo.feature-auth
+ review-copy     ? ↑ 💬              ↑1               ../repo.review-copy
```

Marker updates fail quietly when `wt` is unavailable or the current directory
no longer exists.

## 🧰 Agent tools

The extension registers a `worktree` tool with these actions:

| Action | Parameters | Behavior |
| --- | --- | --- |
| `list` | None | List Worktrunk JSON schema 2 entries. |
| `status` | None | Inspect the current worktree. |
| `create` | `branch` | Create a branch and worktree and return its path. |
| `remove` | `target` | Remove a safe, non-current worktree. |
| `path` | Optional `target` | Resolve a worktree path without changing sessions. |
| `settings` | None | Inspect the active Worktrunk configuration. |

The model receives structured output, while Pi's TUI shows Worktrunk's native
text. Tool output is limited to 2,000 lines or 50 KB. The extension saves larger
output to a temporary file and returns its path.

The agent tool does not move the active Pi session. Use `/wt switch` for an
interactive transition.

## 🛡️ Safety

- Pi never guesses between several possible session targets.
- `--stay` cannot leave a session attached to a deleted worktree.
- Worktrunk retains control of hooks, approvals, dirty-worktree checks, force
  flags, branch deletion, and command errors.
- The agent tool never passes `--force`, `--force-delete`, or `--yes` on its own.
- Session movement preserves the source session and records the destination in
  the linked copy.

## 📄 License

[MIT](LICENSE)
