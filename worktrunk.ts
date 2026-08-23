import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  SessionManager,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import {
  Text,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const MARKERS = {
  working: "🤖",
  waiting: "💬",
} as const;

const WORKTREE_ACTIONS = [
  "list",
  "status",
  "create",
  "remove",
  "path",
  "settings",
] as const;

type WorktreeAction = (typeof WORKTREE_ACTIONS)[number];

type WtResult = {
  stdout?: string;
  stderr?: string;
  code: number;
  killed?: boolean;
  relocated?: boolean;
};

type RunWtOptions = {
  cwd?: string;
  signal?: AbortSignal;
  cwdMode?: "repository-read";
};

type RunWt = (args: string[], options?: RunWtOptions) => Promise<WtResult>;

export type SessionSnapshot = {
  header: SessionHeader;
  entries: SessionEntry[];
};

type SessionFork = {
  destinationSession: string;
};

type Relation = {
  ahead?: number;
  behind?: number;
};

type WorktreeItem = {
  branch: string | null;
  head?: {
    short_sha?: string;
    subject?: string;
  };
  worktree?: {
    path?: string;
    main?: boolean;
    current?: boolean;
    previous?: boolean;
    changes?: {
      staged?: boolean;
      modified?: boolean;
      untracked?: boolean;
      renamed?: boolean;
      deleted?: boolean;
      conflicted?: boolean;
    };
  };
  default_branch?: Relation;
  upstream?: Relation;
  display?: {
    state?: string;
    symbols?: string;
    statusline?: string;
  };
};

type WorktreeList = {
  schema: number;
  items: WorktreeItem[];
};

type BranchOutcome =
  | "deleted"
  | "deferred"
  | "not_attempted"
  | "retained_unmerged"
  | "retained_checked_out"
  | "retained_raced"
  | "retained_failed";

type RemovalOutcome = {
  kind?: "worktree" | "branch";
  branch: string | null;
  path?: string;
  pruned?: boolean;
  branch_outcome?: BranchOutcome;
  branch_checked_out_at?: string | null;
  branch_deleted?: boolean;
};

type ToolOutputDetails = {
  action: WorktreeAction;
  truncated: boolean;
  fullOutputPath?: string;
  display?: string;
  displayTruncated?: boolean;
  displayFullOutputPath?: string;
};

export type WorktrunkAlias = {
  name: string;
  steps: string[];
};

type AliasToolOutputDetails = {
  alias: string;
  args: string[];
  cancelled?: boolean;
  truncated: boolean;
  fullOutputPath?: string;
};

export function markerArgs(marker?: string): string[] {
  return marker === undefined
    ? ["config", "state", "marker", "clear"]
    : ["config", "state", "marker", "set", marker];
}

export function createMarkerUpdater(runWt: RunWt) {
  let enabled = true;

  async function update(marker?: string, cwd?: string): Promise<void> {
    if (!enabled || (cwd !== undefined && !existsSync(cwd))) return;

    try {
      const result = await runWt(markerArgs(marker), { cwd });
      if (result.code !== 0) enabled = false;
    } catch {
      enabled = false;
    }
  }

  return {
    markWorking: (cwd?: string) => update(MARKERS.working, cwd),
    markWaiting: (cwd?: string) => update(MARKERS.waiting, cwd),
    clear: (cwd?: string) => update(undefined, cwd),
  };
}

class WorktrunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktrunkError";
  }
}

function serializeSession(snapshot: SessionSnapshot): string {
  return `${[snapshot.header, ...snapshot.entries]
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`;
}

function sessionFileIsUnwritten(path: string): boolean {
  return !existsSync(path) || statSync(path).size === 0;
}

function targetSessionDirectory(
  manager: ExtensionCommandContext["sessionManager"],
): string | undefined {
  const fullManager = manager as typeof manager & {
    usesDefaultSessionDir?: () => boolean;
  };
  return fullManager.usesDefaultSessionDir?.()
    ? undefined
    : manager.getSessionDir();
}

export function materializeSessionSnapshot(
  path: string,
  snapshot: SessionSnapshot,
): void {
  if (!sessionFileIsUnwritten(path)) return;
  writeFileSync(path, serializeSession(snapshot), {
    encoding: "utf8",
    flag: existsSync(path) ? "w" : "wx",
  });
}

export function forkSessionFromSnapshot(
  sourceSession: string,
  targetCwd: string,
  snapshot?: SessionSnapshot,
  targetSessionDir?: string,
): SessionFork {
  if (sessionFileIsUnwritten(sourceSession)) {
    if (!snapshot) {
      throw new Error("Cannot copy an unwritten session without a snapshot.");
    }
    materializeSessionSnapshot(sourceSession, snapshot);
  }

  const session = SessionManager.forkFrom(
    sourceSession,
    targetCwd,
    targetSessionDir,
  );
  const destinationSession = session.getSessionFile();
  if (!destinationSession) {
    throw new Error("Pi did not create a persisted session copy.");
  }
  return { destinationSession };
}

function parseJson<T>(output: string, command: string): T {
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    throw new WorktrunkError(
      `Could not parse \`${command}\` output: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function parseWorktreeList(output: string): WorktreeItem[] {
  const result = parseJson<WorktreeList>(output, "wt list --format=json");
  if (result.schema !== 2 || !Array.isArray(result.items)) {
    throw new WorktrunkError(
      "Unexpected `wt list --format=json` output from Worktrunk 0.70 or later.",
    );
  }
  return result.items;
}

function resolveWorktree(
  worktrees: WorktreeItem[],
  ref: string,
): WorktreeItem | undefined {
  const byBranch = worktrees.filter((item) => item.branch === ref);
  if (byBranch.length > 1) {
    throw new WorktrunkError(
      `Branch ${ref} has multiple worktrees. Use an exact path.`,
    );
  }
  if (byBranch[0]) return byBranch[0];

  const byPath = worktrees.find((item) => item.worktree?.path === ref);
  if (byPath) return byPath;

  const byName = worktrees.filter(
    (item) => item.worktree?.path && basename(item.worktree.path) === ref,
  );
  return byName.length === 1 ? byName[0] : undefined;
}

function approvalHint(output: string): string {
  if (!/needs approval|cannot prompt for approval/i.test(output)) return "";
  return (
    "\nReview and approve the project commands in a terminal with " +
    "`wt config approvals add`, then retry."
  );
}

function missingCwdMessage(cwd: string): string {
  return (
    `Pi's working directory no longer exists: ${cwd}. ` +
    "Continue the session from an existing worktree or restart Pi there."
  );
}

function formatWtFailure(
  args: string[],
  result: WtResult,
  cwd: string,
): string {
  const output = [result.stderr?.trim(), result.stdout?.trim()]
    .filter(Boolean)
    .join("\n");

  if (result.killed) return `wt ${args.join(" ")} was cancelled.`;
  if (!existsSync(cwd)) return missingCwdMessage(cwd);
  if (!output || result.code === 127 || /\bENOENT\b/i.test(output)) {
    return (
      "Could not start Worktrunk (`wt`). Install Worktrunk 0.70 or later " +
      "and ensure it is available on `PATH`."
    );
  }

  return `wt ${args.join(" ")} failed: ${output}${approvalHint(output)}`;
}

export function createWorktrunkClient(runWt: RunWt) {
  async function run(
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    cwdMode?: "repository-read",
  ): Promise<WtResult> {
    let result: WtResult;
    try {
      result = await runWt(args, { cwd, signal, cwdMode });
    } catch (error) {
      throw new WorktrunkError(
        !existsSync(cwd)
          ? missingCwdMessage(cwd)
          : `Could not execute Worktrunk: ${
              error instanceof Error ? error.message : String(error)
            }`,
      );
    }
    if (result.code !== 0) {
      throw new WorktrunkError(formatWtFailure(args, result, cwd));
    }
    return result;
  }

  async function list(cwd: string, signal?: AbortSignal) {
    const result = await run(
      ["--config-set", "list.json-schema=2", "list", "--format=json"],
      cwd,
      signal,
      "repository-read",
    );
    const worktrees = parseWorktreeList(result.stdout ?? "");
    if (result.relocated) {
      for (const item of worktrees) {
        if (item.worktree) item.worktree.current = false;
      }
    }
    return worktrees;
  }

  return {
    list,

    async status(cwd: string, signal?: AbortSignal) {
      return (await list(cwd, signal)).find(
        (item) => item.worktree?.current === true,
      );
    },

    async listText(cwd: string, signal?: AbortSignal) {
      const result = await run(
        ["list"],
        cwd,
        signal,
        "repository-read",
      );
      const table = result.stdout?.trimEnd() ?? "";
      const summary = result.stderr?.trim() ?? "";
      return [table, summary].filter(Boolean).join("\n\n");
    },

    async create(cwd: string, branch: string, signal?: AbortSignal) {
      const result = await run(
        ["switch", "--create", "--no-cd", "--format=json", branch],
        cwd,
        signal,
      );
      const created = parseJson<{
        branch?: string;
        path?: string;
        created_branch?: boolean;
        base_branch?: string;
      }>(result.stdout ?? "", "wt switch --format=json");
      if (!created.path) {
        throw new WorktrunkError(
          `Worktrunk created ${branch}, but did not report its path.`,
        );
      }
      const display = result.stderr?.trimEnd();
      return {
        branch: created.branch ?? branch,
        path: created.path,
        ...(created.created_branch !== undefined
          ? { createdBranch: created.created_branch }
          : {}),
        ...(created.base_branch ? { baseBranch: created.base_branch } : {}),
        ...(display ? { display } : {}),
      };
    },

    async remove(cwd: string, ref: string, signal?: AbortSignal) {
      const result = await run(
        ["remove", "--foreground", "--format=json", ref],
        cwd,
        signal,
      );
      return {
        outcomes: parseJson<RemovalOutcome[]>(
          result.stdout ?? "",
          "wt remove --format=json",
        ),
        display: result.stderr?.trimEnd() || undefined,
      };
    },

    async settings(cwd: string, signal?: AbortSignal) {
      const result = await run(
        ["config", "show", "--format=json"],
        cwd,
        signal,
        "repository-read",
      );
      return result.stdout?.trim() ?? "";
    },

    async settingsText(cwd: string, signal?: AbortSignal) {
      const result = await run(
        ["config", "show"],
        cwd,
        signal,
        "repository-read",
      );
      return result.stdout?.trimEnd() ?? "";
    },
  };
}

export type WorktrunkClient = ReturnType<typeof createWorktrunkClient>;

function relationText(relation?: Relation): string {
  return `ahead ${relation?.ahead ?? 0}, behind ${relation?.behind ?? 0}`;
}

function changeText(item: WorktreeItem): string {
  const changes = item.worktree?.changes;
  const active = [
    changes?.staged ? "staged" : undefined,
    changes?.modified ? "modified" : undefined,
    changes?.untracked ? "untracked" : undefined,
    changes?.renamed ? "renamed" : undefined,
    changes?.deleted ? "deleted" : undefined,
    changes?.conflicted ? "conflicted" : undefined,
  ].filter(Boolean);
  return active.length > 0 ? active.join(", ") : "clean";
}

function formatWorktree(item: WorktreeItem): string {
  const labels = [
    item.worktree?.current ? "current" : undefined,
    item.worktree?.main ? "main" : undefined,
  ].filter(Boolean);
  const suffix = labels.length > 0 ? ` [${labels.join(", ")}]` : "";
  const symbols = item.display?.symbols ? ` ${item.display.symbols}` : "";
  return `${item.branch ?? "(detached)"}${suffix}${symbols}`;
}

function formatWorktreeStatus(item: WorktreeItem): string {
  return [
    `Branch: ${item.branch ?? "(detached)"}`,
    `Path: ${item.worktree?.path ?? "(no worktree path)"}`,
    `Current: ${item.worktree?.current ? "yes" : "no"}`,
    `Primary: ${item.worktree?.main ? "yes" : "no"}`,
    `State: ${item.display?.state ?? "normal"}`,
    `Changes: ${changeText(item)}`,
    `Default branch: ${relationText(item.default_branch)}`,
    `Upstream: ${relationText(item.upstream)}`,
    `HEAD: ${item.head?.short_sha ?? "unknown"}${
      item.head?.subject ? ` ${item.head.subject}` : ""
    }`,
  ].join("\n");
}

function removableRef(item: WorktreeItem): string {
  if (item.worktree?.main) {
    throw new WorktrunkError("The primary worktree cannot be removed.");
  }
  if (item.worktree?.current) {
    throw new WorktrunkError(
      "The current worktree cannot be removed. Use another worktree first.",
    );
  }
  const ref = item.worktree?.path ?? item.branch;
  if (!ref) throw new WorktrunkError("The worktree has no removable reference.");
  return ref;
}

const SUBCOMMANDS = [
  "switch",
  "list",
  "remove",
  "merge",
  "step",
  "hook",
  "config",
] as const;

const RESERVED_SUBCOMMANDS = new Set<string>([
  ...SUBCOMMANDS,
  "worktree",
]);

const SESSION_TRANSITION_MESSAGE = "pi-worktrunk-session-transition";
const PLACEMENT_MODIFIERS = new Set(["--go", "--stay", "--fork"]);
const GLOBAL_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "--config",
  "--config-set",
]);

type PlacementModifier = "go" | "stay" | "fork";
type SessionPosture = "infer" | "follow" | "stay" | "ask";

type SessionLocation = {
  branch: string | null;
  path: string;
  commonDir?: string;
};

type SessionTransitionKind = "move" | "fork" | "recovery";

type SessionTransitionDetails = {
  kind: SessionTransitionKind;
  source: SessionLocation;
  target: SessionLocation;
  trail: SessionLocation[];
  sourceSession: string;
  destinationSession: string;
};

type ParsedWtInvocation = {
  args: string[];
  command?: string;
  commandIndex?: number;
  commandArgs: string[];
  modifier?: PlacementModifier;
};

const WORKTRUNK_ALIAS_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function parseWorktrunkAliasNames(output: string): string[] {
  const aliases: string[] = [];
  let inAliases = false;

  for (const line of output.split("\n")) {
    if (!inAliases) {
      if (line.trim() === "Aliases:") inAliases = true;
      continue;
    }
    if (!line.trim()) break;
    if (!/^\s/.test(line)) break;

    for (const value of line.split(",")) {
      const name = value.trim();
      if (WORKTRUNK_ALIAS_NAME.test(name) && !aliases.includes(name)) {
        aliases.push(name);
      }
    }
  }

  return aliases;
}

function aliasStepNames(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  const steps: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    for (const name of Object.keys(entry)) {
      if (WORKTRUNK_ALIAS_NAME.test(name) && !steps.includes(name)) {
        steps.push(name);
      }
    }
  }
  return steps;
}

export function parseWorktrunkAliasMetadata(
  names: readonly string[],
  configOutput: string,
): WorktrunkAlias[] {
  const aliases = new Map(
    names.map((name) => [name, { name, steps: [] as string[] }]),
  );
  let config: unknown;
  try {
    config = JSON.parse(configOutput);
  } catch {
    return [...aliases.values()];
  }
  if (!config || typeof config !== "object") return [...aliases.values()];

  for (const source of ["user", "project"] as const) {
    const layer = (config as Record<string, unknown>)[source];
    if (!layer || typeof layer !== "object") continue;
    const layerConfig = (layer as Record<string, unknown>).config;
    if (!layerConfig || typeof layerConfig !== "object") continue;
    const configuredAliases = (layerConfig as Record<string, unknown>).aliases;
    if (!configuredAliases || typeof configuredAliases !== "object") continue;

    for (const [name, value] of Object.entries(configuredAliases)) {
      const alias = aliases.get(name);
      if (!alias) continue;
      for (const step of aliasStepNames(value)) {
        if (!alias.steps.includes(step)) alias.steps.push(step);
      }
    }
  }
  return [...aliases.values()];
}

export function parseAliasArguments(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  let escaping = false;

  for (const character of input) {
    if (escaping) {
      current += character;
      started = true;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }

  if (escaping) {
    throw new WorktrunkError(
      "Invalid alias arguments: trailing escape character.",
    );
  }
  if (quote) {
    throw new WorktrunkError("Invalid alias arguments: unterminated quote.");
  }
  if (started) args.push(current);
  return args;
}

function findCommandIndex(args: readonly string[]): number | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--") return undefined;
    if (GLOBAL_OPTIONS_WITH_VALUES.has(value)) {
      index += 1;
      continue;
    }
    if (
      value.startsWith("--config=") ||
      value.startsWith("--config-set=") ||
      (value.startsWith("-C") && value !== "-C")
    ) {
      continue;
    }
    if (value.startsWith("-")) continue;
    return index;
  }
  return undefined;
}

export function parseWtInvocation(input: string): ParsedWtInvocation {
  const parsed = parseAliasArguments(input);
  const args: string[] = [];
  let modifier: PlacementModifier | undefined;
  let passthrough = false;

  for (const value of parsed) {
    if (value === "--") {
      passthrough = true;
      args.push(value);
      continue;
    }
    if (!passthrough && PLACEMENT_MODIFIERS.has(value)) {
      const next = value.slice(2) as PlacementModifier;
      if (modifier) {
        throw new WorktrunkError(
          "Use only one of --go, --stay, or --fork.",
        );
      }
      modifier = next;
      continue;
    }
    args.push(value);
  }

  const commandIndex = findCommandIndex(args);
  const command =
    commandIndex === undefined ? undefined : args[commandIndex];
  return {
    args,
    command,
    commandIndex,
    commandArgs:
      commandIndex === undefined ? [] : args.slice(commandIndex + 1),
    ...(modifier ? { modifier } : {}),
  };
}

function requireBranch(args: string): string {
  if (!args || /\s/.test(args) || args.startsWith("-")) {
    throw new WorktrunkError("The create action requires one branch name.");
  }
  return args;
}

export function configuredSessionPosture(
  value = process.env.PI_WORKTRUNK_POSTURE,
): SessionPosture {
  return value === "follow" || value === "stay" || value === "ask"
    ? value
    : "infer";
}

export function defaultPlacementAction(options: {
  posture: SessionPosture;
  interactive: boolean;
  persisted: boolean;
  command?: string;
  targetCreated: boolean;
  hasTarget: boolean;
}): "go" | "stay" | "ask" {
  if (!options.interactive || !options.persisted) return "stay";
  if (options.posture === "stay") return "stay";
  if (options.posture === "follow") {
    return options.hasTarget ? "go" : "stay";
  }
  if (options.posture === "ask") {
    return options.hasTarget ? "ask" : "stay";
  }
  return options.command === "switch" &&
    !options.targetCreated &&
    options.hasTarget
    ? "go"
    : "stay";
}

function isBareCommand(invocation: ParsedWtInvocation, command: string): boolean {
  return invocation.command === command && invocation.commandArgs.length === 0;
}

function commandOptions(args: readonly string[]): readonly string[] {
  const delimiter = args.indexOf("--");
  return delimiter === -1 ? args : args.slice(0, delimiter);
}

function hasExecuteFlag(args: readonly string[]): boolean {
  return commandOptions(args).some(
    (value) =>
      value === "--execute" ||
      value === "-x" ||
      (value.startsWith("-x") && value.length > 2) ||
      value.startsWith("--execute="),
  );
}

function switchReferenceIndex(args: readonly string[]): number | undefined {
  const optionsWithValues = new Set(["-b", "--base", "-x", "--execute"]);
  const delimiter = args.indexOf("--");
  const values = delimiter === -1 ? args : args.slice(0, delimiter);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (optionsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if (value === "-") return index;
    if (
      value.startsWith("--base=") ||
      value.startsWith("--execute=") ||
      value.startsWith("-")
    ) {
      continue;
    }
    return index;
  }
  return undefined;
}

function switchReference(args: readonly string[]): string | undefined {
  const index = switchReferenceIndex(args);
  return index === undefined ? undefined : args[index];
}

function retargetSwitch(
  invocation: ParsedWtInvocation,
  target: string,
): ParsedWtInvocation {
  const commandIndex = invocation.commandIndex;
  if (commandIndex === undefined) return invocation;
  const args = [...invocation.args];
  const referenceIndex = switchReferenceIndex(invocation.commandArgs);
  if (referenceIndex === undefined) {
    args.splice(commandIndex + 1, 0, target);
  } else {
    args[commandIndex + 1 + referenceIndex] = target;
  }
  return {
    ...invocation,
    args,
    commandArgs: args.slice(commandIndex + 1),
  };
}

function withStructuredSwitchOutput(
  invocation: ParsedWtInvocation,
): string[] {
  const commandIndex = invocation.commandIndex;
  if (commandIndex === undefined) return invocation.args;
  const beforeCommand = invocation.args.slice(0, commandIndex);
  const sourceArgs = invocation.args.slice(commandIndex + 1);
  const delimiter = sourceArgs.indexOf("--");
  const commandArgs = delimiter === -1 ? sourceArgs : sourceArgs.slice(0, delimiter);
  const executeArgs = delimiter === -1 ? [] : sourceArgs.slice(delimiter);
  const filtered: string[] = [];
  for (let index = 0; index < commandArgs.length; index += 1) {
    const value = commandArgs[index];
    if (value === "--format") {
      index += 1;
      continue;
    }
    if (value.startsWith("--format=")) continue;
    filtered.push(value);
  }
  return [
    ...beforeCommand,
    "switch",
    ...filtered,
    "--no-cd",
    "--format=json",
    ...executeArgs,
  ];
}

async function chooseWorktree(
  ctx: ExtensionCommandContext,
  title: string,
  worktrees: WorktreeItem[],
): Promise<WorktreeItem | undefined> {
  if (worktrees.length === 0) return undefined;
  const options = worktrees.map(formatWorktree);
  const selected = await ctx.ui.select(title, options);
  const index = selected === undefined ? -1 : options.indexOf(selected);
  return index >= 0 ? worktrees[index] : undefined;
}

function requestedJsonOutput(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--format" && args[index + 1] === "json") return true;
    if (value === "--format=json") return true;
  }
  return false;
}

function commandOutput(result: WtResult, hideStdout = false): string {
  const stdout = hideStdout ? "" : result.stdout?.trimEnd();
  return [stdout, result.stderr?.trimEnd()].filter(Boolean).join("\n");
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function worktreeLocation(
  item: WorktreeItem | undefined,
  fallbackPath: string,
  commonDir?: string,
): SessionLocation {
  return {
    branch: item?.branch ?? null,
    path: canonicalPath(item?.worktree?.path ?? fallbackPath),
    ...(commonDir ? { commonDir } : {}),
  };
}

function readSessionTrail(ctx: ExtensionCommandContext): SessionLocation[] {
  for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
    if (
      entry.type !== "custom_message" ||
      entry.customType !== SESSION_TRANSITION_MESSAGE ||
      !entry.details ||
      typeof entry.details !== "object" ||
      !("trail" in entry.details) ||
      !Array.isArray(entry.details.trail)
    ) {
      continue;
    }
    return entry.details.trail.filter(
      (location): location is SessionLocation =>
        Boolean(
          location &&
          typeof location === "object" &&
          "path" in location &&
          typeof location.path === "string" &&
          "branch" in location &&
          (typeof location.branch === "string" || location.branch === null),
        ),
    );
  }
  return [];
}

function itemForPath(
  worktrees: readonly WorktreeItem[],
  path: string,
): WorktreeItem | undefined {
  const absolute = canonicalPath(path);
  return worktrees.find(
    (item) =>
      item.worktree?.path && canonicalPath(item.worktree.path) === absolute,
  );
}

function uniqueCreatedTarget(
  before: readonly WorktreeItem[],
  after: readonly WorktreeItem[],
): WorktreeItem | undefined {
  const previousPaths = new Set(
    before.flatMap((item) =>
      item.worktree?.path ? [canonicalPath(item.worktree.path)] : [],
    ),
  );
  const created = after.filter(
    (item) =>
      item.worktree?.path && !previousPaths.has(canonicalPath(item.worktree.path)),
  );
  return created.length === 1 ? created[0] : undefined;
}

function sameRepository(
  location: SessionLocation,
  commonDir: string | undefined,
): boolean {
  return !location.commonDir ||
    !commonDir ||
    canonicalPath(location.commonDir) === canonicalPath(commonDir);
}

function backTarget(
  trail: readonly SessionLocation[],
  worktrees: readonly WorktreeItem[],
  commonDir: string | undefined,
): WorktreeItem | undefined {
  for (let index = trail.length - 1; index >= 0; index -= 1) {
    const location = trail[index];
    if (!sameRepository(location, commonDir)) continue;
    const target = itemForPath(worktrees, location.path);
    if (target) return target;
  }
  return worktrees.find((item) => item.worktree?.main);
}

function survivingTrail(
  trail: readonly SessionLocation[],
  worktrees: readonly WorktreeItem[],
  excludePath?: string,
): SessionLocation[] {
  return trail.filter((location) => {
    if (
      excludePath &&
      canonicalPath(location.path) === canonicalPath(excludePath)
    ) {
      return false;
    }
    return Boolean(itemForPath(worktrees, location.path));
  });
}

function recoveryTarget(
  trail: readonly SessionLocation[],
  worktrees: readonly WorktreeItem[],
): { target?: WorktreeItem; trail: SessionLocation[] } {
  for (let index = trail.length - 1; index >= 0; index -= 1) {
    const target = itemForPath(worktrees, trail[index].path);
    if (target) return { target, trail: trail.slice(0, index) };
  }
  const target =
    worktrees.find((item) => item.worktree?.main) ??
    worktrees.find((item) => item.worktree?.path);
  return { target, trail: [] };
}

function nextTrail(
  trail: readonly SessionLocation[],
  source: SessionLocation,
  target: SessionLocation,
  back: boolean,
): SessionLocation[] {
  if (back) {
    const index = [...trail]
      .map((location) => canonicalPath(location.path))
      .lastIndexOf(canonicalPath(target.path));
    if (index >= 0) return [...trail.slice(0, index), source];
  }
  return [...trail, source].slice(-32);
}

function createLinkedSession(
  ctx: ExtensionCommandContext,
  source: SessionLocation,
  target: SessionLocation,
  trail: SessionLocation[],
  kind: SessionTransitionKind,
): string {
  const sourceSession = ctx.sessionManager.getSessionFile();
  if (!sourceSession) {
    throw new WorktrunkError(
      `Cannot ${kind === "fork" ? "fork" : "move"} an ephemeral Pi session.`,
    );
  }

  let snapshot: SessionSnapshot | undefined;
  if (sessionFileIsUnwritten(sourceSession)) {
    const header = ctx.sessionManager.getHeader();
    if (!header) throw new WorktrunkError("The source session has no header.");
    snapshot = {
      header: structuredClone(header),
      entries: structuredClone(ctx.sessionManager.getEntries()),
    };
  }
  const targetSessionDir = targetSessionDirectory(ctx.sessionManager);
  const { destinationSession } = forkSessionFromSnapshot(
    sourceSession,
    target.path,
    snapshot,
    targetSessionDir,
  );
  const destination = SessionManager.open(destinationSession, targetSessionDir);
  const verb = kind === "fork"
    ? "forked"
    : kind === "recovery"
      ? "recovered"
      : "moved";
  destination.appendCustomMessageEntry(
    SESSION_TRANSITION_MESSAGE,
    `The Pi session ${verb} from ${source.path} to ${target.path}. Use the destination worktree for subsequent file operations. Previous absolute paths may be stale.`,
    true,
    {
      kind,
      source,
      target,
      trail,
      sourceSession,
      destinationSession,
    } satisfies SessionTransitionDetails,
  );
  return destinationSession;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function formatToolOutput(
  action: string,
  output: string,
  suffix?: string,
) {
  const text = output || "(no output)";
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) {
    return { text, truncated: false as const };
  }

  const directory = await mkdtemp(join(tmpdir(), "pi-worktrunk-"));
  const filename = suffix ? `${action}-${suffix}.txt` : `${action}.txt`;
  const fullOutputPath = join(directory, filename);
  await writeFile(fullOutputPath, text, "utf8");
  const notice =
    `\n\n[Output truncated to ${DEFAULT_MAX_LINES} lines or ` +
    `${formatSize(DEFAULT_MAX_BYTES)}. Full output: ${fullOutputPath}]`;
  return {
    text: truncation.content + notice,
    truncated: true as const,
    fullOutputPath,
  };
}

async function runWorktrunkAlias(
  alias: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  runWt: RunWt,
) {
  let result: WtResult;
  try {
    result = await runWt([alias, ...args], { cwd, signal });
  } catch (error) {
    throw new WorktrunkError(
      !existsSync(cwd)
        ? missingCwdMessage(cwd)
        : `Could not execute Worktrunk: ${
            error instanceof Error ? error.message : String(error)
          }`,
    );
  }
  if (result.code !== 0 || result.killed) {
    throw new WorktrunkError(formatWtFailure([alias, ...args], result, cwd));
  }

  const output = [result.stdout?.trimEnd(), result.stderr?.trimEnd()]
    .filter(Boolean)
    .join("\n");
  const rendered = await formatToolOutput(
    `alias-${alias}`,
    output || `wt ${alias} completed.`,
  );
  return { ...rendered, cwdExists: existsSync(cwd) };
}

function aliasRecoveryHint(cwdExists: boolean): string {
  return cwdExists
    ? ""
    :
      "\n\nThe alias removed Pi's working directory. Use " +
      "`/wt switch <target> --go` from a surviving worktree.";
}

async function toolResult(
  action: WorktreeAction,
  value: unknown,
  display?: string,
) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const output = await formatToolOutput(action, text);
  const rendered = display
    ? await formatToolOutput(action, display, "display")
    : undefined;
  const details: ToolOutputDetails = {
    action,
    truncated: output.truncated,
    ...(output.fullOutputPath
      ? { fullOutputPath: output.fullOutputPath }
      : {}),
    ...(rendered
      ? {
          display: rendered.text,
          displayTruncated: rendered.truncated,
          ...(rendered.fullOutputPath
            ? { displayFullOutputPath: rendered.fullOutputPath }
            : {}),
        }
      : {}),
  };
  return {
    content: [{ type: "text" as const, text: output.text }],
    details,
  };
}

class WorktrunkOutput implements Component {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return this.text
      .split("\n")
      .map((line) => truncateToWidth(line, Math.max(1, width), "…"));
  }

  invalidate(): void {}
}

function resultText(result: {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}): string {
  const details = result.details as ToolOutputDetails | undefined;
  if (details?.display) return details.display;
  const text = result.content.find((item) => item.type === "text")?.text;
  return text ?? "";
}

async function tuiDisplay(
  mode: string,
  getDisplay: () => Promise<string>,
): Promise<string | undefined> {
  if (mode !== "tui") return undefined;
  try {
    return await getDisplay();
  } catch {
    return undefined;
  }
}

async function removeWithTool(
  client: WorktrunkClient,
  cwd: string,
  targetRef: string | undefined,
  signal?: AbortSignal,
) {
  const ref = targetRef?.trim();
  if (!ref) throw new WorktrunkError("The remove action requires `target`.");
  const target = resolveWorktree(await client.list(cwd, signal), ref);
  if (!target) throw new WorktrunkError(`Worktree not found: ${ref}`);
  return client.remove(cwd, removableRef(target), signal);
}

const WorktreeActionSchema = Type.Unsafe<WorktreeAction>({
  type: "string",
  enum: WORKTREE_ACTIONS,
  description: "The Worktrunk operation to perform.",
});

const REPOSITORY_IDENTITY_ENTRY = "pi-worktrunk-repository";

type RepositoryIdentity = {
  commonDir: string;
  device: number;
  inode: number;
};

function repositoryIdentity(commonDir: string): RepositoryIdentity | undefined {
  try {
    const stat = statSync(commonDir);
    return { commonDir, device: stat.dev, inode: stat.ino };
  } catch {
    return undefined;
  }
}

function sameRepositoryIdentity(
  left: RepositoryIdentity | undefined,
  right: RepositoryIdentity | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.commonDir === right.commonDir &&
      left.device === right.device &&
      left.inode === right.inode,
  );
}

function gitWorktreePaths(output: string): string[] {
  return output
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer?.(
    SESSION_TRANSITION_MESSAGE,
    (message, { expanded, outputPad }, theme) => {
      const details = message.details as Partial<SessionTransitionDetails> | undefined;
      const kind = details?.kind === "fork" || details?.kind === "recovery"
        ? details.kind
        : "move";
      const presentation = kind === "fork"
        ? { icon: "⑂", title: "Session forked" }
        : kind === "recovery"
          ? { icon: "↩", title: "Session recovered" }
          : { icon: "↪", title: "Session moved" };
      const source = details?.source;
      const target = details?.target;
      const locationLabel = (location: SessionLocation) =>
        location.branch ?? basename(location.path);
      const compactPath = (path: string) => {
        const home = homedir();
        return path === home || path.startsWith(`${home}${sep}`)
          ? `~${path.slice(home.length)}`
          : path;
      };

      let text = theme.fg(
        "accent",
        theme.bold(`${presentation.icon} ${presentation.title}`),
      );
      if (source?.path && target?.path) {
        text += `\n  ${theme.fg("muted", locationLabel(source))}`;
        text += ` ${theme.fg("dim", "→")} `;
        text += theme.fg("accent", theme.bold(locationLabel(target)));
        if (expanded) {
          text += `\n\n  ${theme.fg("dim", "From")}  ${compactPath(source.path)}`;
          text += `\n  ${theme.fg("dim", "To")}    ${compactPath(target.path)}`;
        }
      } else if (target?.path) {
        text += `\n  ${theme.fg("accent", theme.bold(locationLabel(target)))}`;
        if (expanded) {
          text += `\n\n  ${theme.fg("dim", "To")}  ${compactPath(target.path)}`;
        }
      } else {
        const content = typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
        text += `\n  ${theme.fg("muted", content)}`;
      }
      return new Text(text, outputPad, 0);
    },
  );

  const execWt: RunWt = (args, options) => pi.exec("wt", args, options);
  let storedRepositoryIdentity: RepositoryIdentity | undefined;

  async function readCommonDir(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!existsSync(cwd)) return undefined;
    const result = await pi.exec(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, signal },
    );
    if (result.code !== 0 || !result.stdout.trim()) return undefined;
    return resolve(cwd, result.stdout.trim());
  }

  async function findRepositoryWorktree(
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const identity = storedRepositoryIdentity;
    if (
      !identity ||
      !sameRepositoryIdentity(identity, repositoryIdentity(identity.commonDir))
    ) {
      return undefined;
    }
    const commonDir = identity.commonDir;
    const result = await pi.exec(
      "git",
      ["--git-dir", commonDir, "worktree", "list", "--porcelain", "-z"],
      { cwd: dirname(commonDir), signal },
    );
    if (result.code !== 0) return undefined;

    for (const path of gitWorktreePaths(result.stdout)) {
      if (!existsSync(path)) continue;
      if ((await readCommonDir(path, signal)) === commonDir) return path;
    }
    return undefined;
  }

  const runWt: RunWt = async (args, options) => {
    const { cwdMode, ...execOptions } = options ?? {};
    const requestedCwd = execOptions.cwd;
    if (
      !requestedCwd ||
      existsSync(requestedCwd) ||
      cwdMode !== "repository-read"
    ) {
      return execWt(args, execOptions);
    }
    const fallbackCwd = await findRepositoryWorktree(execOptions.signal);
    if (!fallbackCwd) return execWt(args, execOptions);
    const result = await execWt(args, { ...execOptions, cwd: fallbackCwd });
    return { ...result, relocated: true };
  };
  const tracker = createMarkerUpdater(execWt);
  const client = createWorktrunkClient(runWt);
  const worktrunkAliases = new Set<string>();
  let worktrunkAliasMetadata: WorktrunkAlias[] = [];

  async function discoverAliases(ctx: ExtensionContext) {
    worktrunkAliases.clear();
    worktrunkAliasMetadata = [];
    let result: WtResult;
    try {
      result = await runWt(["--help"], {
        cwd: ctx.cwd,
        cwdMode: "repository-read",
      });
    } catch {
      return;
    }
    if (result.code !== 0) return;

    for (const alias of parseWorktrunkAliasNames(result.stdout ?? "")) {
      if (!RESERVED_SUBCOMMANDS.has(alias)) worktrunkAliases.add(alias);
    }
    if (worktrunkAliases.size === 0) return;
    worktrunkAliasMetadata = [...worktrunkAliases].map((name) => ({
      name,
      steps: [],
    }));
    try {
      worktrunkAliasMetadata = parseWorktrunkAliasMetadata(
        [...worktrunkAliases],
        await client.settings(ctx.cwd, ctx.signal),
      );
    } catch {
      // Alias names are still useful when structured configuration is unavailable.
    }
  }

  function registerWorktrunkAliasTool() {
    if (worktrunkAliasMetadata.length === 0) return;
    const catalog = worktrunkAliasMetadata
      .map(({ name, steps }) =>
        steps.length > 0
          ? `- ${name}: ${steps.join(" -> ")}`
          : `- ${name}`,
      )
      .join("\n");
    const aliasNames = worktrunkAliasMetadata.map(({ name }) => name);
    const AliasNameSchema = Type.Unsafe<string>({
      type: "string",
      enum: aliasNames,
      description: `Configured Worktrunk alias to run. Available aliases:\n${catalog}`,
    });

    pi.registerTool({
      name: "worktree_alias",
      label: "Worktrunk Alias",
      description:
        "Run a configured Worktrunk alias after the user confirms the exact " +
        "invocation. Alias pipelines may merge, deploy, publish, remove " +
        "worktrees, or perform other external actions.",
      promptSnippet: `Run explicitly requested Worktrunk aliases: ${aliasNames.join(", ")}`,
      promptGuidelines: [
        "Use worktree_alias when the user explicitly requests an action that matches a configured Worktrunk alias.",
        "Only pass worktree_alias arguments that the user explicitly supplied; do not infer flags or operands.",
        "Do not call worktree_alias based only on an inferred next step; aliases may perform destructive or external actions.",
      ],
      parameters: Type.Object(
        {
          alias: AliasNameSchema,
          args: Type.Optional(
            Type.Array(
              Type.String({
                description:
                  "One argument passed directly to the alias without shell expansion.",
              }),
              {
                description:
                  "Arguments explicitly supplied by the user and passed directly to the alias.",
              },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const alias = params.alias.trim();
        if (!worktrunkAliases.has(alias)) {
          throw new WorktrunkError(
            `Worktrunk alias not available: ${alias || "(empty)"}. ` +
              `Available aliases: ${aliasNames.join(", ")}.`,
          );
        }
        const args = params.args ?? [];
        if (!ctx.hasUI) {
          throw new WorktrunkError(
            "Running a Worktrunk alias requires interactive or RPC mode so the user can confirm the exact command.",
          );
        }
        const metadata = worktrunkAliasMetadata.find(
          (candidate) => candidate.name === alias,
        );
        const formattedArgs = args.map((value) => JSON.stringify(value));
        const command = ["wt", alias, ...formattedArgs].join(" ");
        const confirmed = await ctx.ui.confirm(
          `Run Worktrunk alias ${alias}?`,
          [
            `Command: ${command}`,
            ...(metadata?.steps.length
              ? [`Pipeline: ${metadata.steps.join(" -> ")}`]
              : []),
            "",
            "This alias may perform destructive or external actions.",
          ].join("\n"),
        );
        if (!confirmed) {
          const details: AliasToolOutputDetails = {
            alias,
            args,
            cancelled: true,
            truncated: false,
          };
          return {
            content: [
              {
                type: "text" as const,
                text: `Cancelled Worktrunk alias ${alias}.`,
              },
            ],
            details,
          };
        }

        const result = await runWorktrunkAlias(
          alias,
          args,
          ctx.cwd,
          signal,
          runWt,
        );
        const details: AliasToolOutputDetails = {
          alias,
          args,
          truncated: result.truncated,
          ...(result.fullOutputPath
            ? { fullOutputPath: result.fullOutputPath }
            : {}),
        };
        return {
          content: [
            {
              type: "text" as const,
              text: result.text + aliasRecoveryHint(result.cwdExists),
            },
          ],
          details,
        };
      },
      renderCall(args, theme) {
        let text = theme.fg("toolTitle", theme.bold("Worktrunk Alias"));
        if (args.alias) text += ` › ${theme.fg("accent", args.alias)}`;
        if (args.args?.length) {
          text += ` ${theme.fg("muted", args.args.join(" "))}`;
        }
        return new Text(text, 0, 0);
      },
      renderResult(result) {
        return new Text(resultText(result), 0, 0);
      },
    });
  }

  async function restoreRepositoryIdentity(ctx: ExtensionContext) {
    const stored = [...ctx.sessionManager.getEntries()]
      .reverse()
      .find(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === REPOSITORY_IDENTITY_ENTRY &&
          typeof entry.data === "object" &&
          entry.data !== null &&
          "commonDir" in entry.data &&
          typeof entry.data.commonDir === "string",
      );
    if (stored?.type === "custom") {
      const data = stored.data as Partial<RepositoryIdentity>;
      if (
        typeof data.commonDir === "string" &&
        typeof data.device === "number" &&
        typeof data.inode === "number"
      ) {
        const identity = data as RepositoryIdentity;
        if (
          sameRepositoryIdentity(
            identity,
            repositoryIdentity(identity.commonDir),
          )
        ) {
          storedRepositoryIdentity = identity;
        }
      }
    }

    try {
      const commonDir = await readCommonDir(ctx.cwd);
      if (!commonDir) return;
      const identity = repositoryIdentity(commonDir);
      if (
        !identity ||
        sameRepositoryIdentity(identity, storedRepositoryIdentity)
      ) {
        return;
      }
      storedRepositoryIdentity = identity;
      pi.appendEntry(REPOSITORY_IDENTITY_ENTRY, identity);
    } catch {
      // A restored identity can still recover a session whose cwd is gone.
    }
  }

  function emitCommandMessage(
    ctx: ExtensionCommandContext,
    message: string,
    level: "info" | "warning" | "error",
  ): void {
    if (ctx.mode === "print") {
      process.stdout.write(`${message}\n`);
      return;
    }
    if (ctx.mode === "json") {
      pi.sendMessage({
        customType: "pi-worktrunk-command",
        content: message,
        display: true,
        details: { level },
      });
      return;
    }
    ctx.ui.notify(message, level);
  }

  function emitCommandError(
    ctx: ExtensionCommandContext,
    error: unknown,
  ): void {
    emitCommandMessage(
      ctx,
      error instanceof Error ? error.message : String(error),
      "error",
    );
  }

  async function safeList(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<WorktreeItem[]> {
    try {
      return await client.list(cwd, signal);
    } catch {
      return [];
    }
  }

  async function locationForTarget(
    item: WorktreeItem,
  ): Promise<SessionLocation> {
    const path = item.worktree?.path;
    if (!path) throw new WorktrunkError("The target worktree has no path.");
    return worktreeLocation(item, path, await readCommonDir(path));
  }

  async function activateLinkedSession(
    ctx: ExtensionCommandContext,
    source: SessionLocation,
    target: SessionLocation,
    trail: SessionLocation[],
    kind: "move" | "recovery",
    announcement: string,
  ): Promise<void> {
    await ctx.waitForIdle();
    const destinationSession = createLinkedSession(
      ctx,
      source,
      target,
      trail,
      kind,
    );
    const result = await ctx.switchSession(destinationSession, {
      withSession: async (nextCtx) => {
        nextCtx.ui.notify(announcement, "info");
      },
    });
    if (result.cancelled) {
      throw new WorktrunkError(
        `Pi created ${destinationSession}, but session switching was cancelled.`,
      );
    }
  }

  async function launchFork(
    target: SessionLocation,
    destinationSession: string,
  ): Promise<boolean> {
    const command = process.env.PI_WORKTRUNK_FORK_COMMAND?.trim();
    if (!command) return false;
    const shell = process.env.SHELL || "/bin/sh";
    return new Promise((resolve, reject) => {
      const child = spawn(shell, ["-lc", command], {
        cwd: target.path,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          PI_WORKTRUNK_TARGET_CWD: target.path,
          PI_WORKTRUNK_TARGET_SESSION: destinationSession,
        },
      });
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
      child.once("error", reject);
    });
  }

  function mergeTarget(
    invocation: ParsedWtInvocation,
    worktrees: WorktreeItem[],
  ): WorktreeItem | undefined {
    const optionsWithValues = new Set(["--stage"]);
    const delimiter = invocation.commandArgs.indexOf("--");
    const values = delimiter === -1
      ? invocation.commandArgs
      : invocation.commandArgs.slice(0, delimiter);
    let reference: string | undefined;
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (optionsWithValues.has(value)) {
        index += 1;
        continue;
      }
      if (value.startsWith("--stage=") || value.startsWith("-")) continue;
      reference = value;
      break;
    }
    return reference
      ? resolveWorktree(worktrees, reference)
      : worktrees.find((item) => item.worktree?.main);
  }

  async function handleWtCommand(
    input: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    let invocation: ParsedWtInvocation;
    try {
      invocation = parseWtInvocation(input);
    } catch (error) {
      emitCommandError(ctx, error);
      return;
    }

    if (
      (invocation.modifier === "go" || invocation.modifier === "fork") &&
      !ctx.sessionManager.getSessionFile()
    ) {
      emitCommandMessage(
        ctx,
        `${invocation.modifier === "fork" ? "--fork" : "--go"} requires a persisted Pi session.`,
        "error",
      );
      return;
    }

    await ctx.waitForIdle();
    const interactive = ctx.mode !== "print" && ctx.mode !== "json";
    if (isBareCommand(invocation, "list") && interactive && ctx.hasUI) {
      let worktrees: WorktreeItem[];
      try {
        worktrees = await client.list(ctx.cwd, ctx.signal);
      } catch (error) {
        emitCommandError(ctx, error);
        return;
      }
      if (worktrees.length === 0) {
        ctx.ui.notify("No worktrees found.", "info");
        return;
      }
      const selected = await chooseWorktree(
        ctx,
        "Select a worktree to inspect",
        worktrees,
      );
      if (selected) ctx.ui.notify(formatWorktreeStatus(selected), "info");
      return;
    }

    const trail = readSessionTrail(ctx);
    const before = await safeList(ctx.cwd, ctx.signal);
    const sourceItem = itemForPath(before, ctx.cwd) ??
      before.find((item) => item.worktree?.current);
    const source = worktreeLocation(
      sourceItem,
      ctx.cwd,
      storedRepositoryIdentity?.commonDir,
    );

    let selectedTarget: WorktreeItem | undefined;
    const backNavigation =
      invocation.command === "switch" &&
      switchReference(invocation.commandArgs) === "-";
    if (isBareCommand(invocation, "switch") && interactive && ctx.hasUI) {
      selectedTarget = await chooseWorktree(
        ctx,
        "Select a worktree",
        before.filter((item) => item.worktree?.path),
      );
      if (!selectedTarget) return;
    } else if (backNavigation) {
      selectedTarget = backTarget(
        trail,
        before,
        storedRepositoryIdentity?.commonDir,
      );
    }

    const effectiveInvocation = selectedTarget?.worktree?.path
      ? retargetSwitch(invocation, selectedTarget.worktree.path)
      : invocation;
    let commandArgs = effectiveInvocation.args;
    let structuredSwitch = false;
    if (effectiveInvocation.command === "switch") {
      const reference = switchReference(effectiveInvocation.commandArgs);
      if (reference && !hasExecuteFlag(effectiveInvocation.commandArgs)) {
        commandArgs = withStructuredSwitchOutput(effectiveInvocation);
        structuredSwitch = true;
      }
    }

    let result: WtResult;
    try {
      result = await runWt(commandArgs, {
        cwd: ctx.cwd,
        signal: ctx.signal,
        cwdMode: "repository-read",
      });
    } catch (error) {
      result = {
        code: -1,
        stderr: error instanceof Error ? error.message : String(error),
      };
    }

    let structuredTarget: WorktreeItem | undefined;
    let targetCreated = false;
    if (structuredSwitch && result.code === 0) {
      try {
        const switched = parseJson<{
          action?: string;
          branch?: string;
          path?: string;
        }>(result.stdout ?? "", "wt switch --format=json");
        targetCreated = switched.action === "created";
        if (switched.path) {
          structuredTarget = {
            branch: switched.branch ?? null,
            worktree: { path: switched.path },
          };
        }
      } catch (error) {
        result = {
          ...result,
          code: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const output = commandOutput(
      result,
      structuredSwitch && !requestedJsonOutput(invocation.commandArgs),
    );
    if (output) {
      emitCommandMessage(ctx, output, result.code === 0 ? "info" : "error");
    }

    const after = await safeList(ctx.cwd, ctx.signal);
    const currentRemoved = !existsSync(ctx.cwd);
    if (currentRemoved) {
      const explicitTarget =
        structuredTarget?.worktree?.path &&
        existsSync(structuredTarget.worktree.path)
          ? structuredTarget
          : undefined;
      const recovery = explicitTarget
        ? {
            target: explicitTarget,
            trail: survivingTrail(
              trail,
              after,
              explicitTarget.worktree?.path,
            ),
          }
        : recoveryTarget(trail, after);
      if (!recovery.target?.worktree?.path) {
        emitCommandMessage(
          ctx,
          `Pi's worktree was removed and no surviving worktree was found. Restart Pi from a checkout of ${storedRepositoryIdentity?.commonDir ?? "the repository"}.`,
          "error",
        );
        return;
      }
      let target: SessionLocation;
      try {
        target = await locationForTarget(recovery.target);
      } catch (error) {
        emitCommandError(ctx, error);
        return;
      }
      const announcement =
        `Session moved from ${source.branch ?? source.path} to ` +
        `${target.branch ?? target.path} because the current worktree was removed.`;
      if (!interactive) {
        emitCommandMessage(ctx, announcement, "warning");
        return;
      }
      try {
        await activateLinkedSession(
          ctx,
          source,
          target,
          recovery.trail,
          "recovery",
          announcement,
        );
      } catch (error) {
        emitCommandError(ctx, error);
      }
      return;
    }

    if (result.code !== 0 || result.killed || invocation.modifier === "stay") {
      return;
    }

    let targetItem = structuredTarget ?? selectedTarget;
    try {
      if (!targetItem && invocation.command === "switch") {
        const reference = switchReference(invocation.commandArgs);
        if (reference && reference !== "-") {
          targetItem = resolveWorktree(after, reference);
        }
      }
      if (!targetItem && invocation.command === "merge") {
        targetItem = mergeTarget(invocation, after);
      }
      const createdTarget = uniqueCreatedTarget(before, after);
      targetItem ??= createdTarget;
      if (
        createdTarget?.worktree?.path &&
        targetItem?.worktree?.path &&
        canonicalPath(createdTarget.worktree.path) ===
          canonicalPath(targetItem.worktree.path)
      ) {
        targetCreated = true;
      }
    } catch (error) {
      emitCommandError(ctx, error);
      return;
    }

    let action: "go" | "fork" | "stay" = invocation.modifier ?? "stay";
    if (!invocation.modifier) {
      const defaultAction = defaultPlacementAction({
        posture: configuredSessionPosture(),
        interactive,
        persisted: Boolean(ctx.sessionManager.getSessionFile()),
        command: invocation.command,
        targetCreated,
        hasTarget: Boolean(targetItem),
      });
      if (defaultAction === "ask" && targetItem) {
        const label = targetItem.branch ?? targetItem.worktree?.path ?? "target";
        action = await ctx.ui.confirm(
          `Move the Pi session to ${label}?`,
          targetItem.worktree?.path ?? label,
        ) ? "go" : "stay";
      } else {
        action = defaultAction === "ask" ? "stay" : defaultAction;
      }
    }

    if (action === "stay") return;
    if (!targetItem?.worktree?.path) {
      emitCommandMessage(
        ctx,
        "Worktrunk completed, but the command produced no unique target. The Pi session stayed in place.",
        "warning",
      );
      return;
    }

    let target: SessionLocation;
    try {
      target = await locationForTarget(targetItem);
    } catch (error) {
      emitCommandError(ctx, error);
      return;
    }
    const targetsCurrentWorktree =
      canonicalPath(target.path) === canonicalPath(ctx.cwd);
    if (targetsCurrentWorktree && action !== "fork") {
      if (invocation.modifier) {
        emitCommandMessage(
          ctx,
          `The Pi session is already in ${target.branch ?? target.path}.`,
          "info",
        );
      }
      return;
    }

    if (action === "go" && !interactive) {
      emitCommandMessage(
        ctx,
        `Session would move from ${source.branch ?? source.path} to ${target.branch ?? target.path}.`,
        "info",
      );
      return;
    }

    const updatedTrail = targetsCurrentWorktree
      ? [...trail]
      : nextTrail(trail, source, target, backNavigation);
    if (action === "fork") {
      try {
        const destinationSession = createLinkedSession(
          ctx,
          source,
          target,
          updatedTrail,
          "fork",
        );
        let launched = false;
        let launcherError: unknown;
        if (interactive) {
          try {
            launched = await launchFork(target, destinationSession);
          } catch (error) {
            launcherError = error;
          }
        }
        if (launched) {
          emitCommandMessage(
            ctx,
            `Created and launched a second Pi session in ${target.branch ?? target.path}.`,
            "info",
          );
        } else {
          emitCommandMessage(
            ctx,
            [
              ...(launcherError
                ? [`Could not launch the second Pi session: ${
                    launcherError instanceof Error
                      ? launcherError.message
                      : String(launcherError)
                  }`]
                : []),
              `Created a second Pi session in ${target.branch ?? target.path}.`,
              `Run: pi --session ${shellQuote(destinationSession)}`,
            ].join("\n"),
            launcherError ? "warning" : "info",
          );
        }
      } catch (error) {
        emitCommandError(ctx, error);
      }
      return;
    }

    try {
      await activateLinkedSession(
        ctx,
        source,
        target,
        updatedTrail,
        "move",
        `Session moved from ${source.branch ?? source.path} to ${target.branch ?? target.path}.`,
      );
    } catch (error) {
      emitCommandError(ctx, error);
    }
  }

  pi.registerCommand("wt", {
    description: "Run Worktrunk and place the Pi session",
    getArgumentCompletions(argumentPrefix) {
      const prefix = argumentPrefix.trimStart();
      if (/\s/.test(prefix)) return null;
      return [...SUBCOMMANDS, ...worktrunkAliases]
        .filter((command) => command.startsWith(prefix))
        .map((command) => ({ value: command, label: command }));
    },
    handler: handleWtCommand,
  });

  pi.registerTool({
    name: "worktree",
    label: "Worktrunk",
    description:
      `Manage git worktrees through Worktrunk 0.70 or later. Actions: list all worktrees; status for the current worktree; create using \`branch\`; remove a safe non-current worktree using \`target\`; path to resolve \`target\` (or the current worktree); and settings to inspect active configuration. Creating or resolving a worktree does not change Pi's current working directory. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "List, inspect, create, and safely remove Worktrunk worktrees",
    promptGuidelines: [
      "Use the worktree tool when the user asks to inspect or manage Worktrunk worktrees.",
      "Only use the worktree remove action when the user explicitly asks to remove a worktree.",
      "The worktree tool returns target paths but cannot switch Pi's active session; use /wt switch for an interactive session transition.",
    ],
    parameters: Type.Object(
      {
        action: WorktreeActionSchema,
        branch: Type.Optional(
          Type.String({ description: "Branch name for the create action." }),
        ),
        target: Type.Optional(
          Type.String({
            description:
              "Branch name, absolute path, or worktree directory name for remove or path.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      switch (params.action) {
        case "list": {
          const currentDirectoryExists = existsSync(ctx.cwd);
          const worktrees = await client.list(ctx.cwd, signal);
          const display = currentDirectoryExists
            ? await tuiDisplay(ctx.mode, () =>
                client.listText(ctx.cwd, signal),
              )
            : undefined;
          return toolResult(
            "list",
            {
              worktrees,
              currentDirectory: ctx.cwd,
              currentDirectoryExists,
            },
            display,
          );
        }
        case "status": {
          if (!existsSync(ctx.cwd)) {
            throw new WorktrunkError(missingCwdMessage(ctx.cwd));
          }
          const current = await client.status(ctx.cwd, signal);
          if (!current) {
            throw new WorktrunkError(
              "The current directory is not a Worktrunk-managed worktree.",
            );
          }
          return toolResult("status", current, current.display?.statusline);
        }
        case "create": {
          const result = await client.create(
            ctx.cwd,
            requireBranch(params.branch?.trim() ?? ""),
            signal,
          );
          const {
            display,
            branch,
            path,
            createdBranch,
            baseBranch,
          } = result;
          return toolResult(
            "create",
            {
              created: { branch, path, createdBranch, baseBranch },
              currentDirectory: ctx.cwd,
              directoryChanged: false,
            },
            display,
          );
        }
        case "remove": {
          const removal = await removeWithTool(
            client,
            ctx.cwd,
            params.target,
            signal,
          );
          return toolResult(
            "remove",
            { removed: removal.outcomes },
            removal.display,
          );
        }
        case "path": {
          const ref = params.target?.trim();
          if (!ref && !existsSync(ctx.cwd)) {
            throw new WorktrunkError(missingCwdMessage(ctx.cwd));
          }
          const worktrees = await client.list(ctx.cwd, signal);
          const target = ref
            ? resolveWorktree(worktrees, ref)
            : worktrees.find((item) => item.worktree?.current);
          if (!target?.worktree?.path) {
            throw new WorktrunkError(
              ref ? `Worktree not found: ${ref}` : "Current worktree not found.",
            );
          }
          return toolResult(
            "path",
            {
              branch: target.branch,
              path: target.worktree.path,
              currentDirectory: ctx.cwd,
              directoryChanged: false,
            },
            target.worktree.path,
          );
        }
        case "settings": {
          const settings = await client.settings(ctx.cwd, signal);
          const display = await tuiDisplay(ctx.mode, () =>
            client.settingsText(ctx.cwd, signal),
          );
          return toolResult("settings", settings, display);
        }
      }
    },
    renderCall(args, theme) {
      let text =
        theme.fg("toolTitle", theme.bold("Worktrunk")) +
        ` › ${theme.fg("toolTitle", theme.bold(args.action))}`;
      const operand = args.branch ?? args.target;
      if (operand) text += ` ${theme.fg("accent", operand)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result) {
      const details = result.details as ToolOutputDetails | undefined;
      const text = resultText(result);
      return details?.action === "list" || details?.action === "status"
        ? new WorktrunkOutput(text)
        : new Text(text, 0, 0);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await restoreRepositoryIdentity(ctx);
    await discoverAliases(ctx);
    registerWorktrunkAliasTool();
    await tracker.markWaiting(ctx.cwd);
  });
  pi.on("agent_start", (_event, ctx) => tracker.markWorking(ctx.cwd));
  pi.on("agent_end", (_event, ctx) => tracker.markWaiting(ctx.cwd));
  pi.on("session_shutdown", (_event, ctx) => tracker.clear(ctx.cwd));
}
