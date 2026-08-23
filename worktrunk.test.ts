import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import extension, {
  MARKERS,
  createMarkerUpdater,
  markerArgs,
  parseAliasArguments,
  parseWtInvocation,
  parseWorktrunkAliasMetadata,
  parseWorktrunkAliasNames,
} from "./worktrunk.ts";

const list = (items: unknown[]) => JSON.stringify({ schema: 2, items });
const wtList = (source: string, target?: string) => list([
  { branch: "main", worktree: { path: source, main: true, current: true } },
  ...(target ? [{ branch: "fix/parser", worktree: { path: target, current: false } }] : []),
]);

test("argument parsing preserves Worktrunk argv", () => {
  assert.deepEqual(parseAliasArguments(`--verbose switch --create "fix/parser" -cv`), [
    "--verbose", "switch", "--create", "fix/parser", "-cv",
  ]);
  assert.deepEqual(parseWtInvocation("switch --create fix/parser"), {
    args: ["switch", "--create", "fix/parser"],
    command: "switch",
    commandArgs: ["--create", "fix/parser"],
  });
  assert.deepEqual(parseWtInvocation("--config custom.toml list"), {
    args: ["--config", "custom.toml", "list"],
    command: "--config",
    commandArgs: ["custom.toml", "list"],
  });
  assert.throws(() => parseAliasArguments("'unfinished"), /unterminated quote/);
});

test("alias discovery includes pipeline metadata", () => {
  assert.deepEqual(parseWorktrunkAliasNames("Aliases:\n  land, deploy\n\nOptions:"), ["land", "deploy"]);
  assert.deepEqual(parseWorktrunkAliasMetadata(["land", "deploy"], JSON.stringify({
    user: { config: { aliases: { land: [{ "merge-pr": "gh pr merge" }, { verify: "bun test" }] } } },
    project: { config: { aliases: { land: [{ cleanup: "wt remove" }], deploy: "make deploy" } } },
  })), [
    { name: "land", steps: ["merge-pr", "verify", "cleanup"] },
    { name: "deploy", steps: [] },
  ]);
});

test("markers map Pi state to Worktrunk", async () => {
  assert.deepEqual(markerArgs(MARKERS.working), ["config", "state", "marker", "set", "🤖"]);
  const calls: string[][] = [];
  const updater = createMarkerUpdater(async (args) => { calls.push(args); return { code: 1 }; });
  await updater.markWaiting();
  await updater.markWorking();
  assert.deepEqual(calls, [["config", "state", "marker", "set", "💬"]]);
});

function baseApi(options: {
  exec: (program: string, args: string[], options?: any) => Promise<any>;
  handlers: Map<string, any>;
  commands: Map<string, any>;
  tools: Map<string, any>;
  sent?: Array<{ text: string; options: any }>;
  renderer?: Map<string, any>;
}) {
  return {
    on(name: string, handler: any) { options.handlers.set(name, handler); },
    registerCommand(name: string, definition: any) { options.commands.set(name, definition); },
    registerTool(definition: any) { options.tools.set(definition.name, definition); },
    registerMessageRenderer(name: string, renderer: any) { options.renderer?.set(name, renderer); },
    appendEntry() {},
    sendMessage() {},
    sendUserMessage(text: string, sendOptions: any) { options.sent?.push({ text, options: sendOptions }); },
    exec: options.exec,
  } as any;
}

test("session start registers one repository-specific tool", async () => {
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  extension(baseApi({
    handlers, commands, tools,
    async exec(program, args) {
      if (program === "git") return { code: 1, stdout: "", stderr: "" };
      if (args.join(" ") === "--help") return { code: 0, stdout: "Aliases:\n  land, deploy\n" };
      if (args.join(" ") === "config show --format=json") return { code: 0, stdout: JSON.stringify({
        project: { config: { aliases: { land: [{ "merge-pr": "x" }, { verify: "x" }, { cleanup: "x" }], deploy: "x" } } },
      }) };
      return { code: 0, stdout: "" };
    },
  }));
  await handlers.get("session_start")({}, { cwd: process.cwd(), signal: undefined, sessionManager: { getEntries: () => [] } });
  assert.deepEqual([...commands.keys()], ["wt"]);
  assert.deepEqual([...tools.keys()], ["worktrunk"]);
  const tool = tools.get("worktrunk");
  assert.deepEqual(tool.parameters.required, ["args"]);
  assert.equal(tool.parameters.properties.args.minItems, 1);
  assert.match(tool.description, /land: merge-pr -> verify -> cleanup/);
  assert.match(tool.description, /deploy: no pipeline metadata available/);
});

test("tool confirms aliases and queues exact argv for the shared command", async () => {
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const sent: Array<{ text: string; options: any }> = [];
  const confirmations: string[] = [];
  extension(baseApi({
    handlers, commands, tools, sent,
    async exec(program, args) {
      if (program === "git") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "--help") return { code: 0, stdout: "Aliases:\n  land\n" };
      if (args[0] === "config") return { code: 0, stdout: JSON.stringify({ project: { config: { aliases: { land: [{ verify: "x" }] } } } }) };
      return { code: 0, stdout: "" };
    },
  }));
  await handlers.get("session_start")({}, { cwd: process.cwd(), signal: undefined, sessionManager: { getEntries: () => [] } });
  const result = await tools.get("worktrunk").execute("call", { args: ["land", "two words"] }, undefined, undefined, {
    cwd: process.cwd(), hasUI: true,
    ui: { async confirm(_title: string, message: string) { confirmations.push(message); return true; } },
  });
  assert.equal(result.terminate, true);
  assert.match(confirmations[0], /Pipeline: verify/);
  assert.deepEqual(sent, [{
    text: "/wt 'land' 'two words'",
    options: { deliverAs: "followUp", expandPromptTemplates: true },
  }]);
});

test("create-and-switch moves and resumes model work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-move-"));
  const source = join(root, "repo");
  const target = join(root, "repo.fix-parser");
  const common = join(source, ".git");
  const sessions = join(root, "sessions");
  await mkdir(common, { recursive: true });
  const manager = SessionManager.create(source, sessions);
  manager.appendSessionInfo("test");
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const sent: Array<{ text: string; options: any }> = [];
  const wtCalls: string[][] = [];
  let created = false;
  let switched = "";
  let continuation: any;
  try {
    extension(baseApi({
      handlers, commands, tools, sent,
      async exec(program, args) {
        if (program === "git") return { code: 0, stdout: `${common}\n`, stderr: "" };
        if (args[0] === "--help") return { code: 0, stdout: "" };
        if (args.includes("list")) return { code: 0, stdout: wtList(source, created ? target : undefined) };
        wtCalls.push([...args]);
        if (args.join("\0") === ["switch", "--create", "fix/parser"].join("\0")) {
          await mkdir(target);
          created = true;
          return { code: 0, stdout: "Created fix/parser" };
        }
        return { code: 0, stdout: "" };
      },
    }));
    const sessionCtx = { cwd: source, signal: undefined, sessionManager: manager };
    await handlers.get("session_start")({}, sessionCtx);
    await tools.get("worktrunk").execute("call", { args: ["switch", "--create", "fix/parser"] }, undefined, undefined, { cwd: source, hasUI: true, ui: {} });
    await commands.get("wt").handler("'switch' '--create' 'fix/parser'", {
      ...sessionCtx, mode: "tui", hasUI: true,
      async waitForIdle() {},
      async switchSession(path: string, options: any) {
        switched = path;
        await options.withSession({
          ui: { notify() {} },
          async sendMessage(message: any, opts: any) { continuation = { message, opts }; },
        });
        return { cancelled: false };
      },
      ui: { notify() {} },
    });
    assert.ok(wtCalls.some((args) => args.join("\0") === ["switch", "--create", "fix/parser"].join("\0")));
    assert.equal(SessionManager.open(switched, sessions).getCwd(), realpathSync(target));
    assert.equal(continuation.message.display, false);
    assert.equal(continuation.opts.triggerTurn, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ambiguous creations stay in the source session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-ambiguous-"));
  const source = join(root, "repo");
  await mkdir(join(source, ".git"), { recursive: true });
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  let changed = false;
  let switches = 0;
  try {
    extension(baseApi({ handlers, commands, tools, async exec(program, args) {
      if (program === "git") return { code: 0, stdout: `${join(source, ".git")}\n` };
      if (args[0] === "--help") return { code: 0, stdout: "" };
      if (args.includes("list")) return { code: 0, stdout: list([
        { branch: "main", worktree: { path: source, main: true, current: true } },
        ...(changed ? [
          { branch: "one", worktree: { path: join(root, "one") } },
          { branch: "two", worktree: { path: join(root, "two") } },
        ] : []),
      ]) };
      changed = true;
      await mkdir(join(root, "one")); await mkdir(join(root, "two"));
      return { code: 0, stdout: "done" };
    } }));
    const manager = SessionManager.create(source, join(root, "sessions"));
    manager.appendSessionInfo("test");
    await handlers.get("session_start")({}, { cwd: source, sessionManager: manager });
    await commands.get("wt").handler("deploy", {
      cwd: source, mode: "tui", hasUI: true, sessionManager: manager,
      async waitForIdle() {}, async switchSession() { switches++; return { cancelled: false }; },
      ui: { notify() {} },
    });
    assert.equal(switches, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("transition renderer keeps move and recovery variants", () => {
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const renderers = new Map<string, any>();
  extension(baseApi({ handlers, commands, tools, renderer: renderers, async exec() { return { code: 0, stdout: "" }; } }));
  const renderer = renderers.get("pi-worktrunk-session-transition");
  const theme = { fg(_color: string, text: string) { return text; }, bold(text: string) { return text; } };
  const message = { details: {
    kind: "move",
    source: { branch: "feature/wt-session-placement", path: `${homedir()}/code/pi-worktrunk.feature` },
    target: { branch: "main", path: `${homedir()}/code/pi-worktrunk` },
  } };
  assert.deepEqual(renderer(message, { expanded: false, outputPad: 0 }, theme).render(100).map((line: string) => line.trimEnd()), [
    "↪ Session moved", "  feature/wt-session-placement → main",
  ]);
  assert.deepEqual(renderer(message, { expanded: true, outputPad: 0 }, theme).render(100).map((line: string) => line.trimEnd()), [
    "↪ Session moved", "  feature/wt-session-placement → main", "", "  From  ~/code/pi-worktrunk.feature", "  To    ~/code/pi-worktrunk",
  ]);
  message.details.kind = "recovery";
  assert.equal(renderer(message, { expanded: false, outputPad: 0 }, theme).render(100)[0].trimEnd(), "↩ Session recovered");
});
