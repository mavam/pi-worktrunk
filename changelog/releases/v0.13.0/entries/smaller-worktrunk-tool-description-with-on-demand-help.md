---
title: Smaller worktrunk tool description with on-demand help
type: change
authors:
  - mavam
prs:
  - 29
created: 2026-10-23T06:24:16.904254Z
---

The `worktrunk` tool description is now about 90% smaller. Instead of embedding the full reference for every command and subcommand, it lists the available commands, global options, and aliases. Agents look up a command's arguments, options, subcommands, and examples when they need them by adding `--help` to its args, for example `{"command": "step", "args": ["commit", "--help"]}`. Help calls return immediately with the reference as Markdown and as structured `data`. Startup also no longer runs a help probe for every subcommand.
