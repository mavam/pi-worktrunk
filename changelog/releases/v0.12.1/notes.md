Pi now recovers your session to a surviving worktree when its working directory disappears. Recovery preserves your conversation without replaying commands against the wrong branch.

## 🐞 Bug fixes

### Session recovery after worktree removal

Pi now recovers to a surviving worktree in the same repository when its current working directory disappears, preferring the main worktree. This handles both removal during a Worktrunk command and deletion by another process before the next `/wt` command or `worktrunk` tool call.

Recovery preserves the conversation and reports the new location. Commands requested after the directory disappeared are not run automatically in the recovery worktree, preventing a merge or removal from affecting the wrong branch. If no verified worktree survives or the session cannot move, Pi stops and asks you to restart in a surviving worktree.

*By @mavam in #25.*
