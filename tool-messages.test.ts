import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension, { aliasFailureSummary, mayChangeWorktree, parseWtInvocation } from "./worktrunk.ts";

test("mayChangeWorktree is true only for switching, removing, and alias commands", () => {
  const check = (input: string, alias = false, directive?: string) =>
    mayChangeWorktree(parseWtInvocation(input), alias, directive);
  assert.equal(check("config alias show land"), false);
  assert.equal(check("list"), false);
  assert.equal(check("step diff"), false);
  assert.equal(check("switch topic"), true);
  assert.equal(check("remove topic"), true);
  assert.equal(check("merge"), true);
  assert.equal(check("step prune"), true);
  assert.equal(check("land", true), true);
  assert.equal(check("list", false, "/tmp/x\n"), true);
});

test("aliasFailureSummary reports steps and exit code", () => {
  const output = "◎ Running alias land: merge-pr, verify, sync-main\nboom";
  const summary = aliasFailureSummary(parseWtInvocation("land"), output, 3)!;
  assert.match(summary, /exit code 3/);
  assert.match(summary, /merge-pr -> verify -> sync-main/);
  assert.match(
    aliasFailureSummary(parseWtInvocation("demo"), "◎ Running alias demo: only", 2)!,
    /failed in step `only` with exit code 2/,
  );
  assert.equal(aliasFailureSummary(parseWtInvocation("list"), "boom", 1), undefined);
});

async function continuationFor(args: string[], stdout: string, code = 0, stderr = "") {
  const root = await mkdtemp(join(tmpdir(), "wt-msg-"));
  try {
    const source = join(root, "source");
    const common = join(source, ".git");
    await mkdir(common, { recursive: true });
    const manager = SessionManager.create(source, join(root, "sessions"));
    manager.appendSessionInfo("test");
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    const sent: string[] = [];
    const messages: any[] = [];
    extension({
      on() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
      registerCommand(name: string, definition: any) { commands.set(name, definition); },
      registerTool(definition: any) { tools.set(definition.name, definition); },
      sendUserMessage(text: string) { sent.push(text); },
      sendMessage(message: any) { messages.push(message); },
      async exec(program: string, a: string[]) {
        if (program === "git") return { code: 0, stdout: a.includes("--is-inside-work-tree") ? "true\n" : common };
        return { code: 0, stdout: JSON.stringify({ schema: 2, items: [] }) };
      },
    } as any, async () => ({ code, stdout, stderr }));
    const ctx = {
      mode: "tui", cwd: source, hasUI: true, sessionManager: manager,
      ui: { notify() {}, setWidget() {} }, async waitForIdle() {},
      async switchSession() { return { cancelled: true }; },
    };
    const [command, ...rest] = args;
    const result = await tools.get("worktrunk").execute("call", { command, args: rest }, undefined, undefined, ctx);
    if (!sent.length) return result.content[0].text as string;
    await commands.get("wt").handler(sent[0].slice(4), ctx);
    return messages[0].content as string;
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("read-only success returns output without a worktree continuation", async () => {
  const content = await continuationFor(["config", "alias", "show", "land"], "template");
  assert.equal(content, "template");
});

test("failed alias continuation names the steps and exit code", async () => {
  const content = await continuationFor(
    ["config", "state", "get"], "", 0);
  assert.doesNotMatch(content, /exit code/);
  const failed = await continuationFor(["land"], "◎ Running alias land: verify, cleanup\n", 4, "bad");
  assert.match(failed, /Alias `land` failed with exit code 4/);
  assert.match(failed, /verify -> cleanup/);
});

test("tool description and pending error say calls must be sequential", async () => {
  const tools = new Map<string, any>();
  extension({
    on() {}, registerCommand() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
    registerTool(definition: any) { tools.set(definition.name, definition); },
    sendUserMessage() {},
    async exec(_p: string, a: string[]) { return { code: 0, stdout: a.includes("--is-inside-work-tree") ? "true\n" : "/tmp" }; },
  } as any, async () => ({ code: 0, stdout: "" }));
  const tool = tools.get("worktrunk");
  assert.match(tool.description, /Calls must be sequential/);
  const ctx = { cwd: process.cwd(), hasUI: false, ui: {} };
  await tool.execute("a", { command: "land" }, undefined, undefined, ctx);
  await assert.rejects(tool.execute("b", { command: "list" }, undefined, undefined, ctx), /run sequentially/);
});
