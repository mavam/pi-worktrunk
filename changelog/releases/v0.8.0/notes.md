This release keeps Worktrunk session transitions compact and easy to scan while making the agent tool's command reference match the installed Worktrunk version automatically. Together, these improvements provide cleaner tool output and eliminate release coupling for new Worktrunk commands.

## 🔧 Changes

### Runtime Worktrunk command reference

The Worktrunk agent tool now generates its command reference from the installed `wt` binary at startup. Agents receive commands, options, and examples that match the Worktrunk version on your `PATH`, so new Worktrunk releases no longer require a matching pi-worktrunk release.

*By @mavam in #16.*

## 🐞 Bug fixes

### Compact tool displays after worktree moves

Worktrunk tool calls now retain a compact, single-line display when moving into a newly created or existing worktree. The destination session no longer falls back to a full-width tool panel containing raw JSON arguments or repeats temporary queued and movement notifications. Completed session transitions show the source and destination as emphasized branch names on one line.

*By @mavam.*
