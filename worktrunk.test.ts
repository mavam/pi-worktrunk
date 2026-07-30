import assert from "node:assert/strict";
import test from "node:test";

import extension, {
  MARKERS,
  createMarkerUpdater,
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
