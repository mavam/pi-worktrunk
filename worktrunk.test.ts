import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import { WORKTRUNK_REFERENCE_VERSION } from "./worktrunk-reference.ts";
import extension, {
  MARKERS,
  createMarkerUpdater,
  createWorktrunkClient,
  markerArgs,
  parseAliasArguments,
  parseWtInvocation,
  parseWorktrunkAliasMetadata,
  parseWorktrunkAliasNames,
  parseWorktrunkCommands,
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
    commandIndex: 0,
    commandArgs: ["--create", "fix/parser"],
  });
  assert.deepEqual(parseWtInvocation("--config custom.toml list"), {
    args: ["--config", "custom.toml", "list"],
    command: "list",
    commandIndex: 2,
    commandArgs: [],
  });
  assert.deepEqual(parseWtInvocation("-v switch main"), {
    args: ["-v", "switch", "main"],
    command: "switch",
    commandIndex: 1,
    commandArgs: ["main"],
  });
  assert.throws(() => parseAliasArguments("'unfinished"), /unterminated quote/);
});

test("command and alias discovery parse Worktrunk help", () => {
  const help = [
    "Commands:",
    "  switch  Switch worktrees",
    "  doctor  Diagnose setup",
    "",
    "Aliases:",
    "  land, deploy",
  ].join("\n");
  assert.deepEqual(parseWorktrunkCommands(help), [
    { name: "switch", description: "Switch worktrees" },
    { name: "doctor", description: "Diagnose setup" },
  ]);
  assert.deepEqual(parseWorktrunkAliasNames(help), ["land", "deploy"]);
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
  messages?: Array<{ message: any; options: any }>;
  renderer?: Map<string, any>;
}) {
  return {
    on(name: string, handler: any) { options.handlers.set(name, handler); },
    registerCommand(name: string, definition: any) { options.commands.set(name, definition); },
    registerTool(definition: any) { options.tools.set(definition.name, definition); },
    registerMessageRenderer(name: string, renderer: any) { options.renderer?.set(name, renderer); },
    appendEntry() {},
    sendMessage(message: any, sendOptions: any) { options.messages?.push({ message, options: sendOptions }); },
    sendUserMessage(text: string, sendOptions: any) { options.sent?.push({ text, options: sendOptions }); },
    exec: options.exec,
  } as any;
}

test("tool registers synchronously before repository-specific discovery", async () => {
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  extension(baseApi({
    handlers, commands, tools,
    async exec(program, args) {
      if (program === "git") return { code: 1, stdout: "", stderr: "" };
      if (args.join(" ") === "--help") return { code: 0, stdout: [
        "Commands:",
        "  switch  Switch worktrees",
        "  doctor  Diagnose setup",
        "",
        "Aliases:",
        "  land, deploy",
      ].join("\n") };
      if (args.join(" ") === "--version") return { code: 0, stdout: "wt v-next\n" };
      if (args.join(" ") === "config show --format=json") return { code: 0, stdout: JSON.stringify({
        project: { config: { aliases: { land: [{ "merge-pr": "x" }, { verify: "x" }, { cleanup: "x" }], deploy: "x" } } },
      }) };
      return { code: 0, stdout: "" };
    },
  }));
  assert.deepEqual([...commands.keys()], ["wt"]);
  assert.deepEqual([...tools.keys()], ["worktrunk"]);

  await handlers.get("session_start")({}, { cwd: process.cwd(), signal: undefined, sessionManager: { getEntries: () => [] } });
  const tool = tools.get("worktrunk");
  assert.deepEqual(tool.parameters.required, ["command"]);
  assert.deepEqual(tool.parameters.properties.command.enum, [
    "switch", "list", "remove", "merge", "step", "hook", "config", "doctor", "land", "deploy",
  ]);
  assert.match(tool.parameters.properties.args.description, /Arguments after the Worktrunk command/);
  assert.match(tool.description, /Worktrunk command reference/);
  assert.match(tool.description, /switch — Switch to a worktree; create if needed/);
  assert.match(tool.description, /- -c, --create: Create a new branch/);
  assert.match(tool.description, /\{"command":"switch","args":\["--create","new-feature"\]\}/);
  assert.match(tool.description, /config state marker — Branch markers/);
  assert.ok(tool.description.includes(`Bundled reference: ${WORKTRUNK_REFERENCE_VERSION}; installed: wt v-next`));
  assert.match(tool.description, /doctor: Diagnose setup/);
  assert.match(tool.description, /land: merge-pr -> verify -> cleanup/);
  assert.match(tool.description, /Example: \{"command":"deploy","args":\[\]\}/);
  assert.match(tool.promptSnippet, /complete built-in command, option, and example reference/);
  assert.ok(tool.promptGuidelines.some((guideline: string) => guideline.includes("reference and examples")));
  assert.deepEqual(tool.prepareArguments({ args: ["switch", "--create", "fix/parser"] }), {
    command: "switch", args: ["--create", "fix/parser"],
  });
  assert.deepEqual(tool.prepareArguments({ args: ["-v", "land", "two words"] }), {
    command: "land", args: ["-v", "two words"],
  });
  assert.deepEqual(commands.get("wt").getArgumentCompletions("sw"), [
    { value: "switch", label: "switch" },
  ]);
});

test("tool queues aliases without confirmation", async () => {
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const sent: Array<{ text: string; options: any }> = [];
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
  const tool = tools.get("worktrunk");
  const result = await tool.execute("call", { command: "land", args: ["-v", "two words"] }, undefined, undefined, {
    cwd: process.cwd(), hasUI: false, ui: {},
  });
  assert.equal(result.terminate, true);
  assert.deepEqual(tool.renderResult(result, {}, {}, { isError: false }).render(100), []);
  assert.match(sent[0].text, /^\/wt 'land' '-v' 'two words' '__pi_worktrunk_continuation=[^']+'$/);
  assert.deepEqual(sent[0].options, {
    deliverAs: "followUp",
    expandPromptTemplates: true,
  });
  await assert.rejects(
    tools.get("worktrunk").execute("second", { command: "list" }, undefined, undefined, {
      cwd: process.cwd(), hasUI: false, ui: {},
    }),
    /still pending/,
  );
});

test("non-interactive tools run Worktrunk before the session exits", async () => {
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const sent: Array<{ text: string; options: any }> = [];
  const calls: string[][] = [];
  let abortCalls = 0;
  extension(baseApi({
    handlers, commands, tools, sent,
    async exec(program, args, options) {
      if (program === "git") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "--help" || args[0] === "--version" || args[0] === "config") {
        return { code: 0, stdout: "" };
      }
      calls.push([...args]);
      if (args.includes("--large")) return { code: 0, stdout: "x".repeat(50_001) };
      if (args[0] === "remove") {
        await rm(options.cwd, { recursive: true, force: true });
        return { code: 0, stdout: "removed\n" };
      }
      return { code: 0, stdout: "main worktree\n" };
    },
  }));
  await handlers.get("session_start")({}, {
    cwd: process.cwd(), signal: undefined, sessionManager: { getEntries: () => [] },
  });

  for (const mode of ["print", "json"]) {
    const result = await tools.get("worktrunk").execute(
      "call",
      { command: "list" },
      undefined,
      undefined,
      { cwd: process.cwd(), mode, hasUI: false, ui: {} },
    );

    assert.equal(result.terminate, undefined);
    assert.equal(result.content[0].text, "main worktree");
    assert.deepEqual(result.details, { args: ["list"], code: 0 });

    await assert.rejects(
      tools.get("worktrunk").execute(
        `promote-${mode}`,
        { command: "step", args: ["promote", "feature"] },
        undefined,
        undefined,
        { cwd: process.cwd(), mode, hasUI: false, ui: {} },
      ),
      /requires TUI or RPC mode/,
    );
  }

  await assert.rejects(
    tools.get("worktrunk").execute(
      "switch",
      { command: "switch", args: ["feature"] },
      undefined,
      undefined,
      { cwd: process.cwd(), mode: "print", hasUI: false, ui: {} },
    ),
    /requires TUI or RPC mode/,
  );

  const large = await tools.get("worktrunk").execute(
    "large",
    { command: "list", args: ["--large"] },
    undefined,
    undefined,
    { cwd: process.cwd(), mode: "print", hasUI: false, ui: {} },
  );
  assert.ok(large.content[0].text.startsWith("x".repeat(50_000)));
  assert.ok(large.content[0].text.endsWith("[output truncated]"));

  const removedCwd = await mkdtemp(join(tmpdir(), "pi-worktrunk-print-"));
  try {
    const removed = await tools.get("worktrunk").execute(
      "remove",
      { command: "remove", args: ["current"] },
      undefined,
      undefined,
      { cwd: removedCwd, mode: "print", hasUI: false, ui: {}, abort: () => { abortCalls += 1; } },
    );
    assert.equal(removed.terminate, true);
    assert.match(removed.content[0].text, /working directory no longer exists/);
    assert.equal(abortCalls, 1);
  } finally {
    await rm(removedCwd, { recursive: true, force: true });
  }
  assert.deepEqual(calls, [["list"], ["list"], ["list", "--large"], ["remove", "current"]]);
  assert.deepEqual(sent, []);
});

test("removing the current worktree aborts the remaining tool batch", async () => {
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  extension(baseApi({
    handlers, commands, tools,
    async exec(program, args, options) {
      if (program === "git") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "--help" || args[0] === "--version" || args[0] === "config") {
        return { code: 0, stdout: "" };
      }
      if (args[0] === "remove") {
        await rm(options.cwd, { recursive: true, force: true });
        return { code: 0, stdout: "removed\n" };
      }
      return { code: 0, stdout: "" };
    },
  }));
  await handlers.get("session_start")({}, {
    cwd: process.cwd(), signal: undefined, sessionManager: { getEntries: () => [] },
  });

  const removedCwd = await mkdtemp(join(tmpdir(), "pi-worktrunk-batch-"));
  try {
    const registered = tools.get("worktrunk");
    let remainingCalls = 0;
    const faux = fauxProvider({ models: [{ id: "test" }] });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("worktrunk", { command: "remove", args: ["current"] }, { id: "remove" }),
        fauxToolCall("remaining", { command: "list" }, { id: "remaining" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("continued"),
    ]);
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const remaining = {
      name: "remaining",
      description: "Runs after Worktrunk",
      parameters: registered.parameters,
      async execute() {
        remainingCalls += 1;
        return { content: [{ type: "text" as const, text: "ran" }], details: {} };
      },
    };
    const { session } = await createAgentSession({
      cwd: removedCwd,
      agentDir: removedCwd,
      model: faux.getModel(),
      modelRuntime,
      noTools: "builtin",
      customTools: [registered, remaining],
      sessionManager: SessionManager.inMemory(removedCwd),
    });
    try {
      await session.prompt("remove the current worktree");

      assert.equal(remainingCalls, 0);
      assert.equal(faux.state.callCount, 1);
    } finally {
      session.dispose();
    }
  } finally {
    await rm(removedCwd, { recursive: true, force: true });
  }
});

test("Worktrunk client handles relocated lists and failures", async () => {
  const calls: string[][] = [];
  const client = createWorktrunkClient(async (args) => {
    calls.push(args);
    return {
      code: 0,
      relocated: true,
      stdout: list([{ branch: "main", worktree: { path: "/repo", current: true } }]),
    };
  });
  const items = await client.list("/removed");
  assert.equal(items[0].worktree?.current, false);
  assert.deepEqual(calls[0], ["--config-set", "list.json-schema=2", "list", "--format=json"]);

  const failing = createWorktrunkClient(async () => ({ code: 1, stderr: "needs approval" }));
  await assert.rejects(failing.list(process.cwd()), /wt list failed: needs approval.*approvals add/s);
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
    await tools.get("worktrunk").execute("call", { command: "switch", args: ["--create", "fix/parser"] }, undefined, undefined, { cwd: source, hasUI: true, ui: {} });
    await commands.get("wt").handler(sent[0].text.slice(4), {
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
    const destination = SessionManager.open(switched, sessions);
    assert.equal(destination.getCwd(), realpathSync(target));
    const transition = destination.getEntries().at(-1);
    assert.equal(transition?.type, "custom_message");
    if (transition?.type === "custom_message") {
      assert.equal(transition.customType, "pi-worktrunk");
      assert.equal(transition.content, "");
    }
    assert.equal(continuation.message.display, false);
    assert.equal(continuation.opts.triggerTurn, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("model list bypasses the picker and receives Worktrunk output", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-list-"));
  const source = join(root, "repo");
  await mkdir(join(source, ".git"), { recursive: true });
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const messages: Array<{ message: any; options: any }> = [];
  const sent: Array<{ text: string; options: any }> = [];
  try {
    extension(baseApi({ handlers, commands, tools, messages, sent, async exec(program, args) {
      if (program === "git") return { code: 0, stdout: `${join(source, ".git")}\n` };
      if (args[0] === "--help") return { code: 0, stdout: "" };
      if (args.length === 1 && args[0] === "list") return { code: 0, stdout: "main worktree" };
      if (args.includes("list")) return { code: 0, stdout: wtList(source) };
      return { code: 0, stdout: "" };
    } }));
    const manager = SessionManager.create(source, join(root, "sessions"));
    manager.appendSessionInfo("test");
    await handlers.get("session_start")({}, { cwd: source, sessionManager: manager });
    await tools.get("worktrunk").execute("call", { command: "list" }, undefined, undefined, {
      cwd: source, hasUI: true, ui: {},
    });
    await commands.get("wt").handler(sent[0].text.slice(4), {
      cwd: source, mode: "tui", hasUI: true, sessionManager: manager,
      async waitForIdle() {},
      ui: {
        notify() {},
        async select() { throw new Error("model list must not open a picker"); },
      },
    });
    assert.match(messages.at(-1)?.message.content ?? "", /completed successfully.*main worktree/s);
    assert.equal(messages.at(-1)?.options.triggerTurn, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("JSON mode runs exact argv without replacing the session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-json-"));
  const source = join(root, "repo");
  const target = join(root, "repo.main");
  await mkdir(join(source, ".git"), { recursive: true });
  await mkdir(target);
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const messages: Array<{ message: any; options: any }> = [];
  let switches = 0;
  const calls: string[][] = [];
  try {
    extension(baseApi({ handlers, commands, tools, messages, async exec(program, args) {
      if (program === "git") return { code: 0, stdout: `${join(source, ".git")}\n` };
      if (args[0] === "--help") return { code: 0, stdout: "" };
      if (args.includes("list")) return { code: 0, stdout: list([
        { branch: "feature", worktree: { path: source, current: true } },
        { branch: "main", worktree: { path: target, main: true } },
      ]) };
      calls.push([...args]);
      return { code: 0, stdout: "switched" };
    } }));
    const manager = SessionManager.create(source, join(root, "sessions"));
    manager.appendSessionInfo("test");
    await handlers.get("session_start")({}, { cwd: source, sessionManager: manager });
    await commands.get("wt").handler("-v switch main", {
      cwd: source, mode: "json", hasUI: false, sessionManager: manager,
      async waitForIdle() {}, async switchSession() { switches += 1; return { cancelled: false }; },
      ui: { notify() {} },
    });
    assert.deepEqual(calls.filter((args) => args[0] !== "config" && args[0] !== "--version"), [["-v", "switch", "main"]]);
    assert.equal(switches, 0);
    assert.equal(messages.at(-1)?.message.content, "switched");
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

test("a failed command that removes the cwd recovers and resumes with the failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-recovery-"));
  const main = join(root, "repo");
  const source = join(root, "repo.feature");
  const common = join(main, ".git");
  const sessions = join(root, "sessions");
  await mkdir(common, { recursive: true });
  await mkdir(source);
  const manager = SessionManager.create(source, sessions);
  manager.appendSessionInfo("test");
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  let switched = "";
  let continuation: any;
  const sent: Array<{ text: string; options: any }> = [];
  try {
    extension(baseApi({ handlers, commands, tools, sent, async exec(program, args) {
      if (program === "git" && args.includes("worktree")) {
        return { code: 0, stdout: `worktree ${main}\0HEAD aaaa\0branch refs/heads/main\0\0` };
      }
      if (program === "git") return { code: 0, stdout: `${common}\n` };
      if (args[0] === "--help") return { code: 0, stdout: "Aliases:\n  land\n" };
      if (args[0] === "config" && args[1] === "show") return { code: 0, stdout: "{}" };
      if (args.includes("list")) return { code: 0, stdout: list([
        { branch: "main", worktree: { path: main, main: true, current: !existsSync(source) } },
        ...(existsSync(source) ? [{ branch: "feature", worktree: { path: source, current: true } }] : []),
      ]) };
      if (args[0] === "land") {
        await rm(source, { recursive: true, force: true });
        return { code: 1, stderr: "land failed after cleanup" };
      }
      return { code: 0, stdout: "" };
    } }));
    await handlers.get("session_start")({}, { cwd: source, signal: undefined, sessionManager: manager });
    await tools.get("worktrunk").execute("call", { command: "land" }, undefined, undefined, {
      cwd: source, hasUI: false, ui: {},
    });
    await commands.get("wt").handler(sent[0].text.slice(4), {
      cwd: source, mode: "tui", hasUI: true, sessionManager: manager,
      async waitForIdle() {},
      async switchSession(path: string, options: any) {
        switched = path;
        await options.withSession({
          ui: { notify() {} },
          async sendMessage(message: any, sendOptions: any) {
            continuation = { message, options: sendOptions };
          },
        });
        return { cancelled: false };
      },
      ui: { notify() {} },
    });
    assert.equal(SessionManager.open(switched, sessions).getCwd(), realpathSync(main));
    assert.match(continuation.message.content, /failed \(exit 1\).*land failed after cleanup/s);
    assert.equal(continuation.options.triggerTurn, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("transition renderer keeps move and recovery variants compact", () => {
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const renderers = new Map<string, any>();
  extension(baseApi({ handlers, commands, tools, renderer: renderers, async exec() { return { code: 0, stdout: "" }; } }));
  const renderer = renderers.get("pi-worktrunk");
  assert.ok(renderers.has("pi-worktrunk-session-transition"));
  const theme = {
    fg(color: string, text: string) { return `<${color}>${text}</${color}>`; },
    bold(text: string) { return `<bold>${text}</bold>`; },
  };
  const message = { details: {
    kind: "move",
    source: { branch: "testing", path: "/code/testing" },
    target: { branch: "main", path: "/code/main" },
  } };
  assert.equal(
    renderer(message, { expanded: false, outputPad: 0 }, theme).render(200)[0].trimEnd(),
    "<text>↪ Session moved:</text> <accent><bold>testing</bold></accent> <text>→</text> <accent><bold>main</bold></accent>",
  );
  message.details.kind = "recovery";
  assert.match(renderer(message, { outputPad: 0 }, theme).render(200)[0], /↩ Session recovered:/);
});
