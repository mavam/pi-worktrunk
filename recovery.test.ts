import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "./worktrunk.ts";

type Options = {
  mode?: "tui" | "rpc" | "print" | "json";
  code?: number;
  deleteDuringRun?: boolean;
  directive?: "valid" | "foreign" | "malformed";
  cancel?: boolean;
  ephemeral?: boolean;
  foreignMain?: boolean;
};

async function fixture(options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-recovery-test-"));
  const source = join(root, "feature");
  const main = join(root, "main");
  const other = join(root, "other");
  // Keep repository metadata outside the worktrees so removing main does not
  // accidentally remove the identity shared by surviving candidates.
  const common = join(root, "common.git");
  const foreign = join(root, "foreign.git");
  await Promise.all([source, main, other, common, foreign].map((path) => mkdir(path)));
  const sessionDir = join(root, "sessions");
  const manager = SessionManager.create(source, sessionDir);
  manager.appendSessionInfo("deleted-worktree recovery test");
  let foreignSource = false;
  let abortProbe = false;
  let failList = false;
  const controller = new AbortController();
  const events = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const sent: string[] = [];
  const messages: any[] = [];
  const continuations: any[] = [];
  const notifications: string[] = [];
  const invocations: string[][] = [];
  const probes: string[] = [];
  const switches: string[] = [];
  const mode = options.mode ?? "tui";
  const items = (cwd: string) => [
    { branch: "feature", worktree: { path: source, current: cwd === source } },
    // Deliberately put another survivor before main: main must win regardless
    // of the list order.
    { branch: "other", worktree: { path: other, current: cwd === other } },
    { branch: "main", worktree: { path: main, main: true, current: cwd === main } },
  ];
  extension({
    on(name: string, handler: any) { events.set(name, handler); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    sendUserMessage(text: string) { sent.push(text); },
    sendMessage(message: any) {
      messages.push(message);
      if (message.display === false) continuations.push(message);
    },
    async exec(program: string, args: string[], execOptions: any) {
      const cwd = execOptions?.cwd;
      probes.push(`${program} ${args.join(" ")} @ ${cwd}`);
      if (program === "git" && abortProbe) {
        abortProbe = false;
        controller.abort();
        return { code: 1, stdout: "", stderr: "probe aborted", killed: true };
      }
      if (!existsSync(cwd)) return { code: 1, stdout: "", stderr: "working directory missing" };
      if (program === "git") {
        if (args.includes("--is-inside-work-tree")) return { code: 0, stdout: "true\n" };
        return { code: 0, stdout: `${(options.foreignMain && cwd === main) || (foreignSource && cwd === source) ? foreign : common}\n` };
      }
      if (args.includes("list") && failList) {
        failList = false;
        return { code: 1, stdout: "", stderr: "temporary list failure" };
      }
      return { code: 0, stdout: JSON.stringify({ schema: 2, items: items(cwd) }) };
    },
  } as any, async (args: string[]) => {
    invocations.push([...args]);
    if (args[0] === "list") return { code: 0, stdout: JSON.stringify({ schema: 2, items: items(source) }), directive: "" };
    if (options.deleteDuringRun) await rm(source, { recursive: true, force: true });
    const directive = options.directive === "valid" ? `${other}\n`
      : options.directive === "foreign" ? `${main}\n`
      : options.directive === "malformed" ? "/one\n/two\n" : "";
    return { code: options.code ?? 0, stdout: "command output retained", stderr: options.code ? "hook failed after deletion" : "", directive };
  });
  const ctx: any = {
    mode, cwd: source, hasUI: mode === "tui", signal: controller.signal,
    sessionManager: options.ephemeral ? { getSessionFile() { return undefined; } } : manager,
    abort() {},
    async waitForIdle() {},
    ui: { notify(text: string) { notifications.push(text); }, setWidget() {} },
    async switchSession(path: string, switchOptions: any) {
      switches.push(path);
      if (options.cancel) return { cancelled: true };
      await switchOptions.withSession({ async sendMessage(message: any) { continuations.push(message); } });
      return { cancelled: false };
    },
  };
  return {
    root, source, main, other, invocations, probes, switches, continuations, notifications, messages,
    abortNextProbe() { abortProbe = true; },
    failNextList() { failList = true; },
    async startup() { await events.get("session_start")({}, ctx); },
    async replaceSource() {
      await rename(source, join(root, "old-feature"));
      await mkdir(source);
      foreignSource = true;
    },
    async replaceIdentity() {
      // Keep the original inode allocated so the new directory cannot reuse it.
      await rename(common, join(root, "old-common.git"));
      await mkdir(common);
    },
    async seed() {
      await commands.get("wt").handler("list --format=json", ctx);
      invocations.length = 0;
      probes.length = 0;
      messages.length = 0;
      notifications.length = 0;
    },
    async slash(command = "land") { await commands.get("wt").handler(command, ctx); },
    async model(command = "land", args?: string[]) {
      const count = sent.length;
      const result = await tools.get("worktrunk").execute("call", { command, ...(args ? { args } : {}) }, undefined, undefined, ctx);
      assert.equal(sent.length, count + 1, "model call must queue a slash continuation");
      assert.equal(invocations.length, 0, "queueing must not spawn Worktrunk");
      await commands.get("wt").handler(sent.at(-1)!.slice(4), ctx);
      return result;
    },
    async tool(command = "land") { return tools.get("worktrunk").execute("call", { command }, undefined, undefined, ctx); },
    destination() { return SessionManager.open(switches.at(-1)!, sessionDir); },
    cleanup() { return rm(root, { recursive: true, force: true }); },
  };
}

test("transient pre-command list failure retains cached recovery candidates", async () => {
  const f = await fixture({ deleteDuringRun: true });
  try {
    await f.seed();
    f.failNextList();
    await f.model();
    assert.deepEqual(f.invocations, [["land"]]);
    assertRecovery(f, f.main);
  } finally { await f.cleanup(); }
});

for (const entrypoint of ["slash", "tool"] as const) {
  test(`abort during ${entrypoint} preflight git probe does not trigger recovery`, async () => {
    const f = await fixture();
    try {
      await f.seed();
      f.abortNextProbe();
      if (entrypoint === "tool") await assert.rejects(() => f.tool(), /abort/i);
      else await f.slash();
      assert.deepEqual(f.invocations, []);
      assert.equal(f.switches.length, 0);
      assert.equal(f.continuations.length, 0);
    } finally { await f.cleanup(); }
  });
}

test("cancelled recovery never resumes in a foreign replacement source", async () => {
  const f = await fixture({ cancel: true });
  try {
    await f.seed();
    await f.replaceSource();
    await f.model();
    assert.deepEqual(f.invocations, []);
    assert.equal(f.switches.length, 1);
    assert.equal(f.continuations.length, 0);
    assert.match(f.notifications.join("\n"), /cancelled/i);
  } finally { await f.cleanup(); }
});

test("session_start caches recovery candidates before external deletion", async () => {
  const f = await fixture();
  try {
    await f.startup();
    assert.deepEqual(f.invocations, [], "startup discovery must not run a requested command");
    await rm(f.source, { recursive: true });
    await f.model();
    assert.deepEqual(f.invocations, []);
    assertRecovery(f, f.main);
  } finally { await f.cleanup(); }
});

test("replaced source from another repository is not used to run the requested command", async () => {
  const f = await fixture();
  try {
    await f.seed();
    await f.replaceSource();
    await f.model();
    assert.deepEqual(f.invocations, [], "never execute against a replacement repository");
    assertRecovery(f, f.main);
    assert.match(f.continuations[0].content, /not run|did not run|not executed/i);
  } finally { await f.cleanup(); }
});

test("replaced common directory cannot impersonate the cached repository identity", async () => {
  const f = await fixture();
  try {
    await f.seed();
    await f.replaceIdentity();
    await rm(f.source, { recursive: true });
    await f.model();
    assert.deepEqual(f.invocations, []);
    assert.equal(f.switches.length, 0, "matching common-dir paths are not proof of repository identity");
    assert.equal(f.continuations.length, 0);
    assert.ok(f.notifications.length > 0);
  } finally { await f.cleanup(); }
});

test("deleted cwd without an initial cache cannot move or run the command", async () => {
  const f = await fixture();
  try {
    await rm(f.source, { recursive: true });
    await f.model();
    assert.deepEqual(f.invocations, []);
    assert.equal(f.switches.length, 0);
    assert.equal(f.continuations.length, 0);
    assert.ok(f.notifications.length > 0);
  } finally { await f.cleanup(); }
});

for (const scenario of ["nested-placeholder", "nonrepo-version"] as const) {
  test(`real Git: ${scenario}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-worktrunk-real-recovery-")));
    const main = join(root, "main");
    const source = scenario === "nested-placeholder" ? join(main, "nested") : main;
    const run = promisify(execFile);
    // Git hooks export repository-local variables such as GIT_DIR. Never let
    // fixture commands inherit them or they can mutate the checkout running the tests.
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
    };
    const git = async (cwd: string, args: string[]) => run("git", args, { cwd, env });
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    const sent: string[] = [];
    const invocations: string[][] = [];
    const switches: string[] = [];
    const continuations: any[] = [];
    const notifications: string[] = [];
    try {
      await mkdir(main);
      if (scenario === "nested-placeholder") {
        await git(main, ["init", "--initial-branch=main"]);
        await git(main, ["-c", "user.name=Recovery Test", "-c", "user.email=recovery@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"]);
        await git(main, ["worktree", "add", "-b", "feature", source]);
      }
      const list = async (cwd: string) => {
        // Resolve the actual root with Git, not the requested cwd. A recreated
        // nested directory belongs to main, not to the removed linked worktree.
        const current = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
        const porcelain = (await git(cwd, ["worktree", "list", "--porcelain"])).stdout;
        const items = porcelain.trim().split(/\n\n/).map((block) => {
          const lines = block.split("\n");
          const path = lines.find((line) => line.startsWith("worktree "))!.slice(9);
          const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice(18);
          return { branch, worktree: { path, current: path === current, main: path === main } };
        });
        return { code: 0, stdout: JSON.stringify({ schema: 2, items }), directive: "" };
      };
      extension({
        on() {},
        registerCommand(name: string, command: any) { commands.set(name, command); },
        registerTool(tool: any) { tools.set(tool.name, tool); },
        registerMessageRenderer() {}, registerEntryRenderer() {}, appendEntry() {},
        sendUserMessage(text: string) { sent.push(text); },
        sendMessage(message: any) { if (message.display === false) continuations.push(message); },
        async exec(program: string, args: string[], options: any) {
          try {
            if (program === "git") return { code: 0, ...await run(program, args, { cwd: options.cwd, signal: options.signal, env }) };
            if (args.includes("list")) return await list(options.cwd);
            return { code: 0, stdout: "" };
          } catch (error: any) {
            return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
          }
        },
      } as any, async (args: string[]) => {
        invocations.push([...args]);
        return args[0] === "list" ? list(source) : { code: 0, stdout: "wt 1.0.0", directive: "" };
      });
      const sessionDir = join(root, "sessions");
      const manager = SessionManager.create(source, sessionDir);
      manager.appendSessionInfo("real Git recovery");
      const ctx: any = {
        cwd: source, mode: "tui", hasUI: true, sessionManager: manager,
        async waitForIdle() {}, abort() {},
        ui: { notify(text: string) { notifications.push(text); }, setWidget() {} },
        async switchSession(path: string, options: any) {
          switches.push(path);
          await options.withSession({ async sendMessage(message: any) { continuations.push(message); } });
          return { cancelled: false };
        },
      };
      if (scenario === "nonrepo-version") {
        await commands.get("wt").handler("--version", ctx);
        assert.deepEqual(invocations, [["--version"]], "a healthy non-repository directory must still allow global commands");
        assert.deepEqual(switches, []);
      } else {
        await commands.get("wt").handler("list --format=json", ctx);
        invocations.length = 0;
        await git(main, ["worktree", "remove", source]);
        await mkdir(source);
        assert.equal((await git(source, ["rev-parse", "--show-toplevel"])).stdout.trim(), main);
        await tools.get("worktrunk").execute("call", { command: "merge" }, undefined, undefined, ctx);
        assert.equal(sent.length, 1);
        assert.deepEqual(invocations, []);
        await commands.get("wt").handler(sent[0].slice(4), ctx);
        assert.deepEqual(invocations, [], "never merge in the enclosing repository after nested worktree removal");
        assert.equal(switches.length, 1, notifications.join("\n"));
        const destination = SessionManager.open(switches[0], sessionDir);
        assert.equal(destination.getCwd(), main);
        assert.equal((destination.getEntries().at(-1) as any).details.kind, "recovery");
        assert.equal(continuations.length, 1);
        assert.match(continuations[0].content, /not run|did not run|not executed/i);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

function assertRecovery(f: Awaited<ReturnType<typeof fixture>>, target: string) {
  assert.equal(f.switches.length, 1);
  const session = f.destination();
  assert.equal(session.getCwd(), target);
  const details = (session.getEntries().at(-1) as any).details;
  assert.equal(details.kind, "recovery");
  assert.equal(details.source.path, f.source);
  assert.equal(details.target.path, target);
  assert.equal(f.continuations.length, 1);
}

for (const code of [0, 7]) {
  test(`postflight deletion recovers and preserves command result (exit ${code})`, async () => {
    const f = await fixture({ deleteDuringRun: true, code });
    try {
      await f.model();
      assert.equal(existsSync(f.source), false);
      assert.deepEqual(f.invocations, [["land"]]);
      assertRecovery(f, f.main);
      assert.match(f.continuations[0].content, new RegExp(`exit ${code}`));
      assert.match(f.continuations[0].content, /command output retained/);
      if (code) assert.match(f.continuations[0].content, /hook failed after deletion/);
    } finally { await f.cleanup(); }
  });
}

for (const mode of ["tui", "rpc"] as const) {
  test(`preflight external deletion recovers without replay in ${mode}`, async () => {
    const f = await fixture({ mode });
    try {
      await f.seed();
      await rm(f.source, { recursive: true });
      await f.model();
      assert.deepEqual(f.invocations, []);
      assertRecovery(f, f.main);
      assert.match(f.continuations[0].content, /did not run|not (?:been )?(?:run|executed)|was not run/i);
      assert.match(f.continuations[0].content, /re-evaluate|reevaluate|reassess/i);
      assert.match(f.continuations[0].content, /(?:do not|don't).*repeat|not blindly/i);
    } finally { await f.cleanup(); }
  });
}

test("inline inspection queues recovery rather than spawning in deleted cwd", async () => {
  const f = await fixture();
  try {
    await f.seed();
    await rm(f.source, { recursive: true });
    await f.model("list", ["--format=json"]);
    assert.deepEqual(f.invocations, []);
    assertRecovery(f, f.main);
  } finally { await f.cleanup(); }
});

for (const foreignMain of [false, true]) {
  test(`recovery skips ${foreignMain ? "foreign" : "deleted"} main and verifies fallback`, async () => {
    const f = await fixture({ foreignMain });
    try {
      await f.seed();
      await rm(f.source, { recursive: true });
      if (!foreignMain) await rm(f.main, { recursive: true });
      await f.model();
      assertRecovery(f, f.other);
      assert.deepEqual(f.invocations, []);
    } finally { await f.cleanup(); }
  });
}

for (const scenario of ["no-survivors", "ephemeral", "cancel"] as const) {
  test(`deleted cwd fails safely with ${scenario}`, async () => {
    const f = await fixture({ ephemeral: scenario === "ephemeral", cancel: scenario === "cancel" });
    try {
      await f.seed();
      await rm(f.source, { recursive: true });
      if (scenario === "no-survivors") await Promise.all([f.main, f.other].map((path) => rm(path, { recursive: true })));
      await f.model();
      assert.deepEqual(f.invocations, []);
      assert.equal(f.switches.length, scenario === "cancel" ? 1 : 0);
      assert.equal(f.continuations.length, 0, "must not resume a model in the deleted source");
      assert.ok(f.notifications.length > 0, "explain why recovery could not continue");
    } finally { await f.cleanup(); }
  });
}

for (const directive of ["valid", "foreign", "malformed"] as const) {
  test(`postflight ${directive} directive takes precedence over recovery`, async () => {
    const f = await fixture({ deleteDuringRun: true, directive, foreignMain: directive === "foreign" });
    try {
      await f.model();
      assert.deepEqual(f.invocations, [["land"]]);
      if (directive === "valid") {
        assert.equal(f.switches.length, 1);
        assert.equal(f.destination().getCwd(), f.other);
        assert.equal((f.destination().getEntries().at(-1) as any).details.kind, "move");
        assert.equal(f.continuations.length, 1);
      } else {
        assert.equal(f.switches.length, 0, "rejected directive must not fall back to a survivor");
        assert.equal(f.continuations.length, 0);
        assert.match(f.notifications.join("\n"), /Rejected Worktrunk destination/);
      }
    } finally { await f.cleanup(); }
  });
}

test("healthy cwd without directive retains ordinary model continuation", async () => {
  const f = await fixture();
  try {
    await f.model();
    assert.deepEqual(f.invocations, [["land"]]);
    assert.equal(f.switches.length, 0);
    assert.equal(f.continuations.length, 1);
    assert.match(f.continuations[0].content, /completed successfully/);
    assert.equal(existsSync(f.source), true);
  } finally { await f.cleanup(); }
});

for (const mode of ["print", "json"] as const) {
  test(`${mode} stops without invocation when cached cwd is deleted`, async () => {
    const f = await fixture({ mode });
    try {
      await f.seed();
      await rm(f.source, { recursive: true });
      await f.slash();
      const result = await f.tool();
      assert.equal(result.structuredContent.status, "stopped");
      assert.deepEqual(f.invocations, []);
      assert.equal(f.switches.length, 0);
      assert.equal(f.continuations.length, 0);
    } finally { await f.cleanup(); }
  });
}
