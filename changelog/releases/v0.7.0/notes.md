Agents can now run Worktrunk commands without redundant Pi confirmations while Worktrunk retains its own safeguards. Print and JSON sessions execute commands before exiting and handle worktree removal safely.

## 🔧 Changes

### Unattended agent commands

Agent-triggered Worktrunk commands now run without an extra Pi confirmation, including configured aliases such as `wt land`.

Worktrunk still applies its own project-command approvals and safety checks.

*By @mavam.*

## 🐞 Bug fixes

### Run Worktrunk tools in print mode

Model-triggered Worktrunk calls now execute before Pi’s non-interactive print and JSON sessions exit. This prevents queued `/wt` continuations from using a disposed extension context and makes commands such as `worktrunk list` return bounded output normally. Commands that move Pi sessions still require TUI or RPC mode, and Pi stops cleanly if a command removes its current worktree.

*By @alexkarpandrus.*
