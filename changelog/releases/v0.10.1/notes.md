This release makes Worktrunk tool results clearer for the model. It documents sequential calls, limits the worktree continuation hint to commands that change worktrees, and reports alias steps and exit codes on failure.

## 🐞 Bug fixes

### Clearer Worktrunk tool results

The `worktrunk` tool now tells the model that calls must be sequential, and its "still pending" error explains how to proceed. Read-only commands such as `config alias show` no longer tell the model to continue in the worktree after a switch, and failed aliases report their steps and exit code.

*By @mavam.*
