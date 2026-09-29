Pi now asks you to approve a repository's Worktrunk hooks in a dialog when a command needs them, then retries the command. Without an interactive UI, the error lists the commands to approve in a terminal.

## 🚀 Features

### Approve Worktrunk project hooks from pi

When a Worktrunk command needs approval for project hooks, such as `wt switch --create`, `wt remove`, `wt merge`, or an alias like `wt land`, pi now shows the unapproved commands in a confirmation dialog instead of failing with `Cannot prompt for approval in non-interactive environment`. If you approve, pi saves exactly the commands you reviewed to Worktrunk's approvals and retries the command once. Aliases ask before they run, because a retry could repeat steps that already ran.

Without an interactive UI, the error now includes the hint and the list of unapproved commands, including for commands the model runs. The model can no longer pass `-y`/`--yes` to skip the approval.

*By @mavam in #21.*
