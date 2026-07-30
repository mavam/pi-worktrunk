import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
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
};

type RunWtOptions = {
  cwd?: string;
  signal?: AbortSignal;
};

type RunWt = (args: string[], options?: RunWtOptions) => Promise<WtResult>;

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
  };
};

type WorktreeList = {
  schema: number;
  items: WorktreeItem[];
};

type RemovalOutcome = {
  branch: string | null;
  path: string;
  branch_deleted: boolean;
};

export function markerArgs(marker?: string): string[] {
  return marker === undefined
    ? ["config", "state", "marker", "clear"]
    : ["config", "state", "marker", "set", marker];
}

export function createMarkerUpdater(runWt: RunWt) {
  let enabled = true;

  async function update(marker?: string, cwd?: string): Promise<void> {
    if (!enabled) return;

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

function formatWtFailure(args: string[], result: WtResult): string {
  const output = [result.stderr?.trim(), result.stdout?.trim()]
    .filter(Boolean)
    .join("\n");

  if (result.killed) return `wt ${args.join(" ")} was cancelled.`;
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
  ): Promise<WtResult> {
    let result: WtResult;
    try {
      result = await runWt(args, { cwd, signal });
    } catch (error) {
      throw new WorktrunkError(
        `Could not execute Worktrunk: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (result.code !== 0) {
      throw new WorktrunkError(formatWtFailure(args, result));
    }
    return result;
  }

  async function list(cwd: string, signal?: AbortSignal) {
    const result = await run(
      ["--config-set", "list.json-schema=2", "list", "--format=json"],
      cwd,
      signal,
    );
    return parseWorktreeList(result.stdout ?? "");
  }

  return {
    list,

    async status(cwd: string, signal?: AbortSignal) {
      return (await list(cwd, signal)).find(
        (item) => item.worktree?.current === true,
      );
    },

    async create(cwd: string, branch: string, signal?: AbortSignal) {
      const result = await run(
        ["switch", "--create", "--no-cd", "--format=json", branch],
        cwd,
        signal,
      );
      const created = parseJson<{ branch?: string; path?: string }>(
        result.stdout ?? "",
        "wt switch --format=json",
      );
      if (!created.path) {
        throw new WorktrunkError(
          `Worktrunk created ${branch}, but did not report its path.`,
        );
      }
      return { branch: created.branch ?? branch, path: created.path };
    },

    async remove(cwd: string, ref: string, signal?: AbortSignal) {
      const result = await run(
        ["remove", "--foreground", "--format=json", ref],
        cwd,
        signal,
      );
      return parseJson<RemovalOutcome[]>(
        result.stdout ?? "",
        "wt remove --format=json",
      );
    },

    async settings(cwd: string, signal?: AbortSignal) {
      const result = await run(
        ["config", "show", "--format=json"],
        cwd,
        signal,
      );
      return result.stdout?.trim() ?? "";
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
  return `${item.branch ?? "(detached)"}${suffix}${symbols}\n  ${
    item.worktree?.path ?? "(no worktree path)"
  }`;
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

const HELP_TEXT = `
/worktree - Manage worktrees with Worktrunk

Commands:
  /worktree list                 Select and inspect a worktree
  /worktree create <branch>      Create a branch and worktree
  /worktree remove [target]      Remove a worktree and any safe-to-delete branch
  /worktree status               Show the current worktree
  /worktree cd [target]          Show a worktree path
  /worktree settings             Show the active Worktrunk configuration
`.trim();

const SUBCOMMANDS = [
  "list",
  "create",
  "remove",
  "status",
  "cd",
  "settings",
  "help",
] as const;

function splitCommand(input: string): { command: string; args: string } {
  const trimmed = input.trim();
  if (!trimmed) return { command: "help", args: "" };
  const separator = trimmed.search(/\s/);
  return separator === -1
    ? { command: trimmed, args: "" }
    : {
        command: trimmed.slice(0, separator),
        args: trimmed.slice(separator).trim(),
      };
}

function requireNoArgs(args: string, usage: string): void {
  if (args) throw new WorktrunkError(`Usage: ${usage}`);
}

function requireBranch(args: string): string {
  if (!args || /\s/.test(args) || args.startsWith("-")) {
    throw new WorktrunkError("Usage: /worktree create <branch>");
  }
  return args;
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

async function commandList(
  args: string,
  ctx: ExtensionCommandContext,
  client: WorktrunkClient,
): Promise<void> {
  requireNoArgs(args, "/worktree list");
  const worktrees = await client.list(ctx.cwd);
  if (worktrees.length === 0) {
    ctx.ui.notify("No worktrees found.", "info");
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify(worktrees.map(formatWorktree).join("\n\n"), "info");
    return;
  }
  const selected = await chooseWorktree(
    ctx,
    "Select a worktree to inspect",
    worktrees,
  );
  if (selected) ctx.ui.notify(formatWorktreeStatus(selected), "info");
}

async function commandCreate(
  args: string,
  ctx: ExtensionCommandContext,
  client: WorktrunkClient,
): Promise<void> {
  const created = await client.create(ctx.cwd, requireBranch(args));
  ctx.ui.notify(
    `Created ${created.branch}.\nPath: ${created.path}\nPi remains in ${ctx.cwd}.`,
    "info",
  );
}

async function commandRemove(
  args: string,
  ctx: ExtensionCommandContext,
  client: WorktrunkClient,
): Promise<void> {
  const worktrees = await client.list(ctx.cwd);
  const target = args
    ? resolveWorktree(worktrees, args)
    : ctx.hasUI
      ? await chooseWorktree(
          ctx,
          "Select a worktree to remove",
          worktrees.filter(
            (item) => !item.worktree?.current && !item.worktree?.main,
          ),
        )
      : undefined;

  if (!target) {
    if (!args && !ctx.hasUI) {
      throw new WorktrunkError("Usage: /worktree remove <branch-or-path>");
    }
    if (args) throw new WorktrunkError(`Worktree not found: ${args}`);
    return;
  }

  const ref = removableRef(target);
  if (
    ctx.hasUI &&
    !(await ctx.ui.confirm(
      "Remove worktree?",
      `${target.branch ?? "(detached)"}\n${target.worktree?.path ?? "(no path)"}\n\nWorktrunk refuses dirty worktrees and retains branches that are not safe to delete.`,
    ))
  ) {
    return;
  }

  const [outcome] = await client.remove(ctx.cwd, ref);
  const label = target.branch ?? outcome?.path ?? ref;
  ctx.ui.notify(
    outcome?.branch && !outcome.branch_deleted
      ? `Removed the worktree for ${label}. Worktrunk retained branch ${outcome.branch}.`
      : outcome?.branch_deleted
        ? `Removed the worktree and branch ${label}.`
        : `Removed worktree ${label}.`,
    "info",
  );
}

async function commandStatus(
  args: string,
  ctx: ExtensionCommandContext,
  client: WorktrunkClient,
): Promise<void> {
  requireNoArgs(args, "/worktree status");
  const current = await client.status(ctx.cwd);
  if (!current) {
    throw new WorktrunkError(
      "The current directory is not a Worktrunk-managed worktree.",
    );
  }
  ctx.ui.notify(formatWorktreeStatus(current), "info");
}

async function commandPath(
  args: string,
  ctx: ExtensionCommandContext,
  client: WorktrunkClient,
): Promise<void> {
  const worktrees = await client.list(ctx.cwd);
  const target = args
    ? resolveWorktree(worktrees, args)
    : worktrees.find((item) => item.worktree?.current);
  if (!target?.worktree?.path) {
    throw new WorktrunkError(
      args ? `Worktree not found: ${args}` : "Current worktree not found.",
    );
  }
  ctx.ui.notify(target.worktree.path, "info");
}

async function commandSettings(
  args: string,
  ctx: ExtensionCommandContext,
  client: WorktrunkClient,
): Promise<void> {
  requireNoArgs(args, "/worktree settings");
  const settings = await client.settings(ctx.cwd);
  ctx.ui.notify(settings || "No Worktrunk configuration found.", "info");
}

export async function handleWorktreeCommand(
  input: string,
  ctx: ExtensionCommandContext,
  client: WorktrunkClient,
): Promise<void> {
  const { command: rawCommand, args } = splitCommand(input);
  const command =
    rawCommand === "ls"
      ? "list"
      : rawCommand === "rm"
        ? "remove"
        : rawCommand === "config"
          ? "settings"
          : rawCommand;

  try {
    switch (command) {
      case "help":
        ctx.ui.notify(HELP_TEXT, "info");
        return;
      case "list":
        await commandList(args, ctx, client);
        return;
      case "create":
        await commandCreate(args, ctx, client);
        return;
      case "remove":
        await commandRemove(args, ctx, client);
        return;
      case "status":
        await commandStatus(args, ctx, client);
        return;
      case "cd":
        await commandPath(args, ctx, client);
        return;
      case "settings":
        await commandSettings(args, ctx, client);
        return;
      default:
        ctx.ui.notify(
          `Unknown worktree command: ${rawCommand}\n\n${HELP_TEXT}`,
          "error",
        );
    }
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
  }
}

async function formatToolOutput(action: WorktreeAction, output: string) {
  const text = output || "(no output)";
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) {
    return { text, details: { action, truncated: false } };
  }

  const directory = await mkdtemp(join(tmpdir(), "pi-worktrunk-"));
  const fullOutputPath = join(directory, `${action}.txt`);
  await writeFile(fullOutputPath, text, "utf8");
  const notice =
    `\n\n[Output truncated to ${DEFAULT_MAX_LINES} lines or ` +
    `${formatSize(DEFAULT_MAX_BYTES)}. Full output: ${fullOutputPath}]`;
  return {
    text: truncation.content + notice,
    details: { action, truncated: true, fullOutputPath },
  };
}

async function toolResult(action: WorktreeAction, value: unknown) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const output = await formatToolOutput(action, text);
  return {
    content: [{ type: "text" as const, text: output.text }],
    details: output.details,
  };
}

async function removeWithTool(
  client: WorktrunkClient,
  cwd: string,
  targetRef: string | undefined,
  signal?: AbortSignal,
): Promise<RemovalOutcome[]> {
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

export default function (pi: ExtensionAPI) {
  const runWt: RunWt = (args, options) => pi.exec("wt", args, options);
  const tracker = createMarkerUpdater(runWt);
  const client = createWorktrunkClient(runWt);

  pi.registerCommand("worktree", {
    description: "Manage git worktrees with Worktrunk",
    getArgumentCompletions(argumentPrefix) {
      const prefix = argumentPrefix.trimStart();
      if (/\s/.test(prefix)) return null;
      return SUBCOMMANDS.filter((command) => command.startsWith(prefix)).map(
        (command) => ({ value: command, label: command }),
      );
    },
    handler: (args, ctx) => handleWorktreeCommand(args, ctx, client),
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
      "The worktree tool returns target paths but cannot change Pi's current working directory.",
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
        case "list":
          return toolResult("list", {
            worktrees: await client.list(ctx.cwd, signal),
          });
        case "status": {
          const current = await client.status(ctx.cwd, signal);
          if (!current) {
            throw new WorktrunkError(
              "The current directory is not a Worktrunk-managed worktree.",
            );
          }
          return toolResult("status", current);
        }
        case "create": {
          const created = await client.create(
            ctx.cwd,
            requireBranch(params.branch?.trim() ?? ""),
            signal,
          );
          return toolResult("create", {
            created,
            currentDirectory: ctx.cwd,
            directoryChanged: false,
          });
        }
        case "remove":
          return toolResult("remove", {
            removed: await removeWithTool(
              client,
              ctx.cwd,
              params.target,
              signal,
            ),
          });
        case "path": {
          const worktrees = await client.list(ctx.cwd, signal);
          const ref = params.target?.trim();
          const target = ref
            ? resolveWorktree(worktrees, ref)
            : worktrees.find((item) => item.worktree?.current);
          if (!target?.worktree?.path) {
            throw new WorktrunkError(
              ref ? `Worktree not found: ${ref}` : "Current worktree not found.",
            );
          }
          return toolResult("path", {
            branch: target.branch,
            path: target.worktree.path,
            currentDirectory: ctx.cwd,
            directoryChanged: false,
          });
        }
        case "settings":
          return toolResult(
            "settings",
            await client.settings(ctx.cwd, signal),
          );
      }
    },
  });

  pi.on("session_start", (_event, ctx) => tracker.markWaiting(ctx.cwd));
  pi.on("agent_start", (_event, ctx) => tracker.markWorking(ctx.cwd));
  pi.on("agent_end", (_event, ctx) => tracker.markWaiting(ctx.cwd));
  pi.on("session_shutdown", (_event, ctx) => tracker.clear(ctx.cwd));
}
