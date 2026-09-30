import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve, join, isAbsolute } from "node:path";

import {
  SessionManager,
  keyText,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
  type SessionHeader,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const MARKERS = { working: "🤖", waiting: "💬" } as const;

type WtResult = {
  stdout?: string;
  stderr?: string;
  code: number;
  killed?: boolean;
  directive?: string;
};
type RunWtOptions = {
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
};
type RunWt = (args: string[], options?: RunWtOptions) => Promise<WtResult>;

/** The same one-invocation reply channel used by Worktrunk's shell wrappers. */
export async function runDirectedWt(args: string[], options: RunWtOptions = {}, command = "wt"): Promise<WtResult> {
  const directory = await mkdtemp(join(tmpdir(), "pi-worktrunk-"));
  const file = join(directory, "cd");
  try {
    await writeFile(file, "", { mode: 0o600 });
    const result = await new Promise<WtResult>((resolveResult) => {
      if (options.signal?.aborted) {
        resolveResult({ code: -1, killed: true });
        return;
      }
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          WORKTRUNK_DIRECTIVE_CD_FILE: file,
          // Pi is the caller, not a shell that may have launched Pi elsewhere.
          WORKTRUNK_SHELL_CWD: options.cwd ?? process.cwd(),
          PWD: options.cwd ?? process.cwd(),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "", killed = false, settled = false, exited = false;
      let exitCode: number | null = null;
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      let drain: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        if (killed || exited) return;
        killed = true;
        child.kill("SIGTERM");
        forceKill = setTimeout(() => child.kill("SIGKILL"), 5000);
      };
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(forceKill);
        clearTimeout(drain);
        options.signal?.removeEventListener("abort", cancel);
        child.stdout.destroy();
        child.stderr.destroy();
        resolveResult({ stdout, stderr, code: code ?? -1, killed });
      };
      // Detached hooks may retain the output pipes. After exit, drain until idle
      // rather than waiting forever for their handles to close (as Pi does).
      const drainAfterExit = () => {
        if (!exited || settled) return;
        clearTimeout(drain);
        drain = setTimeout(() => finish(exitCode), 100);
      };
      child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; drainAfterExit(); });
      child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; drainAfterExit(); });
      child.on("error", (error) => { stderr += error.message; finish(-1); });
      options.signal?.addEventListener("abort", cancel, { once: true });
      const timer = options.timeout && options.timeout > 0 ? setTimeout(cancel, options.timeout) : undefined;
      child.on("exit", (code) => { exited = true; exitCode = code; clearTimeout(forceKill); drainAfterExit(); });
      child.on("close", finish);
      if (options.signal?.aborted) cancel();
    });
    return { ...result, directive: await readFile(file, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function parseDirectoryDirective(raw: string): string | undefined {
  if (!raw) return undefined;
  const path = raw.replace(/\r?\n$/, "");
  if (!isAbsolute(path) || /[\r\n\0]/.test(path)) {
    throw new Error(`Rejected Worktrunk destination: ${JSON.stringify(raw)}`);
  }
  return path;
}

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
export type WorktrunkCommand = { name: string; description: string };
export type ReferenceEntry = { syntax: string; description: string };
export type CommandReference = {
  path: string[];
  summary: string;
  usage: string;
  arguments: ReferenceEntry[];
  options: ReferenceEntry[];
  subcommands: ReferenceEntry[];
  examples: string[][];
};
type SessionLocation = { branch: string | null; path: string; commonDir?: string };
type SessionTransitionKind = "move" | "recovery";
type SessionTransitionDetails = {
  kind: SessionTransitionKind;
  source: SessionLocation;
  target: SessionLocation;
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
const WORKTRUNK_ALIAS_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_REFERENCE_BYTES = 30_000;
const MAX_EXAMPLES_PER_COMMAND = 3;
const HELP_DESCRIPTION_INDENT = 10;
const HELP_PROBE_CONCURRENCY = 8;
const HELP_PROBE_TIMEOUT_MS = 10_000;

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

export type ProjectCommand = { phase?: string; name?: string; template: string; approved?: boolean };

const APPROVAL_FAILURE = /needs approval|cannot prompt for approval/i;
const APPROVAL_HINT = "Review and approve the project commands in a terminal with `wt config approvals add`, then retry.";
// Built-in commands that Worktrunk verified to check approvals before any side
// effect, so a failed approval leaves nothing to undo and one retry is safe.
// Aliases and `step for-each` may act before a nested command stops for approval.
const APPROVAL_RETRY_SAFE = new Set(["switch", "remove", "merge", "step", "hook", "list", "config"]);

export function isApprovalFailure(output: string): boolean {
  return APPROVAL_FAILURE.test(output);
}
function approvalHint(output: string): string {
  return isApprovalFailure(output) ? `\n${APPROVAL_HINT}` : "";
}
/** Unapproved entries of `wt config approvals list --format json`. */
export function parsePendingApprovals(output: string): ProjectCommand[] | undefined {
  let state: unknown;
  try { state = JSON.parse(output); } catch { return undefined; }
  const commands = (state as { commands?: unknown } | null)?.commands;
  if (!Array.isArray(commands)) return undefined;
  return commands.filter((command): command is ProjectCommand =>
    Boolean(command) && typeof command.template === "string" && command.approved !== true);
}
export function formatProjectCommands(commands: readonly ProjectCommand[]): string {
  return commands.map(({ phase, name, template }) => [
    `○ ${[phase ?? "command", name].filter(Boolean).join(" ")}:`,
    ...template.split("\n").map((line) => `  ${line}`),
  ].join("\n")).join("\n");
}
function commandKeys(commands: readonly ProjectCommand[]): string {
  return JSON.stringify(commands.map(({ phase, name, template }) => [phase, name, template]).sort());
}
/** The hint (unless already present) and the pending commands for an approval failure. */
export function approvalFailureDetails(output: string, pending?: readonly ProjectCommand[]): string {
  if (!isApprovalFailure(output)) return "";
  return [
    output.includes(APPROVAL_HINT) ? undefined : APPROVAL_HINT,
    pending?.length ? `Unapproved project commands:\n${formatProjectCommands(pending)}` : undefined,
  ].filter(Boolean).join("\n");
}
/** Model-originated flags that would skip the approval the user should see. */
export function bypassesApproval(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "--yes" || arg.startsWith("--yes=") || /^-[A-Za-z]*y[A-Za-z]*$/.test(arg)) return true;
  }
  return false;
}
function missingCwdMessage(cwd: string): string {
  return `Pi's working directory no longer exists: ${cwd}. Continue the session from an existing worktree or restart Pi there.`;
}
function boundedModelOutput(output: string): string {
  return output.length > MAX_CONTINUATION_OUTPUT
    ? `${output.slice(0, MAX_CONTINUATION_OUTPUT)}\n\n[output truncated]`
    : output;
}
function formatWtFailure(args: readonly string[], result: WtResult, cwd: string): string {
  const output = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join("\n");
  if (result.killed) return `wt ${args.join(" ")} was cancelled.`;
  if (!existsSync(cwd)) return missingCwdMessage(cwd);
  if (!output || result.code === 127 || /\bENOENT\b/i.test(output)) {
    return "Could not start Worktrunk (`wt`). Install current Worktrunk and ensure it is available on `PATH`.";
  }
  return `wt ${args.join(" ")} failed: ${output}${approvalHint(output)}`;
}

export function createWorktrunkClient(runWt: RunWt) {
  return {
    async list(cwd: string, signal?: AbortSignal): Promise<WorktreeItem[]> {
      const result = await runWt(
        ["--config-set", "list.json-schema=2", "list", "--format=json"],
        { cwd, signal },
      );
      if (result.code !== 0) throw new WorktrunkError(formatWtFailure(["list"], result, cwd));
      const items = parseWorktreeList(result.stdout ?? "");
      return items;
    },
    async settings(cwd: string, signal?: AbortSignal): Promise<string> {
      const result = await runWt(["config", "show", "--format=json"], { cwd, signal });
      if (result.code !== 0) throw new WorktrunkError(formatWtFailure(["config", "show", "--format=json"], result, cwd));
      return result.stdout?.trim() ?? "";
    },
  };
}

function isEntryStart(value: string, kind: "argument" | "option"): boolean {
  return kind === "option"
    ? /^--?[A-Za-z0-9]/.test(value)
    : /^(?:\[(?!(?:default|possible values):)[^\]]+\]|<[^>]+>)(?:\.{3})?/.test(value);
}

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

export function parseSectionEntries(
  output: string,
  sectionNames: ReadonlySet<string>,
  kind: "argument" | "option",
): ReferenceEntry[] {
  const lines = output.split("\n");
  const entries: ReferenceEntry[] = [];
  let active = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^([A-Za-z][A-Za-z ]+):$/)?.[1];
    if (heading) {
      active = sectionNames.has(heading) || (
        heading !== "Global Options" &&
        sectionNames.has("* Options") &&
        heading.endsWith(" Options")
      );
      continue;
    }
    if (!active) continue;
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) { active = false; continue; }
    const trimmed = line.trim();
    if (indentation(line) >= HELP_DESCRIPTION_INDENT || !isEntryStart(trimmed, kind)) continue;
    const match = trimmed.match(/^(.+?)(?:\s{2,}(.+))?$/);
    if (!match) continue;
    if (kind === "option" && /(?:^|, )-(?:h|-help|V|-version)(?:\s|$)/.test(match[1])) continue;

    const details = match[2] ? [match[2]] : [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next];
      if (!candidate.trim()) continue;
      if (!/^\s/.test(candidate)) break;
      const detail = candidate.trim();
      if (indentation(candidate) < HELP_DESCRIPTION_INDENT && isEntryStart(detail, kind)) break;
      if (!/^[─┌└├┬┼│]/.test(detail)) details.push(detail);
    }
    entries.push({ syntax: match[1], description: details.join(" ") });
  }
  return entries;
}

export function parseCommands(output: string): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [];
  let active = false;
  for (const line of output.split("\n")) {
    if (!active) { if (line.trim() === "Commands:") active = true; continue; }
    if (!line.trim() || !/^\s/.test(line)) break;
    const match = line.match(/^\s+([A-Za-z0-9][A-Za-z0-9_-]*)\s{2,}(.+?)\s*$/);
    if (match) {
      entries.push({ syntax: match[1], description: match[2] });
    } else if (entries.length) {
      entries.at(-1)!.description += ` ${line.trim()}`;
    }
  }
  return entries;
}

export function splitShell(input: string): string[] | undefined {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (escaping) { current += character; escaping = false; continue; }
    if (character === "\\" && quote !== "'") { escaping = true; continue; }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "#" && (index === 0 || /\s/.test(input[index - 1]))) break;
    if (/\s/.test(character)) {
      if (current) { result.push(current); current = ""; }
      continue;
    }
    if ("|;&><`".includes(character)) return undefined;
    current += character;
  }
  if (quote || escaping) return undefined;
  if (current) result.push(current);
  return result;
}

export function parseCommand(
  path: string[],
  output: string,
  fallbackSummary = "",
): CommandReference {
  const firstLine = output.split("\n")[0] ?? "";
  const summary = (
    firstLine.match(/^wt(?:\s+.*?)?\s+-\s+(.+)$/)?.[1]
    ?? (/^wt(?:\s|$)/.test(firstLine) ? "" : firstLine.trim())
  ) || fallbackSummary;
  const usage = output.split("\n").find((line) => line.startsWith("Usage: "))?.slice(7)
    ?? `wt ${path.join(" ")}`.trimEnd();
  return {
    path,
    summary,
    usage,
    arguments: parseSectionEntries(output, new Set(["Arguments"]), "argument"),
    options: parseSectionEntries(output, new Set(["Options", "* Options", "Automation", "Output"]), "option"),
    subcommands: parseCommands(output),
    examples: parseExamples(output),
  };
}

function fencedBlocks(output: string): string[] {
  const lines = output.split("\n");
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index].match(/^(`{3,}|~{3,})[^`~]*$/);
    if (!opening) continue;
    const delimiter = opening[1];
    const body: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      if (lines[index].trim() === delimiter) break;
      body.push(lines[index]);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

export function parseExamples(output: string): string[][] {
  const examples: string[][] = [];
  for (const block of fencedBlocks(output)) {
    for (const line of block.split("\n")) {
      const match = line.match(/^\s*\$\s+wt(?:\s+(.+?))?\s*$/);
      if (!match?.[1]) continue;
      const tokens = splitShell(match[1]);
      if (!tokens?.length) continue;
      const key = JSON.stringify(tokens);
      if (!examples.some((example) => JSON.stringify(example) === key)) examples.push(tokens);
    }
  }
  return examples;
}

function attributeExamples(commands: CommandReference[]): void {
  const examples = commands.flatMap((command) => command.examples);
  for (const command of commands) command.examples = [];
  const candidates = [...commands].sort((left, right) => right.path.length - left.path.length);
  for (const tokens of examples) {
    const command = candidates.find(({ path }) => tokens.some((_, start) =>
      path.every((part, index) => tokens[start + index] === part)));
    if (!command) continue;
    const key = JSON.stringify(tokens);
    if (!command.examples.some((example) => JSON.stringify(example) === key)) {
      command.examples.push(tokens);
    }
  }
}

export function renderToolExample(
  tokens: readonly string[],
  topLevelCommands: ReadonlySet<string>,
): string | undefined {
  const commandIndex = tokens.findIndex((token) => topLevelCommands.has(token));
  if (commandIndex < 0) return undefined;
  return JSON.stringify({
    command: tokens[commandIndex],
    args: [...tokens.slice(0, commandIndex), ...tokens.slice(commandIndex + 1)],
  });
}

function firstSentence(description: string): string {
  return description.match(/^.*?[.!?](?=\s+[A-Z]|\s*$)/)?.[0] ?? description;
}

function truncateReference(reference: string): string {
  const suffix = "\n[reference truncated]";
  const limit = MAX_REFERENCE_BYTES - Buffer.byteLength(suffix);
  const codePoints = [...reference];
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(codePoints.slice(0, middle).join("")) <= limit) low = middle;
    else high = middle - 1;
  }
  let result = codePoints.slice(0, low).join("");
  const newline = result.lastIndexOf("\n");
  if (newline > 0) result = result.slice(0, newline);
  return `${result}${suffix}`;
}

function renderReference(
  root: CommandReference,
  all: readonly CommandReference[],
  rootOutput: string,
  trimOptions: boolean,
  includeExamples: boolean,
): string {
  const lines = ["Worktrunk command reference"];
  const topLevelCommands = new Set(root.subcommands.map(({ syntax }) => syntax));
  const globalOptions = parseSectionEntries(rootOutput, new Set(["Options", "Global Options"]), "option");
  if (globalOptions.length) {
    lines.push("", "Global options:");
    for (const option of globalOptions) {
      lines.push(`- ${option.syntax}: ${trimOptions ? firstSentence(option.description) : option.description}`);
    }
  }
  for (const command of all) {
    lines.push("", `${command.path.join(" ")} — ${command.summary}`);
    if (command.path.length === 1) lines.push(`Usage: ${command.usage}`);
    if (command.subcommands.length) {
      lines.push("Subcommands:");
      for (const subcommand of command.subcommands) lines.push(`- ${subcommand.syntax}: ${subcommand.description}`);
    }
    if (command.arguments.length) {
      lines.push("Arguments:");
      for (const argument of command.arguments) lines.push(`- ${argument.syntax}: ${argument.description}`);
    }
    if (command.options.length) {
      lines.push("Options:");
      for (const option of command.options) {
        lines.push(`- ${option.syntax}: ${trimOptions ? firstSentence(option.description) : option.description}`);
      }
    }
    if (!includeExamples) continue;
    const examples = command.examples.flatMap((tokens) => {
      const example = renderToolExample(tokens, topLevelCommands);
      return example ? [example] : [];
    }).slice(0, MAX_EXAMPLES_PER_COMMAND);
    if (examples.length) {
      lines.push("Examples:");
      for (const example of examples) lines.push(`- ${example}`);
    }
  }
  return lines.join("\n");
}

export function formatReference(
  root: CommandReference,
  all: readonly CommandReference[],
  rootOutput: string,
): string {
  let reference = renderReference(root, all, rootOutput, false, true);
  if (Buffer.byteLength(reference) <= MAX_REFERENCE_BYTES) return reference;
  reference = renderReference(root, all, rootOutput, true, true);
  if (Buffer.byteLength(reference) <= MAX_REFERENCE_BYTES) return reference;
  reference = renderReference(root, all, rootOutput, true, false);
  return Buffer.byteLength(reference) <= MAX_REFERENCE_BYTES
    ? reference
    : truncateReference(reference);
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(HELP_PROBE_CONCURRENCY, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await worker(items[index]);
      }
    },
  ));
  return results;
}

export async function buildReference(
  commands: readonly WorktrunkCommand[],
  rootOutput: string,
  readCommand: (path: readonly string[]) => Promise<string | undefined>,
): Promise<string> {
  type PendingCommand = { path: string[]; summary: string };
  const references = new Map<string, CommandReference>();
  const requested = new Set<string>();
  let pending: PendingCommand[] = commands.map(({ name, description }) => ({
    path: [name],
    summary: description,
  }));

  while (pending.length) {
    for (const { path } of pending) requested.add(path.join("\0"));
    const outputs = await mapConcurrent(pending, async ({ path }) => {
      try { return await readCommand(path); } catch { return undefined; }
    });
    const next: PendingCommand[] = [];
    for (let index = 0; index < pending.length; index += 1) {
      const output = outputs[index];
      if (!output?.trim()) continue;
      const current = pending[index];
      const command = parseCommand(current.path, output, current.summary);
      references.set(current.path.join("\0"), command);
      for (const subcommand of command.subcommands) {
        const path = [...current.path, subcommand.syntax];
        const key = path.join("\0");
        if (!requested.has(key)) next.push({ path, summary: subcommand.description });
      }
    }
    pending = next;
  }

  const all: CommandReference[] = [];
  const append = (path: string[]) => {
    const command = references.get(path.join("\0"));
    if (!command) return;
    all.push(command);
    for (const subcommand of command.subcommands) append([...path, subcommand.syntax]);
  };
  for (const { name } of commands) append([name]);
  attributeExamples(all);
  return formatReference(parseCommand([], rootOutput), all, rootOutput);
}

export function parseWorktrunkCommands(output: string): WorktrunkCommand[] {
  return parseCommands(output).map(({ syntax, description }) => ({ name: syntax, description }));
}

function aliasStepNames(value: unknown): string[] {
  const steps: string[] = [];
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    for (const name of Object.keys(entry)) if (WORKTRUNK_ALIAS_NAME.test(name) && !steps.includes(name)) steps.push(name);
  }
  return steps;
}
export function parseWorktrunkAliases(output: string): WorktrunkAlias[] {
  const aliases = new Map<string, WorktrunkAlias>();
  let config: unknown;
  try { config = JSON.parse(output); } catch { return []; }
  if (!config || typeof config !== "object") return [];
  for (const source of ["user", "project"] as const) {
    const layer = (config as Record<string, any>)[source]?.config?.aliases;
    if (!layer || typeof layer !== "object") continue;
    for (const [name, value] of Object.entries(layer)) {
      if (!WORKTRUNK_ALIAS_NAME.test(name)) continue;
      const alias = aliases.get(name) ?? { name, steps: [] };
      for (const step of aliasStepNames(value)) if (!alias.steps.includes(step)) alias.steps.push(step);
      aliases.set(name, alias);
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
/** Global arguments that point `wt config approvals` at the invocation's project. */
export function approvalScope(invocation: Invocation, cwd: string): string[] {
  let directory = cwd;
  const config: string[] = [];
  const end = invocation.commandIndex ?? invocation.args.length;
  for (let index = 0; index < end; index += 1) {
    const value = invocation.args[index];
    if (value === "-C" && index + 1 < end) directory = resolve(cwd, invocation.args[++index]);
    else if (value.startsWith("-C") && value.length > 2) directory = resolve(cwd, value.slice(2));
    else if ((value === "--config" || value === "--config-set") && index + 1 < end) config.push(value, invocation.args[++index]);
    else if (value.startsWith("--config=") || value.startsWith("--config-set=")) config.push(value);
  }
  return ["-C", directory, ...config];
}
function isApprovalRetrySafe(invocation: Invocation): boolean {
  if (!invocation.command || !APPROVAL_RETRY_SAFE.has(invocation.command)) return false;
  return !(invocation.command === "step" && invocation.commandArgs.find((arg) => !arg.startsWith("-")) === "for-each");
}
function quoteArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
const WORKTREE_CHANGING_COMMANDS = new Set(["switch", "remove", "merge"]);
const WORKTREE_CHANGING_STEPS = new Set(["promote", "prune", "relocate"]);
/** Whether the command can switch to or remove worktrees (aliases may do either). */
export function mayChangeWorktree(invocation: Invocation, isAlias: boolean, directive?: string): boolean {
  if (directive) return true;
  if (!invocation.command) return false;
  if (isAlias) return true;
  if (WORKTREE_CHANGING_COMMANDS.has(invocation.command)) return true;
  return invocation.command === "step" &&
    WORKTREE_CHANGING_STEPS.has(invocation.commandArgs.find((arg) => !arg.startsWith("-")) ?? "");
}
/** Name the alias steps and exit code for a failed alias run, or undefined for other commands. */
export function aliasFailureSummary(invocation: Invocation, output: string, code: number | undefined): string | undefined {
  const name = invocation.command;
  if (!name) return undefined;
  const header = output.match(new RegExp(`Running alias ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (.+)`));
  if (!header) return undefined;
  const steps = header[1].split(",").map((step) => step.trim()).filter(Boolean);
  const exit = code === undefined ? "" : ` with exit code ${code}`;
  if (steps.length === 1) return `Alias \`${name}\` failed in step \`${steps[0]}\`${exit}.`;
  return `Alias \`${name}\` failed${exit} in one of its steps (${steps.join(" -> ")}). ` +
    "Steps run in order and stop at the first failure; Worktrunk does not report which one failed, so inspect the output above.";
}
/** Only known inspection commands run inside an active tool call. Hooks,
 * aliases, mutations, and unknown future commands need the command boundary. */
export function canRunInline(invocation: Invocation, isAlias: boolean): boolean {
  if (isAlias) return false;
  if (invocation.command === "list") return true;
  const paths = [
    ["step", "diff"], ["step", "eval"], ["hook", "show"],
    ["config", "show"], ["config", "alias", "show"], ["config", "alias", "dry-run"],
    ["config", "approvals", "list"], ["config", "state", "get"],
    ["config", "state", "cache", "get"], ["config", "state", "default-branch", "get"],
    ["config", "state", "logs", "get"], ["config", "state", "marker", "get"],
    ["config", "state", "vars", "get"], ["config", "state", "vars", "list"],
  ];
  const words = [invocation.command, ...invocation.commandArgs];
  return paths.some((path) => path.every((word, index) => words[index] === word));
}

const WorktrunkOutput = Type.Object({
  status: StringEnum(["completed", "failed", "queued", "stopped"], {
    description: "queued: not executed yet; stopped: session cannot continue. End the script immediately for either status.",
  }),
  args: Type.Array(Type.String()),
  cwd: Type.String({ description: "Pi working directory when the command was invoked." }),
  code: Type.Optional(Type.Integer({ description: "Worktrunk exit code; absent for queued commands." })),
  output: Type.String({ description: "Bounded command output, including failure and continuation guidance." }),
  truncated: Type.Boolean(),
  data: Type.Optional(Type.Unknown({ description: "Parsed stdout JSON, when valid and within the output limit." })),
}, { additionalProperties: false });

function toolReply(
  status: "completed" | "failed" | "queued" | "stopped",
  args: string[], cwd: string, text: string, result?: WtResult,
): AgentToolResult<{ args: string[]; code?: number }> {
  const output = boundedModelOutput(text);
  let data;
  if (result?.stdout && result.stdout.length <= MAX_CONTINUATION_OUTPUT) {
    try { data = JSON.parse(result.stdout); } catch { /* Plain text is valid output too. */ }
  }
  return {
    content: [{ type: "text", text: output }],
    details: { args, ...(result ? { code: result.code } : {}) },
    structuredContent: {
      status, args, cwd, output, truncated: output !== text,
      ...(result ? { code: result.code } : {}),
      ...(data !== undefined ? { data } : {}),
    },
    ...(status === "failed" || (status === "stopped" && result && (result.code !== 0 || result.killed)) ? { isError: true } : {}),
    ...(status === "queued" || status === "stopped" ? { terminate: true } : {}),
  };
}

function isBareCommand(invocation: Invocation, command: string): boolean {
  return invocation.command === command && invocation.commandArgs.length === 0;
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

function createLinkedSession(ctx: ExtensionCommandContext, source: SessionLocation, target: SessionLocation): string {
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
    { kind: "move", source, target, sourceSession, destinationSession } satisfies SessionTransitionDetails,
  );
  return destinationSession;
}

function repositoryIdentity(commonDir: string): RepositoryIdentity | undefined {
  try { const stat = statSync(commonDir); return { commonDir, device: stat.dev, inode: stat.ino }; } catch { return undefined; }
}
function sameRepositoryIdentity(left?: RepositoryIdentity, right?: RepositoryIdentity): boolean {
  return Boolean(left && right && left.commonDir === right.commonDir && left.device === right.device && left.inode === right.inode);
}

const COMMAND_ENTRY_TYPE = "pi-worktrunk-command-result";
type CommandDisplay = { args: string[]; output: string; isError: boolean };

function renderWorktrunkCall(args: string[], theme: Theme): Text {
  let text = theme.fg("toolTitle", theme.bold("Worktrunk"));
  if (args.length) text += ` ${theme.fg("accent", args.join(" "))}`;
  return new Text(text, 0, 0);
}

function renderWorktrunkOutput(output: string, expanded: boolean, isError: boolean, theme: Theme): Text {
  if (expanded && output) return new Text(output, 0, 0);
  let text = theme.fg(isError ? "error" : "success", isError ? "Failed" : "Done");
  if (output) text += theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
  return new Text(text, 0, 0);
}

export default function extension(pi: ExtensionAPI, invoke: RunWt = runDirectedWt) {
  pi.registerEntryRenderer<CommandDisplay>(COMMAND_ENTRY_TYPE, (entry, { expanded }, theme) => {
    if (!entry.data) return undefined;
    const { args, output, isError } = entry.data;
    const box = new Box(1, 1, (text) => theme.bg(isError ? "toolErrorBg" : "toolSuccessBg", text));
    box.addChild(renderWorktrunkCall(args, theme));
    box.addChild(renderWorktrunkOutput(output, expanded, isError, theme));
    return box;
  });
  const renderTransition: Parameters<ExtensionAPI["registerMessageRenderer"]>[1] =
    (message, { outputPad }, theme) => {
    const details = message.details as Partial<SessionTransitionDetails> | undefined;
    const recovery = details?.kind === "recovery";
    const source = details?.source;
    const target = details?.target;
    const label = (location: SessionLocation) => location.branch ?? basename(location.path);
    const title = recovery ? "↩ Session recovered" : "↪ Session moved";
    let text = theme.fg("text", source?.path && target?.path ? `${title}:` : title);
    if (source?.path && target?.path) {
      text += ` ${theme.fg("accent", theme.bold(label(source)))} ${theme.fg("text", "→")} ${theme.fg("accent", theme.bold(label(target)))}`;
    }
    return new Text(text, outputPad, 0);
  };
  pi.registerMessageRenderer?.(SESSION_TRANSITION_MESSAGE, renderTransition);
  pi.registerMessageRenderer?.(LEGACY_SESSION_TRANSITION_MESSAGE, renderTransition);

  const execWt: RunWt = (args, options) => pi.exec("wt", args, options);
  let aliases: WorktrunkAlias[] = [];
  let installedCommands: WorktrunkCommand[] = [];
  let installedVersion: string | undefined;
  let worktrunkReference = "";
  let pendingContinuation: PendingContinuation | undefined;
  let placementInFlight = false;
  let invocationInFlight = false;
  const commandNames = new Set<string>();
  const aliasNames = new Set<string>();

  async function readCommonDir(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      if (!statSync(cwd).isDirectory()) return undefined;
      const inside = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, signal, timeout: 5000 });
      if (inside.code !== 0 || inside.stdout.trim() !== "true") return undefined;
      const result = await pi.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, signal, timeout: 5000 });
      return result.code === 0 && result.stdout.trim() ? canonicalPath(resolve(cwd, result.stdout.trim())) : undefined;
    } catch { return undefined; }
  }
  async function directedDestination(raw: string | undefined, identity: RepositoryIdentity | undefined): Promise<string | undefined> {
    const path = parseDirectoryDirective(raw ?? "");
    if (!path) return undefined;
    const commonDir = await readCommonDir(path);
    if (!identity || !commonDir || !sameRepositoryIdentity(identity, repositoryIdentity(commonDir))) {
      throw new WorktrunkError(`Rejected Worktrunk destination: ${JSON.stringify(path)} (not in the original repository).`);
    }
    return path;
  }
  const runWt = execWt;
  const client = createWorktrunkClient(runWt);
  const tracker = createMarkerUpdater(execWt);

  async function safeList(cwd: string, signal?: AbortSignal): Promise<WorktreeItem[]> {
    try { return await client.list(cwd, signal); } catch { return []; }
  }
  async function discoverCommandsAndAliases(ctx: ExtensionContext) {
    aliases = [];
    installedCommands = [];
    installedVersion = undefined;
    worktrunkReference = "";
    commandNames.clear();
    aliasNames.clear();
    let help: WtResult;
    try {
      help = await runWt(["--help-md"], {
        cwd: ctx.cwd,
        signal: ctx.signal,
        timeout: HELP_PROBE_TIMEOUT_MS,
      });
    } catch { return; }
    if (help.code !== 0) return;
    const rootOutput = help.stdout ?? "";
    installedCommands = parseWorktrunkCommands(rootOutput);
    for (const { name } of installedCommands) commandNames.add(name);

    const [version, reference, settings] = await Promise.all([
      runWt(["--version"], {
        cwd: ctx.cwd,
        signal: ctx.signal,
        timeout: HELP_PROBE_TIMEOUT_MS,
      }).catch(() => undefined),
      buildReference(installedCommands, rootOutput, async (path) => {
        const help = await runWt(
          [...path, "--help-md"],
          {
            cwd: ctx.cwd,
            signal: ctx.signal,
            timeout: HELP_PROBE_TIMEOUT_MS,
          },
        );
        return help.code === 0 && help.stdout?.trim() ? help.stdout : undefined;
      }).catch(() => ""),
      client.settings(ctx.cwd, ctx.signal).catch(() => undefined),
    ]);
    if (version?.code === 0) installedVersion = version.stdout?.trim();
    worktrunkReference = reference;
    if (settings !== undefined) aliases = parseWorktrunkAliases(settings);
    for (const { name } of aliases) aliasNames.add(name);
  }
  function emit(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error") {
    if (ctx.mode === "print") process.stdout.write(`${message}\n`);
    else if (ctx.mode === "json") pi.sendMessage({ customType: "pi-worktrunk-command", content: message, display: true, details: { level } });
    else ctx.ui.notify(message, level);
  }
  function displayCommand(ctx: ExtensionCommandContext, args: string[], output: string, isError: boolean, modelOrigin: boolean) {
    if (!modelOrigin && ctx.mode === "tui") {
      // Persist before session placement so linked sessions inherit the card.
      // Entries are display-only: slash commands must not trigger an agent turn.
      pi.appendEntry<CommandDisplay>(COMMAND_ENTRY_TYPE, {
        args, output: boundedModelOutput(output), isError,
      });
    } else if (output) {
      emit(ctx, output, isError ? "error" : "info");
    }
  }
  async function pendingApprovals(scope: string[], cwd: string, signal?: AbortSignal): Promise<ProjectCommand[] | undefined> {
    try {
      const result = await runWt(
        [...scope, "config", "approvals", "list", "--format", "json"],
        { cwd, signal, timeout: HELP_PROBE_TIMEOUT_MS },
      );
      return result.code === 0 ? parsePendingApprovals(result.stdout ?? "") : undefined;
    } catch { return undefined; }
  }
  async function describeApprovalFailure(output: string, scope: string[], cwd: string, signal?: AbortSignal): Promise<string> {
    return isApprovalFailure(output)
      ? approvalFailureDetails(output, await pendingApprovals(scope, cwd, signal))
      : "";
  }
  type ApprovalOutcome = { approved: boolean; message: string };
  /** Show the pending commands verbatim and store approval only for what the user saw. */
  async function requestApproval(
    ctx: ExtensionCommandContext,
    args: readonly string[],
    scope: string[],
    known?: ProjectCommand[],
  ): Promise<ApprovalOutcome> {
    const pending = known ?? await pendingApprovals(scope, ctx.cwd, ctx.signal);
    if (!pending?.length) {
      return { approved: false, message: `Could not determine which project commands need approval.\n${APPROVAL_HINT}` };
    }
    const listing = formatProjectCommands(pending);
    const confirmed = await ctx.ui.confirm(
      "Approve Worktrunk project commands?",
      `\`wt ${args.join(" ")}\` needs approval to run these project commands. ` +
        `Approving saves them to Worktrunk's approvals for this project.\n\n${listing}`,
      { signal: ctx.signal },
    );
    if (!confirmed) {
      return { approved: false, message: `Approval declined; Worktrunk did not run these project commands:\n${listing}` };
    }
    // `approvals add --yes` approves whatever is pending when it runs. Refuse if
    // that differs from what the user just reviewed.
    const current = await pendingApprovals(scope, ctx.cwd, ctx.signal);
    if (!current || commandKeys(current) !== commandKeys(pending)) {
      return { approved: false, message: `The project commands changed while waiting for approval; nothing was approved.\n${APPROVAL_HINT}` };
    }
    let added: WtResult;
    try {
      added = await runWt([...scope, "config", "approvals", "add", "--yes"], { cwd: ctx.cwd, signal: ctx.signal });
    } catch (error) {
      added = { code: -1, stderr: error instanceof Error ? error.message : String(error) };
    }
    if (added.code !== 0) {
      const detail = [added.stderr?.trim(), added.stdout?.trim()].filter(Boolean).join("\n");
      return { approved: false, message: `Could not store approvals${detail ? `: ${detail}` : "."}\n${APPROVAL_HINT}` };
    }
    return { approved: true, message: `Approved project commands:\n${listing}` };
  }
  function continuationMessage(invocation: Invocation, execution: Execution) {
    const status = execution.result.code === 0 && !execution.result.killed
      ? "completed successfully"
      : "failed";
    const approval = status === "failed" && isApprovalFailure(execution.output);
    const details = approval ? approvalFailureDetails(execution.output) : "";
    const output = execution.output
      ? [execution.output.slice(0, MAX_CONTINUATION_OUTPUT), details].filter(Boolean).join("\n")
      : "(no output)";
    return {
      customType: CONTINUATION_MESSAGE_TYPE,
      content:
        `Worktrunk invocation \`wt ${invocation.args.join(" ")}\` ${status} ` +
        `(exit ${execution.result.code}).\n\n${output}\n\n` +
        (approval
          ? "Worktrunk needs the user's approval for project commands. Do not pass `--yes` or otherwise bypass approval; tell the user what needs approval and how to proceed, then continue with work that does not depend on it."
          : status === "failed"
          ? [
            aliasFailureSummary(invocation, execution.output, execution.result.code),
            "Read the error and adapt your approach, then continue the original task. Do not blindly repeat the failed invocation.",
          ].filter(Boolean).join(" ")
          : mayChangeWorktree(invocation, aliasNames.has(invocation.command ?? ""), execution.result.directive)
          ? "Continue the original task in this worktree. Do not repeat the Worktrunk invocation."
          : "The command did not change worktrees. Use the output above to continue the original task. Do not repeat the Worktrunk invocation."),
      display: false,
    } as const;
  }
  async function activate(
    ctx: ExtensionCommandContext,
    source: SessionLocation,
    target: SessionLocation,
    continuation?: ReturnType<typeof continuationMessage>,
  ) {
    const destinationSession = createLinkedSession(ctx, source, target);
    const result = await ctx.switchSession(destinationSession, {
      withSession: async (nextCtx) => {
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
      if (!worktrees.length) displayCommand(ctx, invocation.args, "No worktrees found.", false, modelOrigin);
      else {
        const selected = await chooseWorktree(ctx, "Select a worktree to inspect", worktrees);
        if (selected) displayCommand(ctx, invocation.args, formatWorktreeStatus(selected), false, modelOrigin);
      }
      return { result: { code: 0 }, output: "", moved: false, canContinue: true };
    }

    const commonDir = await readCommonDir(ctx.cwd, ctx.signal);
    const identity = commonDir ? repositoryIdentity(commonDir) : undefined;
    const before = await safeList(ctx.cwd, ctx.signal);
    const sourceItem = before.find((item) => item.worktree?.current);
    const source: SessionLocation = { branch: sourceItem?.branch ?? null, path: ctx.cwd, commonDir };
    let args = invocation.args;
    if (!modelOrigin && isBareCommand(invocation, "switch") && interactive && ctx.hasUI) {
      const selected = await chooseWorktree(ctx, "Select a worktree", before.filter((item) => item.worktree?.path));
      if (!selected?.worktree?.path) {
        return { result: { code: 0 }, output: "", moved: false, canContinue: true };
      }
      args = ["switch", selected.worktree.path];
    }

    const scope = approvalScope(invocation, ctx.cwd);
    const canPrompt = interactive && ctx.hasUI;
    const retrySafe = isApprovalRetrySafe(invocation);
    const notes: string[] = [];
    const command = invocation.command;
    const preflight = command !== undefined && !retrySafe &&
      (aliasNames.has(command) || !commandNames.has(command) || command === "step");
    if (canPrompt && preflight) {
      // Aliases may run steps before a nested command stops for approval, so
      // ask before running rather than retrying afterwards.
      const pending = await pendingApprovals(scope, ctx.cwd, ctx.signal);
      if (pending?.length) {
        const outcome = await requestApproval(ctx, args, scope, pending);
        if (!outcome.approved) {
          const output = `wt ${args.join(" ")} did not run. ${outcome.message}`;
          displayCommand(ctx, args, output, true, modelOrigin);
          return { result: { code: 1 }, output, moved: false, canContinue: true };
        }
        notes.push(outcome.message);
      }
    }

    const run = async (): Promise<WtResult> => {
      try { return await invoke(args, { cwd: ctx.cwd, signal: ctx.signal }); }
      catch (error) { return { code: -1, stderr: error instanceof Error ? error.message : String(error) }; }
    };
    const combine = (value: WtResult) => [value.stdout?.trimEnd(), value.stderr?.trimEnd()].filter(Boolean).join("\n");
    const approvalFailed = (value: WtResult, text: string) => value.code !== 0 && !value.killed && isApprovalFailure(text);
    let result = await run();
    let output = combine(result);
    let explained = false;
    if (approvalFailed(result, output) && canPrompt) {
      explained = true;
      const outcome = await requestApproval(ctx, args, scope);
      if (outcome.approved && retrySafe) {
        // Worktrunk checks approvals before acting, so nothing ran; retry once.
        notes.push(outcome.message);
        result = await run();
        output = combine(result);
        explained = false;
      } else if (outcome.approved) {
        output = [output, outcome.message, `Did not rerun \`wt ${args.join(" ")}\` automatically because earlier steps may already have run. Rerun it when that is safe.`].join("\n\n");
      } else {
        output = [output, outcome.message].join("\n\n");
      }
    }
    if (!explained && approvalFailed(result, output)) {
      output = [output, await describeApprovalFailure(output, scope, ctx.cwd, ctx.signal)].filter(Boolean).join("\n");
    }
    output = [...notes, output].filter(Boolean).join("\n\n");
    displayCommand(ctx, args, output, result.code !== 0 || Boolean(result.killed), modelOrigin);
    const base: Execution = { result, output, moved: false, canContinue: false };
    const continuation = modelOrigin ? continuationMessage(invocation, base) : undefined;

    // Reconcile even after failure/cancellation: the command may already have moved.
    // Use a fresh, bounded probe rather than the invocation's aborted signal.
    try {
      const directed = await directedDestination(result.directive, identity);
      if (directed) {
        if (canonicalPath(directed) === canonicalPath(ctx.cwd)) return { ...base, canContinue: true };
        if (!interactive || !ctx.sessionManager.getSessionFile()) {
          emit(ctx, `Worktrunk requested ${directed}. Continue Pi there; this session cannot move.`, "warning");
          return { ...base, canContinue: false };
        }
        const items = await safeList(directed);
        const target: SessionLocation = {
          path: directed,
          branch: items.find((item) => item.worktree?.current)?.branch ?? null,
          commonDir,
        };
        await activate(ctx, source, target, continuation);
        return { ...base, moved: true, canContinue: true };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit(ctx, message, "error");
      base.output = [output, message].filter(Boolean).join("\n\n");
      base.result = { ...result, code: result.code || -1 };
      // A rejected directive or cancelled session switch is recoverable when
      // the source worktree is still usable. Return the diagnostic to the model.
    }
    const currentCommonDir = await readCommonDir(ctx.cwd);
    base.canContinue = Boolean(identity && currentCommonDir &&
      sameRepositoryIdentity(identity, repositoryIdentity(currentCommonDir)));
    if (!base.canContinue) emit(ctx, "Pi's working directory is no longer usable. No destination was requested; restart Pi in a surviving worktree.", "error");
    return base;
  }

  pi.registerCommand("wt", {
    description: "Run Worktrunk",
    getArgumentCompletions(prefix) {
      const value = prefix.trimStart();
      if (/\s/.test(value)) return null;
      return [...commandNames, ...aliasNames].filter((name) => name.startsWith(value)).map((name) => ({ value: name, label: name }));
    },
    async handler(input, ctx) {
      let modelOrigin = false;
      let modelInvocation: Invocation | undefined;
      let scopeInvocation: Invocation | undefined;
      try {
        const received = parseWtInvocation(input);
        const marker = received.args.at(-1);
        const nonce = marker?.startsWith(CONTINUATION_ARG_PREFIX)
          ? marker.slice(CONTINUATION_ARG_PREFIX.length)
          : undefined;
        const args = nonce ? received.args.slice(0, -1) : received.args;
        const invocation = parseWtInvocation(args.map(quoteArgument).join(" "));
        scopeInvocation = invocation;
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
        if (modelOrigin) {
          pendingContinuation = undefined;
          modelInvocation = invocation;
        }
        const execution = await executeInvocation(invocation, ctx, modelOrigin);
        if (modelOrigin && !execution.moved && execution.canContinue) {
          pi.sendMessage(continuationMessage(invocation, execution), { triggerTurn: true });
        }
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error);
        if (isApprovalFailure(message)) {
          const scope = approvalScope(scopeInvocation ?? parseWtInvocation(""), ctx.cwd);
          message = [message, await describeApprovalFailure(message, scope, ctx.cwd)].filter(Boolean).join("\n");
        }
        emit(ctx, message, "error");
        if (modelInvocation && await readCommonDir(ctx.cwd)) {
          pi.sendMessage(continuationMessage(modelInvocation, {
            result: { code: -1 }, output: message, moved: false, canContinue: true,
          }), { triggerTurn: true });
        }
      } finally {
        if (modelOrigin) placementInFlight = false;
      }
    },
  });

  function registerTool() {
    const aliasCatalog = aliases.length
      ? `\n\nConfigured aliases:\n${aliases.map(({ name, steps }) => [
        `- ${name}: ${steps.length ? steps.join(" -> ") : "no pipeline metadata available"}`,
        `  Example: ${JSON.stringify({ command: name, args: [] })}`,
      ].join("\n")).join("\n")}`
      : "";
    const commandChoices = [...new Set([...commandNames, ...aliasNames])];
    const versionNotice = installedVersion
      ? ` Reference generated from installed ${installedVersion}.`
      : "";
    const referenceCatalog = worktrunkReference ? `\n\n${worktrunkReference}` : "";
    const commandSchema = commandChoices.length
      ? StringEnum(commandChoices, {
        description: "Built-in Worktrunk command or configured alias to run.",
      })
      : Type.String({ description: "Worktrunk command or configured alias to run." });
    pi.registerTool({
      name: "worktrunk",
      label: "Worktrunk",
      description: `Run Worktrunk commands using the command reference generated from the installed binary. The command's remaining arguments pass directly to wt without shell expansion. Pi follows Worktrunk's directory-change directive, including from aliases and foreground hooks. Calls must be sequential: issue one Worktrunk call, wait for its result, then issue the next; a call made while another is still pending fails. Inspection commands return structured results immediately. In TUI/RPC, other commands return status queued and run after this turn. In codemode, end the script immediately on queued or stopped; do not run dependent tools until the continuation arrives. Command failures return status failed with diagnostics, not a thrown exception.${versionNotice}${referenceCatalog}${aliasCatalog}`,
      promptSnippet: "Run Worktrunk commands using the installed command, option, and example reference",
      promptGuidelines: [
        "Use worktrunk for Worktrunk commands. Select a command and its remaining arguments from the worktrunk reference and examples.",
        "The worktrunk tool follows Worktrunk's requested directory automatically.",
        "In codemode, inspect worktrunk's status. End the script immediately on queued or stopped; queued commands have not run yet. Check failed before using results. Never run Worktrunk calls in parallel.",
        "Never pass -y/--yes to worktrunk; approving project commands is the user's decision, and Pi asks the user when Worktrunk needs approval.",
      ],
      parameters: Type.Object({
        command: commandSchema,
        args: Type.Optional(Type.Array(Type.String(), {
          description: "Arguments after the Worktrunk command, in CLI order and without shell expansion.",
        })),
      }, { additionalProperties: false }),
      prepareArguments(value): { command: string; args?: string[] } {
        const input = value as { command?: unknown; args?: unknown } | undefined;
        if (typeof input?.command === "string") {
          return {
            command: input.command,
            ...(Array.isArray(input.args) ? { args: input.args.filter((arg): arg is string => typeof arg === "string") } : {}),
          };
        }
        if (Array.isArray(input?.args) && input.args.every((arg) => typeof arg === "string")) {
          const legacyArgs = input.args as string[];
          const invocation = parseWtInvocation(legacyArgs.map(quoteArgument).join(" "));
          if (invocation.command !== undefined && invocation.commandIndex !== undefined) {
            return {
              command: invocation.command,
              args: [
                ...legacyArgs.slice(0, invocation.commandIndex),
                ...legacyArgs.slice(invocation.commandIndex + 1),
              ],
            };
          }
        }
        return value as { command: string; args?: string[] };
      },
      outputSchema: WorktrunkOutput,
      executionMode: "sequential",
      async execute(_id, params, _signal, _update, ctx) {
        const args = [params.command, ...(params.args ?? [])];
        const invocation = parseWtInvocation(args.map(quoteArgument).join(" "));
        if (isBareCommand(invocation, "switch")) {
          throw new WorktrunkError("The worktrunk tool requires an explicit target for `wt switch`.");
        }
        if (bypassesApproval(args)) {
          throw new WorktrunkError(
            "The worktrunk tool does not accept `-y`/`--yes`: it would skip Worktrunk's approval of project commands. " +
            "Run the command without it. When Worktrunk needs approval, Pi asks the user in interactive sessions; otherwise the user must approve in a terminal with `wt config approvals add`.",
          );
        }
        if (pendingContinuation && pendingContinuation.expiresAt <= Date.now()) {
          pendingContinuation = undefined;
          placementInFlight = false;
        }
        if (placementInFlight || invocationInFlight) {
          throw new WorktrunkError("Another model-triggered Worktrunk invocation is still pending. Worktrunk tool calls run sequentially: wait for the previous result, then call again.");
        }

        const signal = ctx.signal ?? _signal;
        signal?.throwIfAborted();
        invocationInFlight = true;
        try {
          if (ctx.mode === "print" || ctx.mode === "json" || canRunInline(invocation, aliasNames.has(params.command))) {
            const commonDir = await readCommonDir(ctx.cwd, signal);
            const identity = commonDir ? repositoryIdentity(commonDir) : undefined;
            let result: WtResult;
            try { result = await invoke(args, { cwd: ctx.cwd, signal }); }
            catch (error) {
              result = { code: -1, stderr: error instanceof Error ? error.message : String(error), killed: signal?.aborted };
            }
            const output = [result.stdout?.trimEnd(), result.stderr?.trimEnd()].filter(Boolean).join("\n");
            const pending = result.code !== 0 && !result.killed && isApprovalFailure(output)
              ? await pendingApprovals(approvalScope(invocation, ctx.cwd), ctx.cwd, signal)
              : undefined;
            const approval = approvalFailureDetails(output, pending);
            let stopReason: string | undefined;
            try {
              const destination = await directedDestination(result.directive, identity);
              if (destination && canonicalPath(destination) !== canonicalPath(ctx.cwd)) {
                stopReason = `Worktrunk requested ${destination}. This tool call cannot move the session; restart Pi there.`;
              } else {
                const current = await readCommonDir(ctx.cwd);
                if (!current || !sameRepositoryIdentity(identity, repositoryIdentity(current))) {
                  stopReason = `Pi's working directory no longer exists or is not the original Git worktree: ${ctx.cwd}. Restart Pi in a surviving worktree.`;
                }
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const current = await readCommonDir(ctx.cwd);
              if (current && sameRepositoryIdentity(identity, repositoryIdentity(current))) {
                return toolReply("failed", args, ctx.cwd, [output, approval, message].filter(Boolean).join("\n\n"), result);
              }
              stopReason = message;
            }
            if (stopReason) {
              ctx.abort();
              return toolReply("stopped", args, ctx.cwd, [output, approval, stopReason].filter(Boolean).join("\n\n"), result);
            }
            if (result.code !== 0 || result.killed) {
              const failure = formatWtFailure(args, result, ctx.cwd);
              return toolReply("failed", args, ctx.cwd,
                [failure, aliasFailureSummary(invocation, failure, result.code), approvalFailureDetails(failure, pending)].filter(Boolean).join("\n"), result);
            }
            return toolReply("completed", args, ctx.cwd, output || `wt ${args.join(" ")} completed successfully.`, result);
          }
          const nonce = randomUUID();
          placementInFlight = true;
          pendingContinuation = {
            key: JSON.stringify(args),
            nonce,
            expiresAt: Date.now() + 5 * 60_000,
          };
          const marker = `${CONTINUATION_ARG_PREFIX}${nonce}`;
          try {
            pi.sendUserMessage(
              `/wt ${[...args, marker].map(quoteArgument).join(" ")}`,
              { deliverAs: "followUp", expandPromptTemplates: true },
            );
          } catch (error) {
            pendingContinuation = undefined;
            placementInFlight = false;
            throw error;
          }
          return toolReply("queued", args, ctx.cwd, `Queued wt ${args.join(" ")}. Worktrunk will run after this turn, and the result will be returned before work continues. End this script now; do not run dependent tools yet.`);
        } finally {
          invocationInFlight = false;
        }
      },
      renderCall(args, theme) {
        const invocation = [args.command, ...(args.args ?? [])].filter((value): value is string => typeof value === "string");
        return renderWorktrunkCall(invocation, theme);
      },
      renderResult(result, { expanded }, theme, context) {
        const details = result.details as { code?: unknown } | undefined;
        if (!context.isError && details?.code === undefined) return new Text("", 0, 0);
        const text = result.content.find((item) => item.type === "text")?.text ?? "";
        return renderWorktrunkOutput(text, expanded, context.isError, theme);
      },
    });
  }

  // Make renderers available before history is built, then refresh the command
  // catalog after repository-specific discovery.
  registerTool();

  // Nested tools do not propagate terminate to their caller. Prevent a script
  // (or a subsequent model tool call) from using the old workspace while a
  // command is queued for the idle/session-replacement boundary.
  pi.on("tool_call", () => {
    if (placementInFlight && pendingContinuation && pendingContinuation.expiresAt > Date.now()) {
      return {
        block: true,
        reason: "A Worktrunk command is queued and has not run yet. End this script/turn and wait for its continuation before calling more tools.",
        terminate: true,
      };
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    await discoverCommandsAndAliases(ctx);
    registerTool();
    await tracker.markWaiting(ctx.cwd);
  });
  pi.on("agent_start", (_event, ctx) => tracker.markWorking(ctx.cwd));
  pi.on("agent_end", (_event, ctx) => tracker.markWaiting(ctx.cwd));
  pi.on("session_shutdown", (_event, ctx) => tracker.clear(ctx.cwd));
}
