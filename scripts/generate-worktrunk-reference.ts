import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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

const MAX_REFERENCE_BYTES = 30_000;
const MAX_EXAMPLES_PER_COMMAND = 3;

function wtHelp(path: readonly string[]): string {
  return execFileSync("wt", [...path, "--help"], { encoding: "utf8" });
}

function isEntryStart(value: string, kind: "argument" | "option"): boolean {
  return kind === "option"
    ? /^--?[A-Za-z0-9]/.test(value)
    : /^(?:\[(?!(?:default|possible values):)[^\]]+\]|<[^>]+>)(?:\.{3})?/.test(value);
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
    if (!isEntryStart(trimmed, kind)) continue;
    const match = trimmed.match(/^(.+?)(?:\s{2,}(.+))?$/);
    if (!match) continue;
    if (kind === "option" && /(?:^|, )-(?:h|-help|V|-version)(?:\s|$)/.test(match[1])) continue;

    const details = match[2] ? [match[2]] : [];
    for (let next = index + 1; next < lines.length && details.length < 2; next += 1) {
      const candidate = lines[next];
      if (!candidate.trim()) continue;
      if (!/^\s/.test(candidate) || isEntryStart(candidate.trim(), kind)) break;
      const detail = candidate.trim();
      if (/^[─┌└├┬┼│]/.test(detail) || /^-\s/.test(detail)) continue;
      details.push(detail);
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
    if (match) entries.push({ syntax: match[1], description: match[2] });
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

export function parseExamples(output: string): string[][] {
  const result: string[][] = [];
  let active = false;
  for (const line of output.split("\n")) {
    if (/^Examples:?$/.test(line.trim())) { active = true; continue; }
    if (!active) continue;
    const match = line.match(/^\s+wt\s+(.+?)\s*$/);
    if (!match) continue;
    const parsed = splitShell(match[1]);
    if (!parsed?.length || parsed.at(-1)?.endsWith(".")) continue;
    const key = JSON.stringify(parsed);
    if (!result.some((value) => JSON.stringify(value) === key)) result.push(parsed);
  }
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
    ?? `wt ${path.join(" ")}`;
  return {
    path,
    summary,
    usage,
    arguments: parseSectionEntries(output, new Set(["Arguments"]), "argument"),
    options: parseSectionEntries(output, new Set(["Options", "* Options", "Automation"]), "option"),
    subcommands: parseCommands(output),
    examples: parseExamples(output),
  };
}

function collect(
  path: string[],
  fallbackSummary: string,
  readHelp: (path: readonly string[]) => string,
): CommandReference[] {
  const command = parseCommand(path, readHelp(path), fallbackSummary);
  return [
    command,
    ...command.subcommands.flatMap(({ syntax, description }) =>
      collect([...path, syntax], description, readHelp)),
  ];
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

export function formatReference(
  root: CommandReference,
  all: readonly CommandReference[],
  rootOutput: string,
): string {
  const lines = ["Worktrunk command reference"];
  const topLevelCommands = new Set(root.subcommands.map(({ syntax }) => syntax));
  const globalOptions = parseSectionEntries(
    rootOutput,
    new Set(["Options", "Global Options"]),
    "option",
  );
  if (globalOptions.length) {
    lines.push("", "Global options:");
    for (const option of globalOptions) lines.push(`- ${option.syntax}: ${option.description}`);
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
      for (const option of command.options) lines.push(`- ${option.syntax}: ${option.description}`);
    }
    const renderedExamples = command.examples.flatMap((tokens) => {
      const example = renderToolExample(tokens, topLevelCommands);
      return example ? [example] : [];
    }).slice(0, MAX_EXAMPLES_PER_COMMAND);
    if (renderedExamples.length) {
      lines.push("Examples:");
      for (const example of renderedExamples) lines.push(`- ${example}`);
    }
  }
  return lines.join("\n");
}

export function generateSource(
  readHelp: (path: readonly string[]) => string = wtHelp,
  version = execFileSync("wt", ["--version"], { encoding: "utf8" }).trim(),
): { source: string; commands: number; bytes: number } {
  const rootOutput = readHelp([]);
  const root = parseCommand([], rootOutput);
  const all = root.subcommands.flatMap(({ syntax, description }) =>
    collect([syntax], description, readHelp));
  const topLevelCommands = root.subcommands.map(({ syntax }) => syntax);
  const reference = formatReference(root, all, rootOutput);
  const bytes = Buffer.byteLength(reference);
  if (bytes > MAX_REFERENCE_BYTES) {
    throw new Error(`Generated reference is ${bytes} bytes; limit is ${MAX_REFERENCE_BYTES}.`);
  }
  const template = reference
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${");
  const source = `// Generated by scripts/generate-worktrunk-reference.ts from ${version}.\n` +
    "// Do not edit by hand.\n\n" +
    `export const WORKTRUNK_REFERENCE_VERSION = ${JSON.stringify(version)};\n` +
    `export const WORKTRUNK_COMMANDS = ${JSON.stringify(topLevelCommands)} as const;\n\n` +
    `export const WORKTRUNK_REFERENCE = \`${template}\`;\n`;
  return { source, commands: all.length, bytes };
}

function main(): void {
  const destination = resolve(dirname(fileURLToPath(import.meta.url)), "..", "worktrunk-reference.ts");
  const generated = generateSource();
  if (process.argv.includes("--check")) {
    if (readFileSync(destination, "utf8") !== generated.source) {
      throw new Error("worktrunk-reference.ts is stale; run `npm run generate-reference`.");
    }
    console.log(`Reference is current (${generated.commands} commands, ${generated.bytes} bytes)`);
    return;
  }
  writeFileSync(destination, generated.source);
  console.log(`Wrote ${destination} (${generated.commands} commands, ${generated.bytes} bytes)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
