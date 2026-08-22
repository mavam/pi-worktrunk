import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import extension, {
  MARKERS,
  createMarkerUpdater,
  createSessionContinuator,
  createWorktrunkClient,
  forkSessionFromSnapshot,
  handleWorktreeCommand,
  markerArgs,
  materializeSessionSnapshot,
  parseAliasArguments,
  parseWorktrunkAliasMetadata,
  parseWorktrunkAliasNames,
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

test("Worktrunk aliases are parsed from help output", () => {
  const output = `wt - Git worktree management

Aliases:
  deploy, land, deploy

Run wt config alias show for the full definitions.
`;

  assert.deepEqual(parseWorktrunkAliasNames(output), ["deploy", "land"]);
  assert.deepEqual(parseWorktrunkAliasNames("Aliases:\n  land\n"), ["land"]);
  assert.deepEqual(parseWorktrunkAliasNames("wt help without aliases"), []);
});

test("Worktrunk alias metadata exposes pipeline step names", () => {
  const config = JSON.stringify({
    user: {
      config: {
        aliases: {
          land: [
            { "merge-pr": "gh pr merge" },
            { verify: "gh pr view" },
          ],
        },
      },
    },
    project: {
      config: {
        aliases: {
          land: [{ cleanup: "wt remove" }],
          deploy: "make deploy",
          unrelated: [{ ignore: "true" }],
        },
      },
    },
  });

  assert.deepEqual(
    parseWorktrunkAliasMetadata(["land", "deploy", "missing"], config),
    [
      { name: "land", steps: ["merge-pr", "verify", "cleanup"] },
      { name: "deploy", steps: [] },
      { name: "missing", steps: [] },
    ],
  );
  assert.deepEqual(parseWorktrunkAliasMetadata(["land"], "not json"), [
    { name: "land", steps: [] },
  ]);
});

test("alias arguments preserve quoting and escaping", () => {
  assert.deepEqual(
    parseAliasArguments(`42 "two words" '' escaped\\ value`),
    ["42", "two words", "", "escaped value"],
  );
  assert.throws(
    () => parseAliasArguments(`"unterminated`),
    /unterminated quote/,
  );
  assert.throws(
    () => parseAliasArguments("trailing\\"),
    /trailing escape character/,
  );
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
  const calls: Array<{
    args: string[];
    cwd?: string;
    cwdMode?: "repository-read";
  }> = [];
  const client = createWorktrunkClient(async (args, options) => {
    calls.push({
      args: [...args],
      cwd: options?.cwd,
      ...(options?.cwdMode ? { cwdMode: options.cwdMode } : {}),
    });
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
      cwdMode: "repository-read",
    },
    {
      args: ["list"],
      cwd: "/repo",
      cwdMode: "repository-read",
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
      cwdMode: "repository-read",
    },
    {
      args: ["config", "show"],
      cwd: "/repo",
      cwdMode: "repository-read",
    },
  ]);
});

test("/wt create reports the path and keeps Pi in place", async () => {
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

test("/wt create can continue the session in the new worktree", async () => {
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

test("missing working directories are not reported as missing Worktrunk", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-test-"));
  const missing = join(root, "removed-worktree");
  const client = createWorktrunkClient(async () => ({
    code: -1,
    stderr: "spawn wt ENOENT",
  }));

  try {
    await assert.rejects(
      client.list(missing),
      (error: Error) => {
        assert.match(error.message, /working directory no longer exists/);
        assert.match(error.message, new RegExp(missing));
        assert.doesNotMatch(error.message, /Install Worktrunk/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/wt continue resolves an existing worktree", async () => {
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

test("relocated lists do not claim the fallback is Pi's current worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-test-"));
  const main = join(root, "repo");
  const removed = join(root, "repo.deleted");
  await mkdir(main);
  const continuationTargets: Array<{ branch: string | null; path: string }> = [];
  const list = JSON.stringify({
    schema: 2,
    items: [
      { branch: "main", worktree: { path: main, main: true, current: true } },
    ],
  });
  const client = createWorktrunkClient(async () => ({
    code: 0,
    stdout: list,
    relocated: true,
  }));

  try {
    await handleWorktreeCommand(
      "continue",
      {
        cwd: removed,
        hasUI: true,
        ui: {
          async select(_title: string, options: string[]) {
            assert.equal(options.length, 1);
            return options[0];
          },
          notify() {},
        },
      } as any,
      client,
      async (_ctx, target) => {
        continuationTargets.push(target);
        return true;
      },
    );

    assert.deepEqual(continuationTargets, [{ branch: "main", path: main }]);
    assert.equal((await client.list(removed))[0].worktree?.current, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
      { cwd: process.cwd(), mode: "tui" },
    );

  const theme = {
    bold: (text: string) => `<bold>${text}</bold>`,
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  };
  assert.equal(
    tool
      .renderCall(
        { action: "create", branch: "feature/new" },
        theme,
      )
      .render(120)[0]
      .trimEnd(),
    "<toolTitle><bold>Worktrunk</bold></toolTitle> › <toolTitle><bold>create</bold></toolTitle> <accent>feature/new</accent>",
  );
  assert.equal(
    tool.renderCall({ action: "list" }, theme).render(120)[0].trimEnd(),
    "<toolTitle><bold>Worktrunk</bold></toolTitle> › <toolTitle><bold>list</bold></toolTitle>",
  );

  const list = await execute({ action: "list" });
  assert.match(list.content[0].text, /"worktrees"/);
  assert.equal(list.details.display, nativeList);
  assert.deepEqual(
    tool.renderResult(list).render(120),
    nativeList.split("\n"),
  );

  const linkedRow =
    "@ " +
    "\x1b]8;;https://example.com/feature/auth\x07" +
    "feature/auth-with-a-long-name" +
    "\x1b]8;;\x07" +
    "  \x1b[36m!↑\x1b[0m";
  const [narrowRow] = tool
    .renderResult({
      content: [{ type: "text", text: "structured output" }],
      details: {
        action: "list",
        truncated: false,
        display: linkedRow,
      },
    })
    .render(20);
  assert.equal(visibleWidth(narrowRow), 20);
  assert.match(narrowRow, /…/);
  assert.match(narrowRow, /\x1b]8;;\x07/);

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

test("extension stores repository identity without listing worktrees at startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-test-"));
  const source = join(root, "repo.feature");
  const commonDir = join(root, "repo", ".git");
  await mkdir(source);
  await mkdir(commonDir, { recursive: true });
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const calls: Array<{ program: string; args: string[] }> = [];

  try {
    extension({
      on(event: string, handler: (...args: any[]) => Promise<void>) {
        handlers.set(event, handler);
      },
      registerCommand() {},
      registerTool() {},
      appendEntry(customType: string, data: unknown) {
        entries.push({ customType, data });
      },
      async exec(program: string, args: string[]) {
        calls.push({ program, args: [...args] });
        if (program === "git") {
          return {
            code: 0,
            stdout: `${commonDir}\n`,
            stderr: "",
            killed: false,
          };
        }
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as any);

    await handlers.get("session_start")?.({}, {
      cwd: source,
      sessionManager: { getEntries: () => [] },
    });

    const commonDirStat = statSync(commonDir);
    assert.deepEqual(entries, [
      {
        customType: "pi-worktrunk-repository",
        data: {
          commonDir,
          device: commonDirStat.dev,
          inode: commonDirStat.ino,
        },
      },
    ]);
    assert.equal(
      calls.some(({ program, args }) =>
        program === "wt" && args.includes("list"),
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extension lazily discovers a worktree from stored repository identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-test-"));
  const main = join(root, "repo");
  const commonDir = join(main, ".git");
  const source = join(root, "repo.feature");
  await mkdir(commonDir, { recursive: true });

  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  let command: any;
  const calls: Array<{ program: string; args: string[]; cwd?: string }> = [];
  const list = JSON.stringify({
    schema: 2,
    items: [
      { branch: "main", worktree: { path: main, main: true, current: true } },
    ],
  });

  try {
    extension({
      on(event: string, handler: (...args: any[]) => Promise<void>) {
        handlers.set(event, handler);
      },
      registerCommand(_name: string, definition: any) {
        command = definition;
      },
      registerTool() {},
      appendEntry() {
        throw new Error("stored identity should not be appended again");
      },
      async exec(program: string, args: string[], options: { cwd?: string }) {
        calls.push({ program, args: [...args], cwd: options.cwd });
        if (program === "git" && args.includes("worktree")) {
          return {
            code: 0,
            stdout: `worktree ${main}\0HEAD aaaa\0branch refs/heads/main\0\0`,
            stderr: "",
            killed: false,
          };
        }
        if (program === "git") {
          return {
            code: 0,
            stdout: `${commonDir}\n`,
            stderr: "",
            killed: false,
          };
        }
        if (args.includes("list")) {
          return { code: 0, stdout: list, stderr: "", killed: false };
        }
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as any);

    const commonDirStat = statSync(commonDir);
    const identityEntry = {
      type: "custom",
      customType: "pi-worktrunk-repository",
      data: {
        commonDir,
        device: commonDirStat.dev,
        inode: commonDirStat.ino,
      },
    };
    await handlers.get("session_start")?.({}, {
      cwd: source,
      sessionManager: { getEntries: () => [identityEntry] },
    });
    await handlers.get("agent_end")?.({}, { cwd: source });
    assert.equal(calls.at(-1)?.cwd, source);

    await command.handler("list", {
      cwd: source,
      hasUI: false,
      ui: { notify() {} },
    });

    assert.equal(calls.at(-1)?.program, "wt");
    assert.equal(calls.at(-1)?.cwd, main);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extension exposes Worktrunk aliases under /wt and as an agent tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-alias-test-"));
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const calls: Array<{ program: string; args: string[]; cwd?: string }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  let helpFails = false;

  try {
    extension({
      on(event: string, handler: (...args: any[]) => Promise<void>) {
        handlers.set(event, handler);
      },
      registerCommand(name: string, definition: any) {
        commands.set(name, definition);
      },
      registerTool(definition: any) {
        tools.set(definition.name, definition);
      },
      appendEntry() {},
      async exec(program: string, args: string[], options?: { cwd?: string }) {
        calls.push({ program, args: [...args], cwd: options?.cwd });
        if (program === "git") {
          return { code: 1, stdout: "", stderr: "", killed: false };
        }
        if (args.length === 1 && args[0] === "--help") {
          return helpFails
            ? { code: 1, stdout: "", stderr: "failed", killed: false }
            : {
                code: 0,
                stdout:
                  "Commands:\n  list\n\nAliases:\n  land, list, worktree\n\nOptions:\n",
                stderr: "",
                killed: false,
              };
        }
        if (args[0] === "config" && args.includes("--format=json")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              user: {
                config: {
                  aliases: {
                    land: [
                      { "merge-pr": "gh pr merge" },
                      { verify: "gh pr view" },
                      { "sync-main": "git fetch" },
                      { cleanup: "wt remove" },
                    ],
                  },
                },
              },
            }),
            stderr: "",
            killed: false,
          };
        }
        if (args[0] === "land") {
          if (args.length > 1) {
            await rm(root, { recursive: true, force: true });
          }
          return {
            code: 0,
            stdout: "Merged pull request 42",
            stderr: "✓ Removed feature worktree",
            killed: false,
          };
        }
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as any);

    const sessionContext = {
      cwd: root,
      signal: undefined,
      sessionManager: { getEntries: () => [] },
    };
    await handlers.get("session_start")?.({}, sessionContext);

    assert.deepEqual([...commands.keys()], ["wt"]);
    assert.deepEqual([...tools.keys()], ["worktree", "worktree_alias"]);
    const command = commands.get("wt");
    assert.deepEqual(command.getArgumentCompletions("la"), [
      { value: "land", label: "land" },
    ]);
    assert.deepEqual(command.getArgumentCompletions("wo"), []);

    const aliasTool = tools.get("worktree_alias");
    assert.match(
      aliasTool.description,
      /land: merge-pr -> verify -> sync-main -> cleanup/,
    );
    assert.deepEqual(aliasTool.parameters.properties.alias.enum, ["land"]);
    const toolResult = await aliasTool.execute(
      "call-land",
      { alias: "land", args: [] },
      new AbortController().signal,
      undefined,
      { cwd: root },
    );
    assert.deepEqual(calls.at(-1), {
      program: "wt",
      args: ["land"],
      cwd: root,
    });
    assert.match(toolResult.content[0].text, /Merged pull request 42/);
    assert.deepEqual(toolResult.details, {
      alias: "land",
      args: [],
      truncated: false,
    });
    await assert.rejects(
      aliasTool.execute(
        "call-unknown",
        { alias: "deploy", args: [] },
        new AbortController().signal,
        undefined,
        { cwd: root },
      ),
      /Worktrunk alias not available: deploy/,
    );

    helpFails = true;
    await handlers.get("session_start")?.({}, sessionContext);
    assert.deepEqual(command.getArgumentCompletions("la"), []);

    helpFails = false;
    await handlers.get("session_start")?.({}, sessionContext);
    assert.deepEqual(command.getArgumentCompletions("la"), [
      { value: "land", label: "land" },
    ]);
    assert.deepEqual(command.getArgumentCompletions("li"), [
      { value: "list", label: "list" },
    ]);

    const commandContext = {
      cwd: root,
      signal: undefined,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    };
    await command.handler("", commandContext);
    await command.handler(`land 42 "two words" ''`, commandContext);

    assert.deepEqual(calls.at(-1), {
      program: "wt",
      args: ["land", "42", "two words", ""],
      cwd: root,
    });
    assert.equal(notifications[0]?.level, "info");
    assert.match(notifications[0]?.message ?? "", /\/wt land \[args\]/);
    assert.deepEqual(notifications[1], {
      message:
        "Merged pull request 42\n✓ Removed feature worktree\n\n" +
        "The alias removed Pi's working directory. Use " +
        "`/wt continue <target>` to continue this session in an " +
        "existing worktree.",
      level: "info",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extension registers markers, /wt, and the worktree tool", () => {
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

  assert.deepEqual(commands, ["wt"]);
  assert.deepEqual(tools, ["worktree"]);
  assert.deepEqual(events, [
    "session_start",
    "agent_start",
    "agent_end",
    "session_shutdown",
  ]);
});
