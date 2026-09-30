import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader,
  ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import extension, { canRunInline, parseWtInvocation } from "./worktrunk.ts";

type Invoke = NonNullable<Parameters<typeof extension>[1]>;

async function withTool(invoke: Invoke, run: (h: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "wt-codemode-"));
  try {
    const common = join(root, ".git");
    await mkdir(common);
    let tool: any;
    const handlers = new Map<string, any>();
    const sent: string[] = [];
    const api: any = {
      on(name: string, handler: any) { handlers.set(name, handler); },
      registerCommand() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
      registerTool(definition: any) { tool = definition; },
      sendUserMessage(text: string) { sent.push(text); },
      async exec(program: string, args: string[]) {
        if (program === "git") return { code: 0, stdout: args.includes("--is-inside-work-tree") ? "true\n" : common };
        return { code: 1, stdout: "" };
      },
    };
    extension(api, invoke);
    const ctx = { mode: "tui", cwd: root, hasUI: false, abort() {} };
    await run({ tool, ctx, sent, handlers, api });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("only known inspection commands run inline", () => {
  for (const input of ["list --format=json", "config show", "config alias show land", "config approvals list", "config state vars get env", "step diff --branch topic", "hook show"]) {
    assert.equal(canRunInline(parseWtInvocation(input), false), true, input);
    assert.equal(canRunInline(parseWtInvocation(input), true), false, `alias ${input}`);
  }
  for (const input of ["switch main", "merge", "remove topic", "land", "doctor", "step commit", "step for-each -- wt switch main", "hook post-switch", "config state marker set x", "config approvals add", "config state cache clear"]) {
    assert.equal(canRunInline(parseWtInvocation(input), false), false, input);
  }
});

for (const mode of ["tui", "rpc", "print", "json"]) {
  test(`${mode} inspection results have a valid schema and parsed stdout`, async () => {
    const data = { schema: 2, items: [{ branch: "main" }] };
    await withTool(async () => ({ code: 0, stdout: JSON.stringify(data), stderr: "warning" }), async ({ tool, ctx, sent }) => {
      const result = await tool.execute("call", { command: "list", args: ["--format=json"] }, undefined, undefined, { ...ctx, mode });
      assert.equal(Check(tool.outputSchema, result.structuredContent), true);
      assert.deepEqual(result.structuredContent, {
        status: "completed", args: ["list", "--format=json"], cwd: ctx.cwd,
        code: 0, output: `${JSON.stringify(data)}\nwarning`, truncated: false, data,
      });
      assert.equal(result.terminate, undefined);
      assert.deepEqual(sent, []);
    });
  });
}

test("scalar stdout stays in output and is not exposed as data", async () => {
  for (const stdout of ["42", "true", "null", '"text"']) {
    await withTool(async () => ({ code: 0, stdout }), async ({ tool, ctx }) => {
      const result = await tool.execute("call", { command: "config", args: ["state", "vars", "get", "x"] }, undefined, undefined, ctx);
      assert.equal(result.structuredContent.output, stdout);
      assert.equal("data" in result.structuredContent, false, stdout);
      assert.equal(Check(tool.outputSchema, result.structuredContent), true);
    });
  }
  await withTool(async () => ({ code: 0, stdout: "[1,2]" }), async ({ tool, ctx }) => {
    const result = await tool.execute("call", { command: "list" }, undefined, undefined, ctx);
    assert.deepEqual(result.structuredContent.data, [1, 2]);
  });
});

test("failure results retain machine-readable diagnostics", async () => {
  await withTool(async () => ({ code: 7, stdout: '{"reason":"conflict"}', stderr: "failed" }), async ({ tool, ctx }) => {
    const result = await tool.execute("call", { command: "list" }, undefined, undefined, ctx);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, "failed");
    assert.equal(result.structuredContent.code, 7);
    assert.deepEqual(result.structuredContent.data, { reason: "conflict" });
    assert.match(result.structuredContent.output, /failed/);
    assert.equal(Check(tool.outputSchema, result.structuredContent), true);
  });
});

test("bounded output does not leak oversized JSON through data", async () => {
  await withTool(async () => ({ code: 0, stdout: JSON.stringify({ value: "x".repeat(50_001) }) }), async ({ tool, ctx }) => {
    const result = await tool.execute("call", { command: "list" }, undefined, undefined, ctx);
    assert.equal(result.structuredContent.truncated, true);
    assert.match(result.structuredContent.output, /\[output truncated\]$/);
    assert.equal(result.structuredContent.data, undefined);
    assert.equal(result.structuredContent.output, result.content[0].text);
  });
});

test("overlapping inline calls reject before launching a second command and release the guard", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  await withTool(async () => { calls++; await pending; return { code: 0, stdout: "done" }; }, async ({ tool, ctx }) => {
    const first = tool.execute("first", { command: "list" }, undefined, undefined, ctx);
    try {
      await assert.rejects(tool.execute("second", { command: "list" }, undefined, undefined, ctx), /run sequentially/);
    } finally { release(); }
    await first;
    assert.equal(calls, 1);
    await tool.execute("third", { command: "list" }, undefined, undefined, ctx);
    assert.equal(calls, 2);
  });
});

test("inline calls use the nested operation signal and release the guard after cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  await withTool(async (_args, options) => {
    calls++;
    if (calls > 1) return { code: 0, stdout: "retried" };
    assert.equal(options?.signal, controller.signal);
    controller.abort();
    return { code: -1, killed: true };
  }, async ({ tool, ctx }) => {
    const result = await tool.execute("call", { command: "list" }, controller.signal, undefined, { ...ctx, signal: controller.signal });
    assert.equal(result.structuredContent.status, "failed");
    assert.match(result.structuredContent.output, /cancelled/);
    await assert.rejects(tool.execute("aborted", { command: "list" }, controller.signal, undefined, ctx), /abort/i);
    assert.equal(calls, 1);
    const retry = await tool.execute("retry", { command: "list" }, undefined, undefined, ctx);
    assert.equal(retry.structuredContent.status, "completed");
    assert.equal(calls, 2);
  });
});

test("spawn failures return diagnostics and release the inline guard", async () => {
  let calls = 0;
  await withTool(async () => {
    if (++calls === 1) throw new Error("spawn wt ENOENT");
    return { code: 0, stdout: "retried" };
  }, async ({ tool, ctx }) => {
    const failed = await tool.execute("first", { command: "list" }, undefined, undefined, ctx);
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent.status, "failed");
    assert.match(failed.structuredContent.output, /Could not start Worktrunk/);
    const retry = await tool.execute("retry", { command: "list" }, undefined, undefined, ctx);
    assert.equal(retry.structuredContent.status, "completed");
  });
});

test("stopped results identify unusable workspaces and conform to the schema", async () => {
  await withTool(async (_args, options) => {
    await rm(join(options!.cwd!, ".git"), { recursive: true });
    return { code: 0, stdout: "removed" };
  }, async ({ tool, ctx }) => {
    let aborted = false;
    const result = await tool.execute("remove", { command: "remove" }, undefined, undefined,
      { ...ctx, mode: "print", abort() { aborted = true; } });
    assert.equal(result.structuredContent.status, "stopped");
    assert.equal(result.terminate, true);
    assert.equal(aborted, true);
    assert.equal(Check(tool.outputSchema, result.structuredContent), true);
  });
});

test("queued commands are explicit handoffs and block dependent tools until the run ends", async () => {
  let calls = 0;
  await withTool(async () => { calls++; return { code: 0 }; }, async ({ tool, ctx, sent, handlers }) => {
    assert.equal(handlers.get("tool_call")({ toolName: "bash" }, ctx), undefined, "nothing queued yet");
    const result = await tool.execute("call", { command: "switch", args: ["main"] }, undefined, undefined, ctx);
    assert.equal(result.structuredContent.status, "queued");
    assert.equal(result.structuredContent.code, undefined);
    assert.equal(result.terminate, true);
    assert.equal(Check(tool.outputSchema, result.structuredContent), true);
    assert.equal(calls, 0);
    assert.equal(sent.length, 1);
    const blocked = handlers.get("tool_call")({ toolName: "bash", parentToolCallId: "script" }, ctx);
    assert.equal(blocked.block, true);
    assert.equal(blocked.terminate, true);
    assert.match(blocked.reason, /has not run yet/);
    // The block ends with the run, even if the queued follow-up never arrives.
    await handlers.get("agent_end")({}, { cwd: ctx.cwd });
    assert.equal(handlers.get("tool_call")({ toolName: "bash" }, ctx), undefined);
  });
});

test("session shutdown releases the handoff block", async () => {
  await withTool(async () => ({ code: 0 }), async ({ tool, ctx, handlers }) => {
    await tool.execute("call", { command: "switch", args: ["main"] }, undefined, undefined, ctx);
    assert.equal(handlers.get("tool_call")({ toolName: "bash" }, ctx).block, true);
    await handlers.get("session_shutdown")({}, { cwd: ctx.cwd });
    assert.equal(handlers.get("tool_call")({ toolName: "bash" }, ctx), undefined);
  });
});

test("a failed handoff does not leave tools blocked", async () => {
  await withTool(async () => ({ code: 0 }), async ({ tool, ctx, handlers, api }) => {
    api.sendUserMessage = () => { throw new Error("cannot queue"); };
    await assert.rejects(tool.execute("call", { command: "switch", args: ["main"] }, undefined, undefined, ctx), /cannot queue/);
    assert.equal(handlers.get("tool_call")({ toolName: "bash" }, ctx), undefined);
  });
});

async function runScript(code: string, invoke: Invoke) {
  const root = await mkdtemp(join(tmpdir(), "wt-codemode-sdk-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const common = join(root, ".git");
    await mkdir(common);
    const sent: string[] = [];
    let dependentCalls = 0;
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        createCodemodeExtension({ mode: "only", models: false }),
        (pi) => extension({ ...pi,
          sendUserMessage(text: string) { sent.push(text); },
          async exec(program: string, args: string[]) {
            if (program === "git") return { code: 0, stdout: args.includes("--is-inside-work-tree") ? "true\n" : common, stderr: "", killed: false };
            return { code: 1, stdout: "", stderr: "", killed: false };
          },
        }, invoke),
        (pi) => pi.registerTool({
          name: "dependent", label: "Dependent", description: "Must not run during a handoff",
          parameters: Type.Object({}),
          async execute() { dependentCalls++; return { content: [{ type: "text", text: "ran" }], details: {} }; },
        }),
      ],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const faux = fauxProvider({ models: [{ id: "test" }] });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "script" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    ({ session } = await createAgentSession({
      cwd: root, agentDir: root, model: faux.getModel(), modelRuntime, resourceLoader, settingsManager,
      noTools: "builtin", tools: ["codemode", "worktrunk", "dependent"], sessionManager: SessionManager.inMemory(root),
    }));
    await session.bindExtensions({ mode: "tui" });
    await session.prompt("run the script");
    const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
    assert.ok(result && result.role === "toolResult");
    return { result, sent, dependentCalls };
  } finally {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

test("actual codemode scripts receive objects for success and failure and can chain inspections", async () => {
  let calls = 0;
  const { result } = await runScript(`
    const first = await tools.worktrunk({command: "list", args: ["--format=json"]});
    const second = await tools.worktrunk({command: "config", args: ["show"]});
    text({branch: first.data.items[0].branch, status: second.status, code: second.code});
  `, async () => ++calls === 1
    ? { code: 0, stdout: '{"items":[{"branch":"main"}]}' }
    : { code: 4, stderr: "config failed" });
  assert.equal(result.isError, false);
  assert.match(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), /"branch":"main","status":"failed","code":4/);
  assert.equal(calls, 2);
});

test("actual codemode handoffs block tools that try to use the old workspace", async () => {
  let calls = 0;
  const { result, sent, dependentCalls } = await runScript(`
    const result = await tools.worktrunk({command: "switch", args: ["main"]});
    text(result.status);
    try { await tools.dependent({}); } catch (error) { text(error.message); }
  `, async () => { calls++; return { code: 0 }; });
  assert.equal(result.isError, false);
  const output = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  assert.match(output, /queued/);
  assert.match(output, /has not run yet/);
  assert.equal(sent.length, 1);
  assert.equal(calls, 0);
  assert.equal(dependentCalls, 0);
});
