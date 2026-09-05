import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension, { parseDirectoryDirective, runDirectedWt } from "./worktrunk.ts";

const directiveScript = `
  const fs = require('node:fs');
  const file = process.env.WORKTRUNK_DIRECTIVE_CD_FILE;
  console.log(JSON.stringify({file, mode: fs.statSync(file).mode & 0o777, cwd: process.cwd(), shellCwd: process.env.WORKTRUNK_SHELL_CWD}));
  fs.writeFileSync(file, process.cwd() + '\\n');
`;

test("directive subprocess captures output, failure, and a private temporary reply", async () => {
  const result = await runDirectedWt(["-e", directiveScript + `console.error('hook failed'); process.exitCode = 7;`], { cwd: tmpdir() }, process.execPath);
  const reply = JSON.parse(result.stdout!);
  assert.equal(reply.mode, 0o600);
  assert.equal(reply.shellCwd, tmpdir());
  assert.equal(result.directive, `${reply.cwd}\n`);
  assert.equal(result.code, 7);
  assert.equal(result.stderr, "hook failed\n");
  assert.equal(existsSync(dirname(reply.file)), false);
});

test("directive subprocess isolates concurrent invocations", async () => {
  const results = await Promise.all([1, 2].map(() => runDirectedWt(["-e", directiveScript], {}, process.execPath)));
  assert.notEqual(JSON.parse(results[0].stdout!).file, JSON.parse(results[1].stdout!).file);
});

test("directive subprocess cleans up after spawn failure and pre-abort", async () => {
  const before = await readdir(tmpdir());
  const failed = await runDirectedWt([], {}, "/nonexistent/pi-worktrunk-test-binary");
  assert.equal(failed.code, -1);
  assert.match(failed.stderr!, /ENOENT/);
  const aborted = await runDirectedWt([], { signal: AbortSignal.abort() }, process.execPath);
  assert.equal(aborted.killed, true);
  const after = await readdir(tmpdir());
  assert.deepEqual(after.filter((name) => /^pi-worktrunk-[A-Za-z0-9]{6}$/.test(name) && !before.includes(name)), []);
});

for (const cancellation of ["timeout", "abort"] as const) {
  test(`directive subprocess retains its reply after ${cancellation}`, async () => {
    const options = cancellation === "timeout" ? { timeout: 500 } : { signal: AbortSignal.timeout(500) };
    const result = await runDirectedWt(["-e", directiveScript + "setInterval(() => {}, 1000);"], options, process.execPath);
    assert.equal(result.killed, true);
    const reply = JSON.parse(result.stdout!);
    assert.equal(result.directive, `${reply.cwd}\n`);
    assert.equal(existsSync(dirname(reply.file)), false);
  });
}

test("nested invocations share the reply and the last directory wins", async () => {
  const script = directiveScript + `
    require('node:child_process').execFileSync(process.execPath, ['-e',
      "require('node:fs').writeFileSync(process.env.WORKTRUNK_DIRECTIVE_CD_FILE, '/last destination\\\\n')"
    ]);
  `;
  const result = await runDirectedWt(["-e", script], {}, process.execPath);
  assert.equal(result.code, 0);
  assert.equal(result.directive, "/last destination\n");
});

test("detached descendants holding output handles do not block the reply", async () => {
  const script = directiveScript + `
    const child = require('node:child_process').spawn(process.execPath,
      ['-e', 'setTimeout(() => {}, 30000)'],
      { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    console.error(child.pid);
    child.unref();
  `;
  let pid: number | undefined;
  try {
    const result = await runDirectedWt(["-e", script], {}, process.execPath);
    pid = Number(result.stderr!.trim());
    assert.ok(pid > 0);
    // The descendant is still alive when the invocation returns.
    process.kill(pid, 0);
    assert.equal(result.code, 0);
    const reply = JSON.parse(result.stdout!);
    assert.equal(result.directive, `${reply.cwd}\n`);
    assert.equal(existsSync(dirname(reply.file)), false);
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
});

test("directive parsing preserves spaces and rejects malformed replies", () => {
  assert.equal(parseDirectoryDirective(""), undefined);
  assert.equal(parseDirectoryDirective("/a directory/with trailing space \n"), "/a directory/with trailing space ");
  for (const raw of ["relative\n", "/a\n/b\n", "/a\0", "\n"]) {
    assert.throws(() => parseDirectoryDirective(raw), /Rejected Worktrunk destination/);
  }
});

for (const scenario of [
  "land-placeholder", "subdirectory", "no-directive-creation", "no-directive-placeholder",
  "foreign-repository", "malformed", "cancel-switch", "same-directory",
] as const) {
  test(`session placement: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-directive-test-"));
    const source = join(root, "feature");
    const main = join(root, "main");
    const common = join(main, ".git");
    const foreign = join(root, "foreign-git");
    const target = scenario === "subdirectory" ? join(main, "src")
      : scenario === "no-directive-creation" ? join(root, "new-worktree") : main;
    await Promise.all([mkdir(source), mkdir(common, { recursive: true }), mkdir(foreign)]);
    if (scenario === "subdirectory") await mkdir(target);
    const manager = SessionManager.create(source, join(root, "sessions"));
    manager.appendSessionInfo("directive test");
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    const sent: string[] = [];
    const notifications: string[] = [];
    const continuations: any[] = [];
    let requested = "";
    let executed = false;
    try {
      extension({
        on() {},
        registerCommand(name: string, command: any) { commands.set(name, command); },
        registerTool(tool: any) { tools.set(tool.name, tool); },
        registerMessageRenderer() {},
        registerEntryRenderer() {},
        sendUserMessage(text: string) { sent.push(text); },
        sendMessage(message: any) { continuations.push(message); },
        async exec(program: string, args: string[], options: any) {
          if (program === "git") {
            if (args.includes("--is-inside-work-tree")) return { code: 0, stdout: "true\n" };
            if (executed && scenario === "no-directive-placeholder" && options.cwd === source) return { code: 1, stdout: "" };
            return { code: 0, stdout: `${scenario === "foreign-repository" && options.cwd === target ? foreign : common}\n` };
          }
          return { code: 0, stdout: JSON.stringify({ schema: 2, items: [
            { branch: "feature", worktree: { path: source, current: options.cwd === source } },
            ...(scenario === "no-directive-creation" && !executed ? [] : [
              { branch: "main", worktree: { path: scenario === "no-directive-creation" ? target : main, main: true, current: options.cwd === target } },
            ]),
          ] }) };
        },
      } as any, async () => {
        executed = true;
        if (scenario === "no-directive-creation") await mkdir(target);
        const directive = scenario.startsWith("no-directive") ? ""
          : scenario === "malformed" ? "/one\n/two\n"
          : `${scenario === "same-directory" ? source : target}\n`;
        return { code: 0, stdout: "land completed", directive };
      });
      await tools.get("worktrunk").execute("call",
        scenario === "no-directive-creation" ? { command: "switch", args: ["--create", "--no-cd", "new-worktree"] } : { command: "land" },
        undefined, undefined, { mode: "tui", cwd: source });
      await commands.get("wt").handler(sent[0].slice(4), {
        mode: "tui", cwd: source, hasUI: true, sessionManager: manager,
        async waitForIdle() {},
        ui: { notify(text: string) { notifications.push(text); } },
        async switchSession(path: string, options: any) {
          requested = path;
          if (scenario === "cancel-switch") return { cancelled: true };
          await options.withSession({ async sendMessage(message: any) { continuations.push(message); } });
          return { cancelled: false };
        },
      });
      assert.equal(existsSync(source), true);
      if (["land-placeholder", "subdirectory"].includes(scenario)) {
        const destination = SessionManager.open(requested, join(root, "sessions"));
        assert.equal(destination.getCwd(), target);
        assert.equal(continuations.length, 1);
        const details = (destination.getEntries().at(-1) as any).details;
        assert.equal(details.target.branch, "main");
        assert.equal("trail" in details, false);
      } else if (scenario === "cancel-switch") {
        assert.ok(requested);
        assert.equal(continuations.length, 1);
        assert.match(continuations[0].content, /session switching was cancelled/);
        assert.match(notifications.join("\n"), /cancelled/);
      } else {
        assert.equal(requested, "");
        if (["foreign-repository", "malformed"].includes(scenario)) {
          assert.match(notifications.join("\n"), /Rejected Worktrunk destination/);
          assert.equal(continuations.length, 1);
          assert.match(continuations[0].content, /Rejected Worktrunk destination/);
        }
        if (scenario === "no-directive-placeholder") {
          assert.match(notifications.join("\n"), /no longer usable/);
          assert.equal(continuations.length, 0);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
