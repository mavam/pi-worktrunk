import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Box } from "@earendil-works/pi-tui";
import extension from "./worktrunk.ts";

const entryType = "pi-worktrunk-command-result";

for (const scenario of ["success", "empty", "failure", "killed", "throw", "move", "model", "json", "large"] as const) {
  test(`slash command display: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "wt-display-"));
    try {
      const source = join(root, "source");
      const target = join(root, "target");
      const common = join(source, ".git");
      await mkdir(common, { recursive: true });
      await mkdir(target);
      const manager = SessionManager.create(source, join(root, "sessions"));
      const commands = new Map<string, any>();
      const tools = new Map<string, any>();
      const renderers = new Map<string, any>();
      const entries: any[] = [];
      const notifications: string[] = [];
      const messages: any[] = [];
      const sent: string[] = [];
      const invocations: string[][] = [];
      let switched = "";
      extension({
        on() {},
        registerCommand(name: string, definition: any) { commands.set(name, definition); },
        registerTool(definition: any) { tools.set(definition.name, definition); },
        registerMessageRenderer() {},
        registerEntryRenderer(name: string, renderer: any) { renderers.set(name, renderer); },
        appendEntry(customType: string, data: any) {
          entries.push({ customType, data });
          manager.appendCustomEntry(customType, data);
        },
        sendMessage(message: any) { messages.push(message); },
        sendUserMessage(text: string) { sent.push(text); },
        async exec(program: string, args: string[], options: any) {
          if (program === "git") return { code: 0, stdout: args.includes("--is-inside-work-tree") ? "true\n" : common };
          if (args[0] === "list") return { code: 0, stdout: JSON.stringify({ schema: 2, items: [
            { branch: options.cwd === source ? "topic" : "main", worktree: { current: true, path: options.cwd } },
          ] }) };
          return { code: 0, stdout: "" };
        },
      } as any, async (args) => {
        invocations.push(args);
        if (scenario === "throw") throw new Error("spawn failed");
        return {
          code: scenario === "failure" ? 1 : 0,
          killed: scenario === "killed",
          stdout: scenario === "empty" ? "" : scenario === "large" ? "x".repeat(100_000) : "Fast-forward",
          stderr: scenario === "failure" ? "merge failed" : "",
          directive: scenario === "move" ? `${target}\n` : undefined,
        };
      });
      const ctx = {
        mode: scenario === "json" ? "json" : "tui", cwd: source, hasUI: scenario !== "json",
        sessionManager: manager,
        async waitForIdle() {},
        async switchSession(path: string) { switched = path; return { cancelled: false }; },
        ui: { notify(text: string) { notifications.push(text); } },
      };
      let input = "land";
      if (scenario === "model") {
        await tools.get("worktrunk").execute("call", { command: "land" }, undefined, undefined, ctx);
        input = sent[0].slice(4);
      }
      await commands.get("wt").handler(input, ctx);
      assert.deepEqual(invocations, [["land"]]);
      if (scenario === "model" || scenario === "json") {
        assert.equal(entries.length, 0);
        if (scenario === "model") assert.deepEqual(notifications, ["Fast-forward"]);
        assert.match(messages.at(-1).content, /Fast-forward/);
        return;
      }
      assert.equal(entries.length, 1);
      assert.equal(entries[0].customType, entryType);
      assert.deepEqual(entries[0].data.args, ["land"]);
      assert.equal(entries[0].data.isError, ["failure", "killed", "throw"].includes(scenario));
      assert.equal(messages.length, 0, "slash cards must not enter model context or trigger turns");
      assert.deepEqual(notifications, [], "output must not also appear as a notification");
      if (scenario === "empty") assert.equal(entries[0].data.output, "");
      if (scenario === "failure") assert.equal(entries[0].data.output, "Fast-forward\nmerge failed");
      if (scenario === "throw") assert.equal(entries[0].data.output, "spawn failed");
      if (scenario === "large") {
        assert.ok(entries[0].data.output.length < 100_000);
        assert.match(entries[0].data.output, /output truncated/);
      }
      const backgrounds: string[] = [];
      const theme = {
        fg(_color: string, text: string) { return text; },
        bold(text: string) { return text; },
        bg(color: string, text: string) { backgrounds.push(color); return text; },
      };
      const card = renderers.get(entryType)(entries[0], { expanded: false }, theme);
      const expected = new Box(1, 1);
      expected.addChild(tools.get("worktrunk").renderCall({ command: "land" }, theme));
      expected.addChild(tools.get("worktrunk").renderResult({
        content: [{ type: "text", text: entries[0].data.output }], details: { code: 0 },
      }, {}, theme, { isError: entries[0].data.isError }));
      assert.deepEqual(card.render(80), expected.render(80));
      assert.ok(backgrounds.every((color) => color === (entries[0].data.isError ? "toolErrorBg" : "toolSuccessBg")));
      if (scenario === "move") {
        const destination = SessionManager.open(switched);
        assert.equal(destination.getCwd(), target);
        const copied = destination.getEntries().find((entry) => entry.type === "custom" && entry.customType === entryType);
        assert.ok(copied && copied.type === "custom");
        assert.deepEqual(copied.data, entries[0].data);
        assert.deepEqual(renderers.get(entryType)(copied, {}, theme).render(80), card.render(80));
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
