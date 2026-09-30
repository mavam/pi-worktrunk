This release shows a spinner above the editor while `/wt` commands run and while Pi moves your session, so slow aliases like `land` no longer leave the screen blank. The spinner steps aside for approval dialogs and worktree pickers.

## 🚀 Features

### Show progress for running /wt commands

The terminal UI now shows a spinner above the editor while a `/wt` command runs, for example `Running wt land`, and again while Pi moves the session to a new worktree. Previously, slow commands such as aliases or `wt list` in large repositories left the screen blank until the result card appeared. The spinner steps aside for approval dialogs and worktree pickers.

*By @mavam.*
