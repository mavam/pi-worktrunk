import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "./worktrunk.ts";

for (const scenario of ["exit", "spawn", "directive", "switch", "preflight"] as const) {
  for (const mode of ["tui", "rpc"] as const) {
    test(`${mode} resumes the model after ${scenario} failure`, async () => {
      const root = await mkdtemp(join(tmpdir(), "wt-errors-"));
      try {
        const source = join(root, "source");
        const target = join(root, "target");
        const common = join(source, ".git");
        await mkdir(common, { recursive: true });
        await mkdir(target);
        const manager = SessionManager.create(source, join(root, "sessions"));
        manager.appendSessionInfo("test");
        const commands = new Map<string, any>();
        const tools = new Map<string, any>();
        const sent: string[] = [];
        const messages: any[] = [];
        let invocations = 0;
        extension({
          on() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
          registerCommand(name: string, definition: any) { commands.set(name, definition); },
          registerTool(definition: any) { tools.set(definition.name, definition); },
          sendUserMessage(text: string) { sent.push(text); },
          sendMessage(message: any, options: any) { messages.push({ message, options }); },
          async exec(program: string, args: string[]) {
            if (program === "git") return { code: 0, stdout: args.includes("--is-inside-work-tree") ? "true\n" : common };
            return { code: 0, stdout: JSON.stringify({ schema: 2, items: [] }) };
          },
        } as any, async () => {
          invocations++;
          if (scenario === "spawn") throw new Error("spawn failed");
          return {
            code: scenario === "exit" ? 2 : 0,
            stdout: "command output",
            stderr: scenario === "exit" ? "invalid argument" : "",
            directive: scenario === "directive" ? "not-an-absolute-path\n" : scenario === "switch" ? `${target}\n` : undefined,
          };
        });
        const ctx = {
          mode, cwd: source, hasUI: true, sessionManager: manager,
          ui: { notify() {} },
          async waitForIdle() { if (scenario === "preflight") throw new Error("preflight failed"); },
          async switchSession() { return { cancelled: true }; },
        };
        const tool = tools.get("worktrunk");
        await tool.execute("first", { command: "switch", args: ["topic"] }, undefined, undefined, ctx);
        await commands.get("wt").handler(sent[0].slice(4), ctx);
        assert.equal(invocations, scenario === "preflight" ? 0 : 1);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].options.triggerTurn, true);
        assert.match(messages[0].message.content, /failed \(exit/);
        assert.match(messages[0].message.content, /Read the error and adapt/);
        const expected = { exit: /invalid argument/, spawn: /spawn failed/, directive: /Rejected Worktrunk destination/, switch: /session switching was cancelled/, preflight: /preflight failed/ };
        assert.match(messages[0].message.content, expected[scenario]);
        if (scenario === "directive" || scenario === "switch") assert.match(messages[0].message.content, /command output/);
        // Recovery must release the pending-invocation guard.
        await assert.doesNotReject(tool.execute("retry", { command: "list" }, undefined, undefined, ctx));
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
}

for (const mode of ["print", "json"] as const) {
  test(`${mode} reports an invalid directive without aborting a usable session`, async () => {
    const root = await mkdtemp(join(tmpdir(), "wt-errors-"));
    try {
      const tools = new Map<string, any>();
      let aborted = false;
      extension({
        on() {}, registerCommand() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
        registerTool(definition: any) { tools.set(definition.name, definition); },
        async exec(_program: string, args: string[]) {
          return { code: 0, stdout: args.includes("--is-inside-work-tree") ? "true\n" : root };
        },
      } as any, async () => ({ code: 1, stderr: "hook failed", directive: "invalid\n" }));
      await assert.rejects(tools.get("worktrunk").execute("call", { command: "land" }, undefined, undefined, {
        mode, cwd: root, abort() { aborted = true; },
      }), /hook failed.*Rejected Worktrunk destination/s);
      assert.equal(aborted, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
