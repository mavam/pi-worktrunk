import assert from "node:assert/strict";
import test from "node:test";

import extension, {
  MARKERS,
  createMarkerUpdater,
  createSessionContinuator,
  createWorktrunkClient,
  handleWorktreeCommand,
  markerArgs,
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
      display: { state: "is_main", symbols: "^|" },
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
      display: { state: "ahead", symbols: "!↑" },
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
    if (args.includes("list")) return { code: 0, stdout: worktreeList };
    if (args[0] === "switch") {
      return {
        code: 0,
        stdout: JSON.stringify({
          action: "created",
          branch: "feature/new",
          path: "/repo.feature-new",
        }),
      };
    }
    if (args[0] === "remove") {
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            branch: "feature/new",
            path: "/repo.feature-new",
            branch_deleted: true,
          },
        ]),
      };
    }
    return { code: 0, stdout: "{}" };
  });

  assert.equal((await client.status("/repo"))?.branch, "main");
  assert.deepEqual(await client.create("/repo", "feature/new"), {
    branch: "feature/new",
    path: "/repo.feature-new",
  });
  assert.deepEqual(await client.remove("/repo", "feature/new"), [
    {
      branch: "feature/new",
      path: "/repo.feature-new",
      branch_deleted: true,
    },
  ]);
  assert.equal(await client.settings("/repo"), "{}");

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
  const forks: Array<[string, string]> = [];
  const confirmations: Array<[string, string]> = [];
  const switched: string[] = [];
  const messages: any[] = [];
  const notifications: Array<[string, string]> = [];
  let waited = false;

  const continueSession = createSessionContinuator((source, target) => {
    forks.push([source, target]);
    return "/sessions/continued.jsonl";
  });

  const continued = await continueSession(
    {
      cwd: "/repo",
      hasUI: true,
      sessionManager: {
        getSessionFile() {
          return "/sessions/source.jsonl";
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
    ["/sessions/source.jsonl", "/repo.feature-auth"],
  ]);
  assert.deepEqual(switched, ["/sessions/continued.jsonl"]);
  assert.match(confirmations[0][1], /The current session remains available/);
  assert.match(confirmations[0][1], /From:\s+\/repo/);
  assert.match(confirmations[0][1], /To:\s+\/repo\.feature-auth/);
  assert.equal(messages[0].customType, "pi-worktrunk-session-continuation");
  assert.match(messages[0].content, /Historical messages keep their original text/);
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
