import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";

import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const MARKERS = { working: "🤖", waiting: "💬" } as const;

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

export type SessionSnapshot = { header: SessionHeader; entries: SessionEntry[] };
type Relation = { ahead?: number; behind?: number };
type WorktreeItem = {
  branch: string | null;
  head?: { short_sha?: string; subject?: string };
  worktree?: {
    path?: string;
    main?: boolean;
    current?: boolean;
    changes?: Record<string, boolean | undefined>;
  };
  default_branch?: Relation;
  upstream?: Relation;
  display?: { state?: string; symbols?: string; statusline?: string };
};
type WorktreeList = { schema: number; items: WorktreeItem[] };
export type WorktrunkAlias = { name: string; steps: string[] };
type SessionLocation = { branch: string | null; path: string; commonDir?: string };
type SessionTransitionKind = "move" | "recovery";
type SessionTransitionDetails = {
  kind: SessionTransitionKind;
  source: SessionLocation;
  target: SessionLocation;
  trail: SessionLocation[];
  sourceSession: string;
  destinationSession: string;
};
type RepositoryIdentity = { commonDir: string; device: number; inode: number };
type Invocation = {
  args: string[];
  command?: string;
  commandIndex?: number;
  commandArgs: string[];
};
type Execution = {
  result: WtResult;
  output: string;
  moved: boolean;
  canContinue: boolean;
};
type PendingContinuation = { key: string; nonce: string; expiresAt: number };

const SESSION_TRANSITION_MESSAGE = "pi-worktrunk";
const LEGACY_SESSION_TRANSITION_MESSAGE = "pi-worktrunk-session-transition";
const CONTINUATION_MESSAGE_TYPE = "pi-worktrunk-continuation";
const MAX_CONTINUATION_OUTPUT = 50_000;
const CONTINUATION_ARG_PREFIX = "__pi_worktrunk_continuation=";
const REPOSITORY_IDENTITY_ENTRY = "pi-worktrunk-repository";
const SUBCOMMANDS = ["switch", "list", "remove", "merge", "step", "hook", "config"] as const;
const WORKTRUNK_ALIAS_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

class WorktrunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktrunkError";
  }
}

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
      if ((await runWt(markerArgs(marker), { cwd })).code !== 0) enabled = false;
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

function sessionFileIsUnwritten(path: string): boolean {
  return !existsSync(path) || statSync(path).size === 0;
}
function serializeSession(snapshot: SessionSnapshot): string {
  return `${[snapshot.header, ...snapshot.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
export function materializeSessionSnapshot(path: string, snapshot: SessionSnapshot): void {
  if (!sessionFileIsUnwritten(path)) return;
  writeFileSync(path, serializeSession(snapshot), {
    encoding: "utf8",
    flag: existsSync(path) ? "w" : "wx",
  });
}
function targetSessionDirectory(manager: ExtensionCommandContext["sessionManager"]): string | undefined {
  const full = manager as typeof manager & { usesDefaultSessionDir?: () => boolean };
  return full.usesDefaultSessionDir?.() ? undefined : manager.getSessionDir();
}
export function forkSessionFromSnapshot(
  sourceSession: string,
  targetCwd: string,
  snapshot?: SessionSnapshot,
  targetSessionDir?: string,
): { destinationSession: string } {
  if (sessionFileIsUnwritten(sourceSession)) {
    if (!snapshot) throw new Error("Cannot copy an unwritten session without a snapshot.");
    materializeSessionSnapshot(sourceSession, snapshot);
  }
  const manager = SessionManager.forkFrom(sourceSession, targetCwd, targetSessionDir);
  const destinationSession = manager.getSessionFile();
  if (!destinationSession) throw new Error("Pi did not create a persisted session copy.");
  return { destinationSession };
}

function parseJson<T>(output: string, command: string): T {
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    throw new WorktrunkError(`Could not parse \`${command}\` output: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function parseWorktreeList(output: string): WorktreeItem[] {
  const result = parseJson<WorktreeList>(output, "wt list --format=json");
  if (result.schema !== 2 || !Array.isArray(result.items)) {
    throw new WorktrunkError("Unexpected `wt list --format=json` output from Worktrunk 0.70 or later.");
  }
  return result.items;
}
function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}
function itemForPath(items: readonly WorktreeItem[], path: string): WorktreeItem | undefined {
  const target = canonicalPath(path);
  return items.find((item) => item.worktree?.path && canonicalPath(item.worktree.path) === target);
}
function resolveWorktree(items: readonly WorktreeItem[], ref: string): WorktreeItem | undefined {
  const matches = items.filter((item) =>
    item.branch === ref || item.worktree?.path === ref ||
    (item.worktree?.path && basename(item.worktree.path) === ref));
  const paths = new Set(matches.flatMap((item) => item.worktree?.path ? [canonicalPath(item.worktree.path)] : []));
  return paths.size === 1 ? matches[0] : undefined;
}
function uniqueCreatedTarget(before: readonly WorktreeItem[], after: readonly WorktreeItem[]): WorktreeItem | undefined {
  const previous = new Set(before.flatMap((item) => item.worktree?.path ? [canonicalPath(item.worktree.path)] : []));
  const created = after.filter((item) => item.worktree?.path && !previous.has(canonicalPath(item.worktree.path)));
  return created.length === 1 ? created[0] : undefined;
}
function worktreeLocation(item: WorktreeItem | undefined, fallback: string, commonDir?: string): SessionLocation {
  return { branch: item?.branch ?? null, path: canonicalPath(item?.worktree?.path ?? fallback), ...(commonDir ? { commonDir } : {}) };
}

function approvalHint(output: string): string {
  return /needs approval|cannot prompt for approval/i.test(output)
    ? "\nReview and approve the project commands in a terminal with `wt config approvals add`, then retry."
    : "";
}
function missingCwdMessage(cwd: string): string {
  return `Pi's working directory no longer exists: ${cwd}. Continue the session from an existing worktree or restart Pi there.`;
}
function formatWtFailure(args: readonly string[], result: WtResult, cwd: string): string {
  const output = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join("\n");
  if (result.killed) return `wt ${args.join(" ")} was cancelled.`;
  if (!existsSync(cwd)) return missingCwdMessage(cwd);
  if (!output || result.code === 127 || /\bENOENT\b/i.test(output)) {
    return "Could not start Worktrunk (`wt`). Install Worktrunk 0.70 or later and ensure it is available on `PATH`.";
  }
  return `wt ${args.join(" ")} failed: ${output}${approvalHint(output)}`;
}

export function createWorktrunkClient(runWt: RunWt) {
  return {
    async list(cwd: string, signal?: AbortSignal): Promise<WorktreeItem[]> {
      const result = await runWt(
        ["--config-set", "list.json-schema=2", "list", "--format=json"],
        { cwd, signal, cwdMode: "repository-read" },
      );
      if (result.code !== 0) throw new WorktrunkError(formatWtFailure(["list"], result, cwd));
      const items = parseWorktreeList(result.stdout ?? "");
      if (result.relocated) for (const item of items) if (item.worktree) item.worktree.current = false;
      return items;
    },
    async settings(cwd: string, signal?: AbortSignal): Promise<string> {
      const result = await runWt(["config", "show", "--format=json"], { cwd, signal, cwdMode: "repository-read" });
      if (result.code !== 0) throw new WorktrunkError(formatWtFailure(["config", "show", "--format=json"], result, cwd));
      return result.stdout?.trim() ?? "";
    },
  };
}

export function parseWorktrunkAliasNames(output: string): string[] {
  const aliases: string[] = [];
  let inAliases = false;
  for (const line of output.split("\n")) {
    if (!inAliases) { if (line.trim() === "Aliases:") inAliases = true; continue; }
    if (!line.trim() || !/^\s/.test(line)) break;
    for (const value of line.split(",")) {
      const name = value.trim();
      if (WORKTRUNK_ALIAS_NAME.test(name) && !aliases.includes(name)) aliases.push(name);
    }
  }
  return aliases;
}
function aliasStepNames(value: unknown): string[] {
  const steps: string[] = [];
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    for (const name of Object.keys(entry)) if (WORKTRUNK_ALIAS_NAME.test(name) && !steps.includes(name)) steps.push(name);
  }
  return steps;
}
export function parseWorktrunkAliasMetadata(names: readonly string[], output: string): WorktrunkAlias[] {
  const aliases = new Map(names.map((name) => [name, { name, steps: [] as string[] }]));
  let config: unknown;
  try { config = JSON.parse(output); } catch { return [...aliases.values()]; }
  if (!config || typeof config !== "object") return [...aliases.values()];
  for (const source of ["user", "project"] as const) {
    const layer = (config as Record<string, any>)[source]?.config?.aliases;
    if (!layer || typeof layer !== "object") continue;
    for (const [name, value] of Object.entries(layer)) {
      const alias = aliases.get(name);
      if (!alias) continue;
      for (const step of aliasStepNames(value)) if (!alias.steps.includes(step)) alias.steps.push(step);
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
    if (escaping) { current += character; started = true; escaping = false; continue; }
    if (character === "\\" && quote !== "'") { escaping = true; started = true; continue; }
    if (quote) { if (character === quote) quote = undefined; else current += character; started = true; continue; }
    if (character === "'" || character === '"') { quote = character; started = true; continue; }
    if (/\s/.test(character)) {
      if (started) { args.push(current); current = ""; started = false; }
      continue;
    }
    current += character; started = true;
  }
  if (escaping) throw new WorktrunkError("Invalid arguments: trailing escape character.");
  if (quote) throw new WorktrunkError("Invalid arguments: unterminated quote.");
  if (started) args.push(current);
  return args;
}
const GLOBAL_OPTIONS_WITH_VALUES = new Set(["-C", "--config", "--config-set"]);

export function parseWtInvocation(input: string): Invocation {
  const args = parseAliasArguments(input);
  let commandIndex: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (GLOBAL_OPTIONS_WITH_VALUES.has(value)) {
      index += 1;
      continue;
    }
    if (
      (value.startsWith("-C") && value !== "-C") ||
      value.startsWith("--config=") ||
      value.startsWith("--config-set=") ||
      value.startsWith("-")
    ) {
      continue;
    }
    commandIndex = index;
    break;
  }
  return {
    args,
    command: commandIndex === undefined ? undefined : args[commandIndex],
    ...(commandIndex === undefined ? {} : { commandIndex }),
    commandArgs: commandIndex === undefined ? [] : args.slice(commandIndex + 1),
  };
}
function quoteArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
function isBareCommand(invocation: Invocation, command: string): boolean {
  return invocation.command === command && invocation.commandArgs.length === 0;
}
function exactSwitchTarget(invocation: Invocation): string | undefined {
  if (invocation.command !== "switch" || invocation.commandArgs.length !== 1) return undefined;
  const value = invocation.commandArgs[0];
  return value.startsWith("-") ? undefined : value;
}
function sensitiveGlobalOption(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--") break;
    if (
      value === "-C" || value.startsWith("-C") ||
      value === "--config" || value.startsWith("--config=") ||
      value === "--config-set" || value.startsWith("--config-set=") ||
      value === "-y" || value === "--yes"
    ) return value;
  }
  return undefined;
}

function relationText(relation?: Relation): string { return `ahead ${relation?.ahead ?? 0}, behind ${relation?.behind ?? 0}`; }
function changeText(item: WorktreeItem): string {
  const changes = item.worktree?.changes ?? {};
  const active = Object.entries(changes).filter(([, value]) => value).map(([name]) => name);
  return active.length ? active.join(", ") : "clean";
}
function formatWorktree(item: WorktreeItem): string {
  const labels = [item.worktree?.current ? "current" : undefined, item.worktree?.main ? "main" : undefined].filter(Boolean);
  return `${item.branch ?? "(detached)"}${labels.length ? ` [${labels.join(", ")}]` : ""}${item.display?.symbols ? ` ${item.display.symbols}` : ""}`;
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
    `HEAD: ${item.head?.short_sha ?? "unknown"}${item.head?.subject ? ` ${item.head.subject}` : ""}`,
  ].join("\n");
}
async function chooseWorktree(ctx: ExtensionCommandContext, title: string, items: WorktreeItem[]): Promise<WorktreeItem | undefined> {
  if (!items.length) return undefined;
  const options = items.map(formatWorktree);
  const selected = await ctx.ui.select(title, options);
  const index = selected === undefined ? -1 : options.indexOf(selected);
  return index < 0 ? undefined : items[index];
}

function readSessionTrail(ctx: ExtensionCommandContext): SessionLocation[] {
  for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
    if (
      entry.type !== "custom_message" ||
      ![SESSION_TRANSITION_MESSAGE, LEGACY_SESSION_TRANSITION_MESSAGE].includes(entry.customType) ||
      !entry.details ||
      typeof entry.details !== "object"
    ) continue;
    const trail = (entry.details as { trail?: unknown }).trail;
    if (Array.isArray(trail)) return trail.filter((value): value is SessionLocation =>
      Boolean(value && typeof value === "object" && typeof value.path === "string" && (typeof value.branch === "string" || value.branch === null)));
  }
  return [];
}
function survivingTrail(trail: readonly SessionLocation[], worktrees: readonly WorktreeItem[]): SessionLocation[] {
  return trail.filter((location) => itemForPath(worktrees, location.path));
}
function recoveryTarget(trail: readonly SessionLocation[], worktrees: readonly WorktreeItem[]): { target?: WorktreeItem; trail: SessionLocation[] } {
  for (let index = trail.length - 1; index >= 0; index -= 1) {
    const target = itemForPath(worktrees, trail[index].path);
    if (target) return { target, trail: trail.slice(0, index) };
  }
  return { target: worktrees.find((item) => item.worktree?.main) ?? worktrees.find((item) => item.worktree?.path), trail: [] };
}
function nextTrail(trail: readonly SessionLocation[], source: SessionLocation): SessionLocation[] {
  return [...trail, source].slice(-32);
}
function createLinkedSession(ctx: ExtensionCommandContext, source: SessionLocation, target: SessionLocation, trail: SessionLocation[], kind: SessionTransitionKind): string {
  const sourceSession = ctx.sessionManager.getSessionFile();
  if (!sourceSession) throw new WorktrunkError("Cannot move an ephemeral Pi session.");
  let snapshot: SessionSnapshot | undefined;
  if (sessionFileIsUnwritten(sourceSession)) {
    const header = ctx.sessionManager.getHeader();
    if (!header) throw new WorktrunkError("The source session has no header.");
    snapshot = { header: structuredClone(header), entries: structuredClone(ctx.sessionManager.getEntries()) };
  }
  const targetSessionDir = targetSessionDirectory(ctx.sessionManager);
  const { destinationSession } = forkSessionFromSnapshot(sourceSession, target.path, snapshot, targetSessionDir);
  const destination = SessionManager.open(destinationSession, targetSessionDir);
  destination.appendCustomMessageEntry(
    SESSION_TRANSITION_MESSAGE,
    "",
    true,
    { kind, source, target, trail, sourceSession, destinationSession } satisfies SessionTransitionDetails,
  );
  return destinationSession;
}

function repositoryIdentity(commonDir: string): RepositoryIdentity | undefined {
  try { const stat = statSync(commonDir); return { commonDir, device: stat.dev, inode: stat.ino }; } catch { return undefined; }
}
function sameRepositoryIdentity(left?: RepositoryIdentity, right?: RepositoryIdentity): boolean {
  return Boolean(left && right && left.commonDir === right.commonDir && left.device === right.device && left.inode === right.inode);
}
function gitWorktreePaths(output: string): string[] {
  return output.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9));
}

export default function extension(pi: ExtensionAPI) {
  const renderTransition: Parameters<ExtensionAPI["registerMessageRenderer"]>[1] =
    (message, { expanded, outputPad }, theme) => {
    const details = message.details as Partial<SessionTransitionDetails> | undefined;
    const recovery = details?.kind === "recovery";
    const source = details?.source;
    const target = details?.target;
    const label = (location: SessionLocation) => location.branch ?? basename(location.path);
    const compactPath = (path: string) => path === homedir() || path.startsWith(`${homedir()}${sep}`) ? `~${path.slice(homedir().length)}` : path;
    let text = theme.fg("accent", theme.bold(`${recovery ? "↩ Session recovered" : "↪ Session moved"}`));
    if (source?.path && target?.path) {
      text += `\n  ${theme.fg("muted", label(source))} ${theme.fg("dim", "→")} ${theme.fg("accent", theme.bold(label(target)))}`;
      if (expanded) text += `\n\n  ${theme.fg("dim", "From")}  ${compactPath(source.path)}\n  ${theme.fg("dim", "To")}    ${compactPath(target.path)}`;
    }
    return new Text(text, outputPad, 0);
  };
  pi.registerMessageRenderer?.(SESSION_TRANSITION_MESSAGE, renderTransition);
  pi.registerMessageRenderer?.(LEGACY_SESSION_TRANSITION_MESSAGE, renderTransition);

  const execWt: RunWt = (args, options) => pi.exec("wt", args, options);
  let storedRepositoryIdentity: RepositoryIdentity | undefined;
  let aliases: WorktrunkAlias[] = [];
  let pendingContinuation: PendingContinuation | undefined;
  let placementInFlight = false;
  const aliasNames = new Set<string>();

  async function readCommonDir(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!existsSync(cwd)) return undefined;
    const result = await pi.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, signal });
    return result.code === 0 && result.stdout.trim() ? resolve(cwd, result.stdout.trim()) : undefined;
  }
  async function findRepositoryWorktree(signal?: AbortSignal): Promise<string | undefined> {
    const identity = storedRepositoryIdentity;
    if (!identity || !sameRepositoryIdentity(identity, repositoryIdentity(identity.commonDir))) return undefined;
    const result = await pi.exec("git", ["--git-dir", identity.commonDir, "worktree", "list", "--porcelain", "-z"], { cwd: dirname(identity.commonDir), signal });
    if (result.code !== 0) return undefined;
    for (const path of gitWorktreePaths(result.stdout)) {
      if (existsSync(path) && (await readCommonDir(path, signal)) === identity.commonDir) return path;
    }
    return undefined;
  }
  const runWt: RunWt = async (args, options) => {
    const { cwdMode, ...execOptions } = options ?? {};
    if (!execOptions.cwd || existsSync(execOptions.cwd) || cwdMode !== "repository-read") return execWt(args, execOptions);
    const fallback = await findRepositoryWorktree(execOptions.signal);
    if (!fallback) return execWt(args, execOptions);
    return { ...(await execWt(args, { ...execOptions, cwd: fallback })), relocated: true };
  };
  const client = createWorktrunkClient(runWt);
  const tracker = createMarkerUpdater(execWt);

  async function safeList(cwd: string, signal?: AbortSignal): Promise<WorktreeItem[]> {
    try { return await client.list(cwd, signal); } catch { return []; }
  }
  async function restoreRepositoryIdentity(ctx: ExtensionContext) {
    const stored = [...ctx.sessionManager.getEntries()].reverse().find((entry) => entry.type === "custom" && entry.customType === REPOSITORY_IDENTITY_ENTRY);
    if (stored?.type === "custom" && stored.data && typeof stored.data === "object") {
      const value = stored.data as Partial<RepositoryIdentity>;
      if (typeof value.commonDir === "string" && typeof value.device === "number" && typeof value.inode === "number") {
        const identity = value as RepositoryIdentity;
        if (sameRepositoryIdentity(identity, repositoryIdentity(identity.commonDir))) storedRepositoryIdentity = identity;
      }
    }
    try {
      const commonDir = await readCommonDir(ctx.cwd, ctx.signal);
      if (!commonDir) return;
      const identity = repositoryIdentity(commonDir);
      if (!identity || sameRepositoryIdentity(identity, storedRepositoryIdentity)) return;
      storedRepositoryIdentity = identity;
      pi.appendEntry(REPOSITORY_IDENTITY_ENTRY, identity);
    } catch {}
  }
  async function discoverAliases(ctx: ExtensionContext) {
    aliases = [];
    aliasNames.clear();
    let help: WtResult;
    try { help = await runWt(["--help"], { cwd: ctx.cwd, cwdMode: "repository-read" }); } catch { return; }
    if (help.code !== 0) return;
    for (const name of parseWorktrunkAliasNames(help.stdout ?? "")) aliasNames.add(name);
    aliases = [...aliasNames].map((name) => ({ name, steps: [] }));
    if (!aliases.length) return;
    try { aliases = parseWorktrunkAliasMetadata([...aliasNames], await client.settings(ctx.cwd, ctx.signal)); } catch {}
  }
  function emit(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error") {
    if (ctx.mode === "print") process.stdout.write(`${message}\n`);
    else if (ctx.mode === "json") pi.sendMessage({ customType: "pi-worktrunk-command", content: message, display: true, details: { level } });
    else ctx.ui.notify(message, level);
  }
  async function locationFor(item: WorktreeItem, signal?: AbortSignal): Promise<SessionLocation> {
    if (!item.worktree?.path) throw new WorktrunkError("The target worktree has no path.");
    return worktreeLocation(item, item.worktree.path, await readCommonDir(item.worktree.path, signal));
  }
  function continuationMessage(invocation: Invocation, execution: Execution) {
    const status = execution.result.code === 0 && !execution.result.killed
      ? "completed successfully"
      : "failed";
    const output = execution.output
      ? execution.output.slice(0, MAX_CONTINUATION_OUTPUT)
      : "(no output)";
    return {
      customType: CONTINUATION_MESSAGE_TYPE,
      content:
        `Worktrunk invocation \`wt ${invocation.args.join(" ")}\` ${status} ` +
        `(exit ${execution.result.code}).\n\n${output}\n\n` +
        "Continue the original task in this worktree. Do not repeat the Worktrunk invocation.",
      display: false,
    } as const;
  }
  async function activate(
    ctx: ExtensionCommandContext,
    source: SessionLocation,
    target: SessionLocation,
    trail: SessionLocation[],
    kind: SessionTransitionKind,
    continuation?: ReturnType<typeof continuationMessage>,
  ) {
    const destinationSession = createLinkedSession(ctx, source, target, trail, kind);
    const result = await ctx.switchSession(destinationSession, {
      withSession: async (nextCtx) => {
        nextCtx.ui.notify(`Session ${kind === "recovery" ? "recovered" : "moved"} from ${source.branch ?? source.path} to ${target.branch ?? target.path}.`, "info");
        if (continuation) {
          await nextCtx.sendMessage(continuation, { triggerTurn: true });
        }
      },
    });
    if (result.cancelled) throw new WorktrunkError(`Pi created ${destinationSession}, but session switching was cancelled.`);
  }

  async function executeInvocation(invocation: Invocation, ctx: ExtensionCommandContext, modelOrigin = false): Promise<Execution> {
    await ctx.waitForIdle();
    const interactive = ctx.mode !== "print" && ctx.mode !== "json";
    if (!modelOrigin && isBareCommand(invocation, "list") && interactive && ctx.hasUI) {
      const worktrees = await client.list(ctx.cwd, ctx.signal);
      if (!worktrees.length) ctx.ui.notify("No worktrees found.", "info");
      else {
        const selected = await chooseWorktree(ctx, "Select a worktree to inspect", worktrees);
        if (selected) ctx.ui.notify(formatWorktreeStatus(selected), "info");
      }
      return { result: { code: 0 }, output: "", moved: false, canContinue: true };
    }

    const trail = readSessionTrail(ctx);
    const before = await safeList(ctx.cwd, ctx.signal);
    const sourceItem = itemForPath(before, ctx.cwd) ?? before.find((item) => item.worktree?.current);
    const source = worktreeLocation(sourceItem, ctx.cwd, storedRepositoryIdentity?.commonDir);
    let args = invocation.args;
    let selected: WorktreeItem | undefined;
    if (!modelOrigin && isBareCommand(invocation, "switch") && interactive && ctx.hasUI) {
      selected = await chooseWorktree(ctx, "Select a worktree", before.filter((item) => item.worktree?.path));
      if (!selected?.worktree?.path) {
        return { result: { code: 0 }, output: "", moved: false, canContinue: true };
      }
      args = ["switch", selected.worktree.path];
    }

    let result: WtResult;
    try { result = await runWt(args, { cwd: ctx.cwd, signal: ctx.signal, cwdMode: "repository-read" }); }
    catch (error) { result = { code: -1, stderr: error instanceof Error ? error.message : String(error) }; }
    const output = [result.stdout?.trimEnd(), result.stderr?.trimEnd()].filter(Boolean).join("\n");
    if (output) emit(ctx, output, result.code === 0 ? "info" : "error");
    const base: Execution = { result, output, moved: false, canContinue: existsSync(ctx.cwd) };
    const continuation = modelOrigin ? continuationMessage(invocation, base) : undefined;

    const after = await safeList(ctx.cwd, ctx.signal);
    if (!existsSync(ctx.cwd)) {
      const recovery = recoveryTarget(trail, after);
      if (!recovery.target?.worktree?.path) {
        emit(ctx, "Pi's worktree was removed and no surviving worktree was found.", "error");
        return { ...base, canContinue: false };
      }
      if (!interactive || !ctx.sessionManager.getSessionFile()) {
        emit(ctx, `The current worktree was removed. Continue from ${recovery.target.worktree.path}.`, "warning");
        return { ...base, canContinue: false };
      }
      try {
        await activate(
          ctx,
          source,
          await locationFor(recovery.target, ctx.signal),
          recovery.trail,
          "recovery",
          continuation,
        );
        return { ...base, moved: true, canContinue: true };
      } catch (error) {
        emit(ctx, error instanceof Error ? error.message : String(error), "error");
        return { ...base, canContinue: false };
      }
    }
    if (result.code !== 0 || result.killed) return base;

    let target = selected ?? uniqueCreatedTarget(before, after);
    if (!target) {
      const exact = exactSwitchTarget(invocation);
      if (exact) target = resolveWorktree(after, exact);
    }
    if (!target?.worktree?.path) return base;
    if (canonicalPath(target.worktree.path) === canonicalPath(ctx.cwd)) return base;
    if (!interactive || !ctx.sessionManager.getSessionFile()) return base;
    try {
      await activate(
        ctx,
        source,
        await locationFor(target, ctx.signal),
        nextTrail(survivingTrail(trail, after), source),
        "move",
        continuation,
      );
      return { ...base, moved: true };
    } catch (error) {
      emit(ctx, error instanceof Error ? error.message : String(error), "error");
      return base;
    }
  }

  pi.registerCommand("wt", {
    description: "Run Worktrunk",
    getArgumentCompletions(prefix) {
      const value = prefix.trimStart();
      if (/\s/.test(value)) return null;
      return [...SUBCOMMANDS, ...aliasNames].filter((name) => name.startsWith(value)).map((name) => ({ value: name, label: name }));
    },
    async handler(input, ctx) {
      let modelOrigin = false;
      try {
        const received = parseWtInvocation(input);
        const marker = received.args.at(-1);
        const nonce = marker?.startsWith(CONTINUATION_ARG_PREFIX)
          ? marker.slice(CONTINUATION_ARG_PREFIX.length)
          : undefined;
        const args = nonce ? received.args.slice(0, -1) : received.args;
        const invocation = parseWtInvocation(args.map(quoteArgument).join(" "));
        const key = JSON.stringify(invocation.args);
        if (
          nonce &&
          pendingContinuation?.nonce === nonce &&
          pendingContinuation.expiresAt <= Date.now()
        ) {
          pendingContinuation = undefined;
          placementInFlight = false;
        }
        modelOrigin = Boolean(
          nonce &&
          pendingContinuation &&
          pendingContinuation.expiresAt > Date.now() &&
          pendingContinuation.nonce === nonce &&
          pendingContinuation.key === key,
        );
        if (nonce && !modelOrigin) {
          throw new WorktrunkError("Invalid or expired model continuation token.");
        }
        if (modelOrigin) pendingContinuation = undefined;
        const execution = await executeInvocation(invocation, ctx, modelOrigin);
        if (modelOrigin && !execution.moved && execution.canContinue) {
          pi.sendMessage(continuationMessage(invocation, execution), { triggerTurn: true });
        }
      } catch (error) {
        emit(ctx, error instanceof Error ? error.message : String(error), "error");
      } finally {
        if (modelOrigin) placementInFlight = false;
      }
    },
  });

  function registerTool() {
    const catalog = aliases.length
      ? `\n\nConfigured aliases:\n${aliases.map(({ name, steps }) => `- ${name}: ${steps.length ? steps.join(" -> ") : "no pipeline metadata available"}`).join("\n")}`
      : "";
    pi.registerTool({
      name: "worktrunk",
      label: "Worktrunk",
      description: `Run a Worktrunk command. Arguments pass directly to wt without shell expansion. Commands that identify one destination move the Pi session there.${catalog}`,
      promptSnippet: "Run Worktrunk commands and continue in a uniquely identified destination worktree",
      promptGuidelines: [
        "Use worktrunk for Worktrunk commands. Pass the exact wt arguments without a leading wt.",
        "The worktrunk tool moves the session automatically when Worktrunk identifies one destination.",
      ],
      parameters: Type.Object({ args: Type.Array(Type.String(), { minItems: 1 }) }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_id, params, _signal, _update, ctx) {
        const args = [...params.args];
        const invocation = parseWtInvocation(args.map(quoteArgument).join(" "));
        if (isBareCommand(invocation, "switch")) {
          throw new WorktrunkError("The worktrunk tool requires an explicit target for `wt switch`.");
        }
        if (pendingContinuation && pendingContinuation.expiresAt <= Date.now()) {
          pendingContinuation = undefined;
          placementInFlight = false;
        }
        if (placementInFlight) {
          throw new WorktrunkError("Another model-triggered Worktrunk invocation is still pending.");
        }

        const alias = invocation.command;
        const sensitive = sensitiveGlobalOption(args);
        const unknown = alias !== undefined &&
          !SUBCOMMANDS.includes(alias as (typeof SUBCOMMANDS)[number]) &&
          !aliasNames.has(alias);
        const requiresConfirmation = Boolean(
          (alias && aliasNames.has(alias)) || sensitive || unknown,
        );
        if (requiresConfirmation) {
          if (!ctx.hasUI) {
            throw new WorktrunkError("This Worktrunk invocation requires interactive or RPC mode so the user can confirm the exact command.");
          }
          const metadata = aliases.find((candidate) => candidate.name === alias);
          const reason = metadata
            ? `Configured alias: ${alias}`
            : sensitive
              ? `Sensitive global option: ${sensitive}`
              : `Unrecognized command: ${alias}`;
          const confirmed = await ctx.ui.confirm(
            "Run Worktrunk command?",
            [
              `Command: wt ${args.map(quoteArgument).join(" ")}`,
              reason,
              ...(metadata?.steps.length ? [`Pipeline: ${metadata.steps.join(" -> ")}`] : []),
              "",
              "This command may perform destructive or external actions.",
            ].join("\n"),
          );
          if (!confirmed) {
            return {
              content: [{ type: "text" as const, text: `Cancelled wt ${args.join(" ")}.` }],
              details: { args, cancelled: true },
              terminate: true,
            };
          }
        }
        const nonce = randomUUID();
        placementInFlight = true;
        pendingContinuation = {
          key: JSON.stringify(args),
          nonce,
          expiresAt: Date.now() + 5 * 60_000,
        };
        const marker = `${CONTINUATION_ARG_PREFIX}${nonce}`;
        pi.sendUserMessage(
          `/wt ${[...args, marker].map(quoteArgument).join(" ")}`,
          { deliverAs: "followUp", expandPromptTemplates: true },
        );
        return {
          content: [{ type: "text" as const, text: `Queued wt ${args.join(" ")}. Worktrunk will run after this turn, and the result will be returned before work continues.` }],
          details: { args },
          terminate: true,
        };
      },
      renderCall(args, theme) {
        let text = theme.fg("toolTitle", theme.bold("Worktrunk"));
        if (args.args?.length) text += ` ${theme.fg("accent", args.args.join(" "))}`;
        return new Text(text, 0, 0);
      },
      renderResult(result) {
        const text = result.content.find((item) => item.type === "text")?.text ?? "";
        return new Text(text, 0, 0);
      },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    await restoreRepositoryIdentity(ctx);
    await discoverAliases(ctx);
    registerTool();
    await tracker.markWaiting(ctx.cwd);
  });
  pi.on("agent_start", (_event, ctx) => tracker.markWorking(ctx.cwd));
  pi.on("agent_end", (_event, ctx) => tracker.markWaiting(ctx.cwd));
  pi.on("session_shutdown", (_event, ctx) => tracker.clear(ctx.cwd));
}
