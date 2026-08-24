import assert from "node:assert/strict";
import test from "node:test";

import {
  generateSource,
  parseCommand,
  parseExamples,
  parseSectionEntries,
  renderToolExample,
  splitShell,
} from "./generate-worktrunk-reference.ts";

const switchHelp = `wt switch - Switch to a worktree; create if needed

Usage: wt switch [OPTIONS] [BRANCH]

Arguments:
  [BRANCH]
          Branch, path, or shortcut

          Shortcuts include ^, -, @, pr:{N}, and mr:{N}.

Options:
  -c, --create
          Create a new branch

  -b, --base <BASE>
          Base branch

          Defaults to the default branch and accepts the same shortcuts as BRANCH.

  -h, --help
          Print help

Examples

  wt switch --create new-feature  # Create branch and worktree
  wt -v switch pr:123
`;

test("help parsing preserves arguments and useful option prose", () => {
  assert.deepEqual(parseSectionEntries(switchHelp, new Set(["Arguments"]), "argument"), [{
    syntax: "[BRANCH]",
    description: "Branch, path, or shortcut Shortcuts include ^, -, @, pr:{N}, and mr:{N}.",
  }]);
  assert.deepEqual(parseSectionEntries(switchHelp, new Set(["Options"]), "option"), [
    { syntax: "-c, --create", description: "Create a new branch" },
    {
      syntax: "-b, --base <BASE>",
      description: "Base branch Defaults to the default branch and accepts the same shortcuts as BRANCH.",
    },
  ]);
});

test("examples become command plus remaining args", () => {
  assert.deepEqual(splitShell(`switch --create "two words" # comment`), [
    "switch", "--create", "two words",
  ]);
  assert.equal(splitShell("switch main | cat"), undefined);
  assert.deepEqual(parseExamples(switchHelp), [
    ["switch", "--create", "new-feature"],
    ["-v", "switch", "pr:123"],
  ]);
  assert.equal(
    renderToolExample(["-v", "switch", "pr:123"], new Set(["switch"])),
    '{"command":"switch","args":["-v","pr:123"]}',
  );
});

test("subcommands use their parent summary as a fallback", () => {
  const parsed = parseCommand(["hook", "pre-switch"], "Run pre-switch hooks\n\nUsage: wt hook pre-switch", "Fallback");
  assert.equal(parsed.summary, "Run pre-switch hooks");
  const fallback = parseCommand(["hook", "pre-switch"], "wt hook pre-switch\n", "Run pre-switch hooks");
  assert.equal(fallback.summary, "Run pre-switch hooks");
});

test("generation emits an enum and model-facing examples", () => {
  const outputs = new Map([
    ["", `wt - Worktree manager\n\nCommands:\n  switch  Switch worktrees\n\nOptions:\n  -h, --help  Print help\n`],
    ["switch", switchHelp],
  ]);
  const generated = generateSource((path) => outputs.get(path.join(" ")) ?? "", "wt v-test");
  assert.match(generated.source, /WORKTRUNK_REFERENCE_VERSION = "wt v-test"/);
  assert.match(generated.source, /WORKTRUNK_COMMANDS = \["switch"\]/);
  assert.match(generated.source, /Arguments:\n- \[BRANCH\]: Branch, path, or shortcut/);
  assert.match(generated.source, /\{"command":"switch","args":\["--create","new-feature"\]\}/);
});
