import assert from "node:assert/strict";
import { hostname } from "node:os";
import test from "node:test";
import extension, { createTerminalCwdReporter, formatTerminalCwd } from "./worktrunk.ts";

function stream(isTTY = true) {
  const writes: string[] = [];
  return { writes, isTTY, write(data: string) { writes.push(data); return true; } };
}

const tui = (cwd: string) => ({ mode: "tui" as const, hasUI: true, cwd });

test("formatTerminalCwd emits an OSC 7 file URI with the host", () => {
  assert.equal(formatTerminalCwd("/repo/worktree-b", "my-host"), "\x1b]7;file://my-host/repo/worktree-b\x07");
});

test("formatTerminalCwd percent-encodes path characters and escape injection", () => {
  const sequence = formatTerminalCwd("/a b/#x?y%z/ü/\x07\x1b]0;title", "host");
  assert.equal(sequence, "\x1b]7;file://host/a%20b/%23x%3Fy%25z/%C3%BC/%07%1B%5D0;title\x07");
  // Only the terminator may contain control characters.
  assert.doesNotMatch(sequence.slice(2, -1), /[\x00-\x1f\x7f]/);
});

test("formatTerminalCwd drops hosts that are not valid URL authorities", () => {
  assert.equal(formatTerminalCwd("/tmp", "bad host\x07"), "\x1b]7;file:///tmp\x07");
});

test("reporter only writes in the TUI on a terminal", () => {
  for (const [ctx, isTTY, env, platform] of [
    [{ mode: "rpc", hasUI: true, cwd: "/b" }, true, {}, "darwin"],
    [{ mode: "print", hasUI: false, cwd: "/b" }, true, {}, "darwin"],
    [{ mode: "json", hasUI: false, cwd: "/b" }, true, {}, "darwin"],
    [tui("/b"), false, {}, "darwin"],
    [tui("/b"), true, { TERM: "dumb" }, "darwin"],
    [tui("/b"), true, {}, "win32"],
  ] as const) {
    const out = stream(isTTY);
    const reporter = createTerminalCwdReporter(out, env, platform);
    reporter.publish(ctx as any);
    reporter.restore(ctx as any, "quit");
    assert.deepEqual(out.writes, [], `${ctx.mode} tty=${isTTY} ${JSON.stringify(env)} ${platform}`);
  }
});

test("reporter tolerates write failures", () => {
  const reporter = createTerminalCwdReporter({ isTTY: true, write() { throw new Error("EPIPE"); } }, {}, "darwin");
  assert.doesNotThrow(() => reporter.publish(tui("/b")));
});

test("session transitions report each destination and restore only on quit", async () => {
  const events = new Map<string, any>();
  const out = stream();
  extension({
    on(name: string, handler: any) { events.set(name, handler); },
    registerCommand() {},
    registerTool() {},
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    async exec() { return { code: 1, stdout: "", stderr: "not a repository" }; },
  } as any, async () => ({ code: 1, stdout: "", stderr: "unused", directive: "" }),
  createTerminalCwdReporter(out, {}, "darwin"));

  const launch = process.cwd();
  const host = hostname();
  const start = (cwd: string) => events.get("session_start")({ type: "session_start", reason: "startup" }, tui(cwd));
  const shutdown = (cwd: string, reason: string) => events.get("session_shutdown")({ type: "session_shutdown", reason }, tui(cwd));

  await start("/repo/a");
  await shutdown("/repo/a", "resume");
  await start("/repo/b");
  await shutdown("/repo/b", "reload");
  await start("/repo/c");
  await shutdown("/repo/c", "quit");

  assert.deepEqual(out.writes, [
    formatTerminalCwd("/repo/a", host),
    formatTerminalCwd("/repo/b", host),
    formatTerminalCwd("/repo/c", host),
    formatTerminalCwd(launch, host),
  ]);
});
