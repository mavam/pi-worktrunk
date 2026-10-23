The worktrunk tool description is now about 90% smaller, listing only commands, options, and aliases. Agents look up any command's full reference on demand by adding --help to its arguments.

## 🔧 Changes

### Smaller worktrunk tool description with on-demand help

The `worktrunk` tool description is now about 90% smaller. Instead of embedding the full reference for every command and subcommand, it lists the available commands, global options, and aliases. Agents look up a command's arguments, options, subcommands, and examples when they need them by adding `--help` to its args, for example `{"command": "step", "args": ["commit", "--help"]}`. Help calls return immediately with the reference as Markdown and as structured `data`. Startup also no longer runs a help probe for every subcommand.

*By @mavam in #29.*
