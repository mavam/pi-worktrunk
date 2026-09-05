Worktrunk now renders completed slash commands as persistent, tool-style cards in the terminal transcript, making command output easier to scan and revisit. Pi also follows Worktrunk’s directory decisions reliably across aliases, hooks, and worktree removal.

## 🔧 Changes

### Tool-style slash command output

Completed `/wt` commands now appear in the terminal transcript with the same Worktrunk header and success/error styling as model-invoked tools, rather than as plain notifications. For example, `/wt land` shows a labeled card containing its output, and the card remains visible after a worktree move or session reload. Slash commands still run without triggering a model response.

*By @mavam in #18.*

## 🐞 Bug fixes

### Worktrunk-directed session movement

Pi now follows Worktrunk's selected directory, including requests from aliases and foreground hooks. When `/wt remove` removes the active worktree, the conversation continues in the selected surviving worktree without waiting for background cleanup. Existing destination subdirectories are preserved, and a later hook failure is reported from the destination session.

Pi no longer guesses destinations from newly created worktrees or session history. If Worktrunk requests no directory change, Pi stays put; if its directory becomes unusable, continuation stops instead of choosing a recovery destination. This requires current Worktrunk's directory-change protocol.

*By @mavam.*
