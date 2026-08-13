import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import extension, {
  MARKERS,
  createMarkerUpdater,
  createSessionContinuator,
  createWorktrunkClient,
  forkSessionFromSnapshot,
  handleWorktreeCommand,
  markerArgs,
  materializeSessionSnapshot,
} from "./worktrunk.ts";

const worktreeList = JSON.stringify({
  schema: 2,
  repo: { default_branch: "main" },
  collected: { ci: false, summary: false },
  items: [
    {
      branch: "main",
      head: { short_sha: "aaaa111", subject: "Initial commit" },
      worktree: {
        path: "/repo",
        main: true,
        current: true,
        previous: false,
        changes: {
          staged: false,
          modified: false,
          untracked: false,
          renamed: false,
          deleted: false,
          conflicted: false,
        },
      },
      upstream: { ahead: 0, behind: 0 },
      display: { state: "is_main", symbols: "^|", statusline: "main  ^|" },
    },
    {
      branch: "feature/auth",
      head: { short_sha: "bbbb222", subject: "Add auth" },
      worktree: {
        path: "/repo.feature-auth",
        main: false,
        current: false,
        previous: true,
        changes: {
          staged: false,
          modified: true,
          untracked: false,
          renamed: false,
          deleted: false,
          conflicted: false,
        },
      },
      default_branch: { ahead: 2, behind: 0 },
      display: {
        state: "ahead",
        symbols: "!↑",
        statusline: "feature/auth  !↑",
      },
    },
  ],
});

test("marker arguments map pi states to Worktrunk", () => {
  assert.deepEqual(markerArgs(MARKERS.working), [
    "config",
    "state",
    "marker",
    "set",
    MARKERS.working,
  ]);
  assert.deepEqual(markerArgs(), ["config", "state", "marker", "clear"]);
});

test("marker updates stop after Worktrunk becomes unavailable", async () => {
  const calls: string[][] = [];
  const tracker = createMarkerUpdater(async (args) => {
    calls.push([...args]);
    return { code: 1 };
  });

  await tracker.markWaiting();
  await tracker.markWorking();
  await tracker.clear();

  assert.deepEqual(calls, [markerArgs(MARKERS.waiting)]);
});

test("Worktrunk client exposes the supported lifecycle operations", async () => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const client = createWorktrunkClient(async (args, options) => {
    calls.push({ args: [...args], cwd: options?.cwd });
    if (args.length === 1 && args[0] === "list") {
      return { code: 0, stdout: "@ main  ^|" };
    }
    if (args.includes("list")) return { code: 0, stdout: worktreeList };
    if (args[0] === "switch") {
      return {
        code: 0,
        stdout: JSON.stringify({
          action: "created",
          branch: "feature/new",
          path: "/repo.feature-new",
          created_branch: true,
          base_branch: "main",
        }),
        stderr:
          "✓ Created branch feature/new from main and worktree @ /repo.feature-new\n",
      };
    }
    if (args[0] === "remove") {
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            kind: "worktree",
            branch: "feature/new",
            path: "/repo.feature-new",
            branch_outcome: "deleted",
          },
        ]),
        stderr: "✓ Removed feature/new worktree & branch\n",
      };
    }
    if (args[0] === "config" && !args.includes("--format=json")) {
      return { code: 0, stdout: "USER CONFIG @ /config.toml" };
    }
    return { code: 0, stdout: "{}" };
  });

  assert.equal((await client.status("/repo"))?.branch, "main");
  assert.equal(await client.listText("/repo"), "@ main  ^|");
  assert.deepEqual(await client.create("/repo", "feature/new"), {
    branch: "feature/new",
    path: "/repo.feature-new",
    createdBranch: true,
    baseBranch: "main",
    display:
      "✓ Created branch feature/new from main and worktree @ /repo.feature-new",
  });
  assert.deepEqual(await client.remove("/repo", "feature/new"), {
    outcomes: [
      {
        kind: "worktree",
        branch: "feature/new",
        path: "/repo.feature-new",
        branch_outcome: "deleted",
      },
    ],
    display: "✓ Removed feature/new worktree & branch",
  });
  assert.equal(await client.settings("/repo"), "{}");
  assert.equal(
    await client.settingsText("/repo"),
    "USER CONFIG @ /config.toml",
  );

  assert.deepEqual(calls, [
    {
      args: [
        "--config-set",
        "list.json-schema=2",
        "list",
        "--format=json",
      ],
      cwd: "/repo",
    },
    {
      args: ["list"],
      cwd: "/repo",
    },
    {
      args: [
        "switch",
        "--create",
        "--no-cd",
        "--format=json",
        "feature/new",
      ],
      cwd: "/repo",
    },
    {
      args: ["remove", "--foreground", "--format=json", "feature/new"],
      cwd: "/repo",
    },
    {
      args: ["config", "show", "--format=json"],
      cwd: "/repo",
    },
    {
      args: ["config", "show"],
      cwd: "/repo",
    },
  ]);
});

test("/worktree create reports the path and keeps Pi in place", async () => {
  const notifications: Array<[string, string]> = [];
  const client = {
    async create(_cwd: string, branch: string) {
      return { branch, path: "/repo.feature-auth" };
    },
  };

  await handleWorktreeCommand(
    "create feature/auth",
    {
      cwd: "/repo",
      hasUI: false,
      ui: {
        notify(message: string, level: string) {
          notifications.push([message, level]);
        },
      },
    } as any,
    client as any,
  );

  assert.deepEqual(notifications, [
    [
      "Created feature/auth.\nPath: /repo.feature-auth\nPi remains in /repo.",
      "info",
    ],
  ]);
});

test("/worktree create can continue the session in the new worktree", async () => {
  const continuationTargets: Array<{ branch: string | null; path: string }> = [];
  const client = {
    async create(_cwd: string, branch: string) {
      return { branch, path: "/repo.feature-auth" };
    },
  };

  await handleWorktreeCommand(
    "create feature/auth --continue",
    {
      cwd: "/repo",
      hasUI: false,
      ui: { notify() {} },
    } as any,
    client as any,
    async (_ctx, target) => {
      continuationTargets.push(target);
      return true;
    },
  );

  assert.deepEqual(continuationTargets, [
    { branch: "feature/auth", path: "/repo.feature-auth" },
  ]);
});

test("/worktree continue resolves an existing worktree", async () => {
  const continuationTargets: Array<{ branch: string | null; path: string }> = [];
  const client = {
    async list() {
      return (JSON.parse(worktreeList) as { items: any[] }).items;
    },
  };

  await handleWorktreeCommand(
    "continue feature/auth",
    {
      cwd: "/repo",
      hasUI: false,
      ui: { notify() {} },
    } as any,
    client as any,
    async (_ctx, target) => {
      continuationTargets.push(target);
      return true;
    },
  );

  assert.deepEqual(continuationTargets, [
    { branch: "feature/auth", path: "/repo.feature-auth" },
  ]);
});

test("session continuation forks, switches, and records the cwd transition", async () => {
  const forks: Array<[string, string, string | undefined]> = [];
  const confirmations: Array<[string, string]> = [];
  const switched: string[] = [];
  const messages: any[] = [];
  const notifications: Array<[string, string]> = [];
  let waited = false;

  const continueSession = createSessionContinuator(
    (source, target, _snapshot, targetSessionDir) => {
      forks.push([source, target, targetSessionDir]);
      return "/sessions/continued.jsonl";
    },
  );

  const continued = await continueSession(
    {
      cwd: "/repo",
      hasUI: true,
      sessionManager: {
        getSessionFile() {
          return "/sessions/source.jsonl";
        },
        getHeader() {
          return {
            type: "session",
            version: 3,
            id: "source-id",
            timestamp: "2026-08-09T17:29:46.150Z",
            cwd: "/repo",
          };
        },
        getEntries() {
          return [];
        },
        usesDefaultSessionDir() {
          return true;
        },
        getSessionDir() {
          throw new Error("default session directory should be implicit");
        },
      },
      async waitForIdle() {
        waited = true;
      },
      ui: {
        async confirm(title: string, message: string) {
          confirmations.push([title, message]);
          return true;
        },
        notify(message: string, level: string) {
          notifications.push([message, level]);
        },
      },
      async switchSession(path: string, options: any) {
        switched.push(path);
        await options.withSession({
          async sendMessage(message: any) {
            messages.push(message);
          },
          ui: {
            notify(message: string, level: string) {
              notifications.push([message, level]);
            },
          },
        });
        return { cancelled: false };
      },
    } as any,
    { branch: "feature/auth", path: "/repo.feature-auth" },
  );

  assert.equal(continued, true);
  assert.equal(waited, true);
  assert.deepEqual(forks, [
    ["/sessions/source.jsonl", "/repo.feature-auth", undefined],
  ]);
  assert.deepEqual(switched, ["/sessions/continued.jsonl"]);
  assert.equal(confirmations[0][0], "↪ Continue in feature/auth?");
  assert.match(confirmations[0][1], /From\s+\/repo/);
  assert.match(confirmations[0][1], /To\s+\/repo\.feature-auth/);
  assert.match(confirmations[0][1], /the original stays available/);
  assert.equal(messages[0].customType, "↪ Continued in worktree");
  assert.match(messages[0].content, /^From:\s+\/repo$/m);
  assert.match(messages[0].content, /^To:\s+\/repo\.feature-auth$/m);
  assert.match(messages[0].content, /Use the new worktree for subsequent file operations/);
  assert.deepEqual(messages[0].details, {
    branch: "feature/auth",
    sourceCwd: "/repo",
    targetCwd: "/repo.feature-auth",
    sourceSession: "/sessions/source.jsonl",
    destinationSession: "/sessions/continued.jsonl",
  });
  assert.ok(
    notifications.some(([message, level]) =>
      level === "info" && message.includes("Continued the session"),
    ),
  );
});

test("session continuation keeps a fresh source in its custom session directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-test-"));
  try {
    const sessionDir = join(root, "sessions");
    const sourceManager = SessionManager.create("/repo", sessionDir);
    sourceManager.appendSessionInfo("fresh session");
    const sourceSession = sourceManager.getSessionFile();
    assert.ok(sourceSession);
    assert.equal(existsSync(sourceSession), false);

    let destinationSession: string | undefined;
    const continueSession = createSessionContinuator(
      (source, target, snapshot, targetSessionDir) => {
        assert.equal(targetSessionDir, sessionDir);
        const fork = forkSessionFromSnapshot(
          source,
          target,
          snapshot,
          targetSessionDir,
        );
        destinationSession = fork.destinationSession;
        return fork;
      },
    );

    const continued = await continueSession(
      {
        cwd: "/repo",
        hasUI: true,
        sessionManager: sourceManager,
        async waitForIdle() {},
        ui: {
          async confirm() {
            return true;
          },
          notify() {},
        },
        async switchSession(path: string, options: any) {
          assert.equal(path, destinationSession);
          await options.withSession({
            async sendMessage() {},
            ui: { notify() {} },
          });
          return { cancelled: false };
        },
      } as any,
      { branch: "main", path: "/repo.main" },
    );

    assert.equal(continued, true);
    assert.ok(destinationSession);
    assert.equal(dirname(destinationSession), sessionDir);
    assert.equal(existsSync(sourceSession), true);
    assert.equal(existsSync(destinationSession), true);

    const sourceEntries = (await readFile(sourceSession, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const destinationEntries = (await readFile(destinationSession, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(sourceEntries[0].cwd, "/repo");
    assert.equal(sourceEntries[1].type, "session_info");
    assert.equal(sourceEntries[1].name, "fresh session");
    assert.equal(destinationEntries[0].cwd, "/repo.main");
    assert.equal(destinationEntries[0].parentSession, sourceSession);
    assert.deepEqual(destinationEntries.slice(1), sourceEntries.slice(1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session continuation does not snapshot a persisted custom-directory source", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-test-"));
  try {
    const sessionDir = join(root, "sessions");
    const sourceManager = SessionManager.create("/repo", sessionDir);
    sourceManager.appendSessionInfo("persisted session");
    const sourceSession = sourceManager.getSessionFile();
    const sourceHeader = sourceManager.getHeader();
    assert.ok(sourceSession);
    assert.ok(sourceHeader);
    materializeSessionSnapshot(sourceSession, {
      header: sourceHeader,
      entries: sourceManager.getEntries(),
    });

    let destinationSession: string | undefined;
    const continueSession = createSessionContinuator(
      (source, target, snapshot, targetSessionDir) => {
        assert.equal(snapshot, undefined);
        assert.equal(targetSessionDir, sessionDir);
        const fork = forkSessionFromSnapshot(
          source,
          target,
          snapshot,
          targetSessionDir,
        );
        destinationSession = fork.destinationSession;
        return fork;
      },
    );

    const continued = await continueSession(
      {
        cwd: "/repo",
        hasUI: true,
        sessionManager: {
          getSessionFile: () => sourceSession,
          getHeader() {
            throw new Error("persisted sources should not request a header");
          },
          getEntries() {
            throw new Error("persisted sources should not request entries");
          },
          usesDefaultSessionDir: () => false,
          getSessionDir: () => sessionDir,
        },
        async waitForIdle() {},
        ui: {
          async confirm() {
            return true;
          },
          notify() {},
        },
        async switchSession(path: string, options: any) {
          assert.equal(path, destinationSession);
          await options.withSession({
            async sendMessage() {},
            ui: { notify() {} },
          });
          return { cancelled: false };
        },
      } as any,
      { branch: "main", path: "/repo.main" },
    );

    assert.equal(continued, true);
    assert.ok(destinationSession);
    assert.equal(dirname(destinationSession), sessionDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session continuation preserves a fresh source when switching fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-test-"));
  try {
    const sessionDir = join(root, "sessions");
    const sourceManager = SessionManager.create("/repo", sessionDir);
    sourceManager.appendSessionInfo("fresh session");
    const sourceSession = sourceManager.getSessionFile();
    assert.ok(sourceSession);
    assert.equal(existsSync(sourceSession), false);

    const continueSession = createSessionContinuator(forkSessionFromSnapshot);
    await assert.rejects(
      continueSession(
        {
          cwd: "/repo",
          hasUI: true,
          sessionManager: sourceManager,
          async waitForIdle() {},
          ui: {
            async confirm() {
              return true;
            },
            notify() {},
          },
          async switchSession() {
            throw new Error("target runtime failed");
          },
        } as any,
        { branch: "main", path: "/repo.main" },
      ),
      /target runtime failed/,
    );

    assert.equal(existsSync(sourceSession), true);
    const sourceEntries = (await readFile(sourceSession, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(sourceEntries[1].name, "fresh session");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session continuation leaves Pi in place when confirmation is declined", async () => {
  let forked = false;
  let switched = false;
  const notifications: Array<[string, string]> = [];
  const continueSession = createSessionContinuator(() => {
    forked = true;
    return "/sessions/continued.jsonl";
  });

  const continued = await continueSession(
    {
      cwd: "/repo",
      hasUI: true,
      sessionManager: { getSessionFile: () => "/sessions/source.jsonl" },
      async waitForIdle() {},
      ui: {
        async confirm() {
          return false;
        },
        notify(message: string, level: string) {
          notifications.push([message, level]);
        },
      },
      async switchSession() {
        switched = true;
        return { cancelled: false };
      },
    } as any,
    { branch: "feature/auth", path: "/repo.feature-auth" },
  );

  assert.equal(continued, false);
  assert.equal(forked, false);
  assert.equal(switched, false);
  assert.deepEqual(notifications, [
    [
      "Session continuation cancelled.\nWorktree: /repo.feature-auth\nPi remains in /repo.",
      "info",
    ],
  ]);
});

test("worktree tool renders native output for every action", async () => {
  let tool: any;
  const calls: string[][] = [];
  const nativeList = [
    "  Branch        Status  Path",
    "@ main              ^   .",
    "+ feature/auth      !↑  ../repo.feature-auth",
    "",
    "○ Showing 2 worktrees, 1 with changes",
  ].join("\n");
  const nativeCreate =
    "✓ Created branch feature/new from main and worktree @ /repo.feature-new";
  const nativeRemove =
    "✓ Removed feature/auth worktree & branch (same commit as main, _)";
  const nativeSettings = "USER CONFIG @ /config.toml";

  extension({
    on() {},
    registerCommand() {},
    registerTool(definition: any) {
      tool = definition;
    },
    async exec(_command: string, args: string[]) {
      calls.push([...args]);
      if (args.length === 1 && args[0] === "list") {
        const [table, summary] = nativeList.split("\n\n");
        return {
          code: 0,
          stdout: table,
          stderr: `\n${summary}`,
          killed: false,
        };
      }
      if (args[0] === "switch") {
        return {
          code: 0,
          stdout: JSON.stringify({
            action: "created",
            branch: "feature/new",
            path: "/repo.feature-new",
            created_branch: true,
            base_branch: "main",
          }),
          stderr: nativeCreate,
          killed: false,
        };
      }
      if (args[0] === "remove") {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              kind: "worktree",
              branch: "feature/auth",
              path: "/repo.feature-auth",
              branch_outcome: "deleted",
            },
          ]),
          stderr: nativeRemove,
          killed: false,
        };
      }
      if (args[0] === "config" && args.includes("--format=json")) {
        return {
          code: 0,
          stdout: '{"user":{"exists":true}}',
          stderr: "",
          killed: false,
        };
      }
      if (args[0] === "config") {
        return {
          code: 0,
          stdout: nativeSettings,
          stderr: "",
          killed: false,
        };
      }
      if (args.includes("--format=json")) {
        return { code: 0, stdout: worktreeList, stderr: "", killed: false };
      }
      throw new Error(`unexpected Worktrunk call: ${args.join(" ")}`);
    },
  } as any);

  const execute = (params: Record<string, string>) =>
    tool.execute(
      `call-${params.action}`,
      params,
      new AbortController().signal,
      undefined,
      { cwd: "/repo", mode: "tui" },
    );

  const list = await execute({ action: "list" });
  assert.match(list.content[0].text, /"worktrees"/);
  assert.equal(list.details.display, nativeList);
  assert.deepEqual(
    tool.renderResult(list).render(120),
    nativeList.split("\n"),
  );

  const status = await execute({ action: "status" });
  assert.equal(status.details.display, "main  ^|");

  const create = await execute({ action: "create", branch: "feature/new" });
  assert.equal(create.details.display, nativeCreate);

  const remove = await execute({ action: "remove", target: "feature/auth" });
  assert.equal(remove.details.display, nativeRemove);
  assert.match(remove.content[0].text, /"branch_outcome": "deleted"/);

  const path = await execute({ action: "path", target: "feature/auth" });
  assert.equal(path.details.display, "/repo.feature-auth");

  const settings = await execute({ action: "settings" });
  assert.equal(settings.details.display, nativeSettings);

  assert.ok(calls.some((args) => args.join(" ") === "list"));
  assert.ok(
    calls.some((args) =>
      args.join(" ") === "config show"),
  );
});

test("extension registers markers, /worktree, and the worktree tool", () => {
  const events: string[] = [];
  const commands: string[] = [];
  const tools: string[] = [];

  extension({
    on(event: string, _handler: unknown) {
      events.push(event);
    },
    registerCommand(name: string, _options: unknown) {
      commands.push(name);
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    exec() {
      throw new Error("exec should not run during registration");
    },
  } as any);

  assert.deepEqual(commands, ["worktree"]);
  assert.deepEqual(tools, ["worktree"]);
  assert.deepEqual(events, [
    "session_start",
    "agent_start",
    "agent_end",
    "session_shutdown",
  ]);
});
