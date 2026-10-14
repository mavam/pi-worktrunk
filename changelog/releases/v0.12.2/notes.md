Pi now reports the active worktree directory to your terminal, so new tabs and splits can open in the right worktree. When Pi exits, it restores the launch directory report.

## 🐞 Bug fixes

### Terminal follows the active worktree

After Pi moves the session to another worktree, it now reports the new directory to your terminal. Tabs and splits you open manually can then start in the active worktree instead of the one Pi was launched from, in terminals that use OSC 7 directory reports, such as Ghostty and WezTerm. When Pi exits, it reports the launch directory again.

*By @mavam in #27.*
