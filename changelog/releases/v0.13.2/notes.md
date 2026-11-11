Pi starts faster in large repositories, and Worktrunk tools no longer wait for status when they only need worktree locations. `/wt list` and the `/wt switch` picker continue to show full status.

## 🐞 Bug fixes

### Faster startup and tool calls in large repositories

Pi now starts quickly in large repositories, and Worktrunk tool calls no longer wait for a full `wt list` first. The `/wt list` and `/wt switch` pickers still show full status.

*By @mavam.*
