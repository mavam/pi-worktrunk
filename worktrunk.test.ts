import assert from "node:assert/strict";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import extension, {
  MARKERS,
  createMarkerUpdater,
  createWorktrunkClient,
  configuredSessionPosture,
  defaultPlacementAction,
  markerArgs,
  parseAliasArguments,
  parseWtInvocation,
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

test("Pi placement modifiers are removed before Worktrunk runs", () => {
  assert.deepEqual(parseWtInvocation("switch --create fix --fork"), {
    args: ["switch", "--create", "fix"],
    command: "switch",
    commandIndex: 0,
    commandArgs: ["--create", "fix"],
    modifier: "fork",
  });
  assert.deepEqual(parseWtInvocation("deploy --go -- --go"), {
    args: ["deploy", "--", "--go"],
    command: "deploy",
    commandIndex: 0,
    commandArgs: ["--", "--go"],
    modifier: "go",
  });
  assert.throws(
    () => parseWtInvocation("switch fix --go --stay"),
    /Use only one/,
  );
});

test("/wt reports parse errors in JSON mode", async () => {
  let command: any;
  const messages: any[] = [];
  extension({
    on() {},
    appendEntry() {},
    registerTool() {},
    registerCommand(_name: string, definition: any) {
      command = definition;
    },
    sendMessage(message: any) {
      messages.push(message);
    },
    exec() {
      throw new Error("Worktrunk must not run after a parse error");
    },
  } as any);

  await command.handler("switch feature --go --stay", {
    mode: "json",
    sessionManager: { getSessionFile: () => "/sessions/source.jsonl" },
    ui: { notify() { throw new Error("notify is silent in JSON mode"); } },
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].customType, "pi-worktrunk-command");
  assert.match(messages[0].content, /Use only one/);
  assert.equal(messages[0].details.level, "error");

  await command.handler("switch feature --go", {
    mode: "json",
    sessionManager: { getSessionFile: () => undefined },
    ui: { notify() { throw new Error("notify is silent in JSON mode"); } },
  });
  assert.equal(messages.length, 2);
  assert.match(messages[1].content, /requires a persisted Pi session/);
});

test("bare /wt list reports discovery failures", async () => {
  let command: any;
  const notifications: Array<{ message: string; level: string }> = [];
  extension({
    on() {},
    appendEntry() {},
    registerTool() {},
    registerCommand(_name: string, definition: any) {
      command = definition;
    },
    async exec() {
      return {
        code: 1,
        stdout: "",
        stderr: "fatal: not a git repository",
        killed: false,
      };
    },
  } as any);

  await command.handler("list", {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    signal: undefined,
    sessionManager: { getSessionFile: () => "/sessions/source.jsonl" },
    async waitForIdle() {},
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "error");
  assert.match(notifications[0].message, /not a git repository/);
  assert.doesNotMatch(notifications[0].message, /No worktrees found/);
});

test("session posture selects the default placement", () => {
  assert.equal(configuredSessionPosture(undefined), "infer");
  assert.equal(configuredSessionPosture("follow"), "follow");
  assert.equal(configuredSessionPosture("stay"), "stay");
  assert.equal(configuredSessionPosture("ask"), "ask");
  assert.equal(configuredSessionPosture("invalid"), "infer");

  const base = {
    interactive: true,
    persisted: true,
    command: "switch",
    targetCreated: false,
    hasTarget: true,
  } as const;
  assert.equal(defaultPlacementAction({ ...base, posture: "infer" }), "go");
  assert.equal(defaultPlacementAction({
    ...base,
    posture: "infer",
    targetCreated: true,
  }), "stay");
  assert.equal(defaultPlacementAction({ ...base, posture: "follow" }), "go");
  assert.equal(defaultPlacementAction({ ...base, posture: "stay" }), "stay");
  assert.equal(defaultPlacementAction({ ...base, posture: "ask" }), "ask");
  assert.equal(defaultPlacementAction({
    ...base,
    posture: "follow",
    hasTarget: false,
  }), "stay");
  assert.equal(defaultPlacementAction({
    ...base,
    posture: "follow",
    interactive: false,
  }), "stay");
  assert.equal(defaultPlacementAction({
    ...base,
    posture: "follow",
    persisted: false,
  }), "stay");
});

test("/wt passes switch to Worktrunk and applies Pi placement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-placement-test-"));
  const source = join(root, "repo");
  const target = join(root, "repo.feature");
  const commonDir = join(source, ".git");
  const sessionDir = join(root, "sessions");
  await mkdir(commonDir, { recursive: true });
  await mkdir(target);

  let command: any;
  const switchCalls: string[][] = [];
  const switchedSessions: string[] = [];
  const pickerOptions: string[][] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  let cancelSwitch = false;
  const sourceManager = SessionManager.create(source, sessionDir);
  sourceManager.appendSessionInfo("placement test");

  const list = JSON.stringify({
    schema: 2,
    items: [
      {
        branch: "main",
        worktree: { path: source, main: true, current: true },
      },
      {
        branch: "feature",
        worktree: { path: target, main: false, current: false },
      },
    ],
  });

  try {
    extension({
      on() {},
      appendEntry() {},
      registerCommand(_name: string, definition: any) {
        command = definition;
      },
      registerTool() {},
      async exec(program: string, args: string[]) {
        if (program === "git") {
          return { code: 0, stdout: `${commonDir}\n`, stderr: "", killed: false };
        }
        if (args.includes("list")) {
          return { code: 0, stdout: list, stderr: "", killed: false };
        }
        if (args.includes("switch")) {
          switchCalls.push([...args]);
          const targetsMain = args.includes("main");
          const createsTarget = ["--create", "-cv", "-vc"].some((option) =>
            args.includes(option)
          );
          return {
            code: 0,
            stdout: JSON.stringify({
              action: createsTarget ? "created" : "existing",
              branch: targetsMain ? "main" : "feature",
              path: targetsMain ? source : target,
              created_branch: createsTarget,
            }),
            stderr: createsTarget
              ? "✓ Created feature worktree"
              : "○ Switched to feature worktree",
            killed: false,
          };
        }
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as any);

    const context = {
      cwd: source,
      mode: "tui",
      hasUI: true,
      signal: undefined,
      sessionManager: sourceManager,
      async waitForIdle() {},
      async switchSession(path: string, options: any) {
        switchedSessions.push(path);
        if (cancelSwitch) return { cancelled: true };
        await options.withSession({
          ui: {
            notify(message: string, level: string) {
              notifications.push({ message, level });
            },
          },
        });
        return { cancelled: false };
      },
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        async select(_title: string, options: string[]) {
          pickerOptions.push(options);
          return options[1];
        },
        async confirm() {
          return true;
        },
      },
    } as any;

    await command.handler("switch --stay", context);
    assert.deepEqual(pickerOptions, [["main [current, main]", "feature"]]);

    await command.handler("switch --create feature", context);
    await command.handler("switch -cv feature", context);
    await command.handler("switch -vc feature", context);
    assert.equal(switchedSessions.length, 0);

    await command.handler("switch --create feature --fork", context);
    assert.equal(switchedSessions.length, 0);
    assert.ok(notifications.some(({ message }) =>
      message.includes("Created a second Pi session in feature"),
    ));

    const launched = join(target, "fork-launched");
    const previousLauncher = process.env.PI_WORKTRUNK_FORK_COMMAND;
    process.env.PI_WORKTRUNK_FORK_COMMAND =
      'printf %s "$PI_WORKTRUNK_TARGET_SESSION" > "$PI_WORKTRUNK_TARGET_CWD/fork-launched"';
    try {
      await command.handler("switch --create feature --fork", context);
      for (let attempt = 0; attempt < 50 && !existsSync(launched); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      if (previousLauncher === undefined) {
        delete process.env.PI_WORKTRUNK_FORK_COMMAND;
      } else {
        process.env.PI_WORKTRUNK_FORK_COMMAND = previousLauncher;
      }
    }
    assert.ok(existsSync(launched));
    assert.match(await readFile(launched, "utf8"), /\.jsonl$/);
    assert.ok(notifications.some(({ message }) =>
      message.includes("Created and launched a second Pi session in feature"),
    ));

    const previousShell = process.env.SHELL;
    process.env.PI_WORKTRUNK_FORK_COMMAND = "true";
    process.env.SHELL = join(root, "missing-shell");
    try {
      await command.handler("switch feature --fork", context);
    } finally {
      if (previousLauncher === undefined) {
        delete process.env.PI_WORKTRUNK_FORK_COMMAND;
      } else {
        process.env.PI_WORKTRUNK_FORK_COMMAND = previousLauncher;
      }
      if (previousShell === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = previousShell;
      }
    }
    assert.ok(notifications.some(({ message, level }) =>
      level === "warning" &&
      message.includes("Could not launch the second Pi session") &&
      message.includes("Run: pi --session"),
    ));

    await command.handler("switch feature --stay --format=json", context);
    assert.ok(notifications.some(({ message }) =>
      message.startsWith('{"action":"existing"'),
    ));

    await command.handler("switch main --go", context);
    assert.equal(switchedSessions.length, 0);
    assert.ok(notifications.some(({ message }) =>
      message.includes("already in main"),
    ));

    await command.handler("switch main --fork", context);
    assert.equal(switchedSessions.length, 0);
    assert.ok(notifications.some(({ message }) =>
      message.includes("Created a second Pi session in main"),
    ));

    let printed = "";
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      printed += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      await command.handler("switch feature --go", {
        ...context,
        mode: "print",
      });
    } finally {
      process.stdout.write = write;
    }
    assert.match(printed, /Session would move from main to feature/);
    assert.equal(switchedSessions.length, 0);

    cancelSwitch = true;
    await command.handler("switch feature --go", context);
    assert.equal(switchedSessions.length, 1);
    assert.ok(existsSync(sourceManager.getSessionFile()!));
    assert.ok(existsSync(switchedSessions[0]));
    assert.ok(notifications.some(({ message, level }) =>
      level === "error" && message.includes("session switching was cancelled"),
    ));

    cancelSwitch = false;
    await command.handler("switch feature", context);
    assert.equal(switchedSessions.length, 2);
    assert.ok(switchCalls.every((args) =>
      args.includes("--no-cd") && args.includes("--format=json"),
    ));

    const destinationSession = switchedSessions.at(-1)!;
    assert.equal(dirname(destinationSession), sessionDir);
    const destination = SessionManager.open(destinationSession, sessionDir);
    assert.equal(destination.getCwd(), realpathSync(target));
    const transition = destination.getEntries().at(-1);
    assert.equal(transition?.type, "custom_message");
    if (transition?.type === "custom_message") {
      assert.equal(transition.customType, "pi-worktrunk-session-transition");
      assert.match(
        transition.content as string,
        /Previous absolute paths may be stale\./,
      );
      assert.equal((transition.details as any).kind, "move");
      assert.equal((transition.details as any).source.branch, "main");
      assert.equal((transition.details as any).source.path, realpathSync(source));
      assert.equal(
        (transition.details as any).trail.at(-1).path,
        realpathSync(source),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/wt switch - preserves flags and ignores foreign trail entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-back-test-"));
  const main = join(root, "repo");
  const source = join(root, "repo.feature");
  const foreign = join(root, "foreign");
  const commonDir = join(main, ".git");
  const foreignCommonDir = join(foreign, ".git");
  const sessionDir = join(root, "sessions");
  await mkdir(commonDir, { recursive: true });
  await mkdir(source);
  await mkdir(foreignCommonDir, { recursive: true });

  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  let command: any;
  const calls: string[][] = [];
  const switchedSessions: string[] = [];
  const sourceManager = SessionManager.create(source, sessionDir);
  sourceManager.appendCustomMessageEntry(
    "pi-worktrunk-session-transition",
    "trail",
    true,
    {
      trail: [
        { branch: "main", path: main, commonDir },
        { branch: "foreign", path: foreign, commonDir: foreignCommonDir },
      ],
    },
  );

  const list = JSON.stringify({
    schema: 2,
    items: [
      { branch: "main", worktree: { path: main, main: true, current: false } },
      { branch: "feature", worktree: { path: source, main: false, current: true } },
      { branch: "recreated", worktree: { path: foreign, main: false, current: false } },
    ],
  });

  try {
    extension({
      on(event: string, handler: (...args: any[]) => Promise<void>) {
        handlers.set(event, handler);
      },
      appendEntry() {},
      registerCommand(_name: string, definition: any) {
        command = definition;
      },
      registerTool() {},
      async exec(program: string, args: string[]) {
        if (program === "git") {
          return { code: 0, stdout: `${commonDir}\n`, stderr: "", killed: false };
        }
        if (args.length === 1 && args[0] === "--help") {
          return { code: 0, stdout: "Commands:\n  switch\n", stderr: "", killed: false };
        }
        if (args.includes("list")) {
          return { code: 0, stdout: list, stderr: "", killed: false };
        }
        if (args.includes("switch")) {
          calls.push([...args]);
          return { code: 0, stdout: "launched", stderr: "", killed: false };
        }
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as any);

    await handlers.get("session_start")?.({}, {
      cwd: source,
      signal: undefined,
      sessionManager: sourceManager,
    });

    await command.handler(
      `-v switch - --no-hooks -x echo --go -- hello`,
      {
        cwd: source,
        mode: "tui",
        hasUI: true,
        signal: undefined,
        sessionManager: sourceManager,
        async waitForIdle() {},
        async switchSession(path: string, options: any) {
          switchedSessions.push(path);
          await options.withSession({ ui: { notify() {} } });
          return { cancelled: false };
        },
        ui: { notify() {} },
      } as any,
    );

    assert.deepEqual(calls, [[
      "-v",
      "switch",
      main,
      "--no-hooks",
      "-x",
      "echo",
      "--",
      "hello",
    ]]);
    assert.equal(switchedSessions.length, 1);
    assert.equal(
      SessionManager.open(switchedSessions[0], sessionDir).getCwd(),
      realpathSync(main),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/wt recovers after a failed command removes the current worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-recovery-test-"));
  const main = join(root, "repo");
  const source = join(root, "repo.feature");
  const commonDir = join(main, ".git");
  const sessionDir = join(root, "sessions");
  await mkdir(commonDir, { recursive: true });
  await mkdir(source);

  let command: any;
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  const notifications: Array<{ message: string; level: string }> = [];
  const switchedSessions: string[] = [];
  const sourceManager = SessionManager.create(source, sessionDir);
  sourceManager.appendSessionInfo("recovery test");

  const list = (includeSource: boolean) => JSON.stringify({
    schema: 2,
    items: [
      {
        branch: "main",
        worktree: { path: main, main: true, current: !includeSource },
      },
      ...(includeSource
        ? [{
            branch: "feature",
            worktree: { path: source, main: false, current: true },
          }]
        : []),
    ],
  });

  try {
    extension({
      on(event: string, handler: (...args: any[]) => Promise<void>) {
        handlers.set(event, handler);
      },
      appendEntry() {},
      registerCommand(_name: string, definition: any) {
        command = definition;
      },
      registerTool() {},
      async exec(program: string, args: string[], options?: { cwd?: string }) {
        if (program === "git" && args.includes("worktree")) {
          return {
            code: 0,
            stdout: `worktree ${main}\0HEAD aaaa\0branch refs/heads/main\0\0`,
            stderr: "",
            killed: false,
          };
        }
        if (program === "git") {
          return { code: 0, stdout: `${commonDir}\n`, stderr: "", killed: false };
        }
        if (args.length === 1 && args[0] === "--help") {
          return { code: 0, stdout: "Commands:\n  list\n", stderr: "", killed: false };
        }
        if (args.includes("list")) {
          return {
            code: 0,
            stdout: list(existsSync(source)),
            stderr: "",
            killed: false,
          };
        }
        if (args[0] === "land") {
          await rm(source, { recursive: true, force: true });
          return { code: 1, stdout: "", stderr: "land failed after cleanup", killed: false };
        }
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as any);

    await handlers.get("session_start")?.({}, {
      cwd: source,
      signal: undefined,
      sessionManager: sourceManager,
    });

    await command.handler("land --stay", {
      cwd: source,
      mode: "tui",
      hasUI: true,
      signal: undefined,
      sessionManager: sourceManager,
      async waitForIdle() {},
      async switchSession(path: string, options: any) {
        switchedSessions.push(path);
        await options.withSession({
          ui: {
            notify(message: string, level: string) {
              notifications.push({ message, level });
            },
          },
        });
        return { cancelled: false };
      },
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    } as any);

    assert.equal(switchedSessions.length, 1);
    assert.equal(
      SessionManager.open(switchedSessions[0], sessionDir).getCwd(),
      realpathSync(main),
    );
    assert.ok(notifications.some(({ message }) =>
      message.includes("because the current worktree was removed"),
    ));
    assert.ok(notifications.some(({ message, level }) =>
      level === "error" && message.includes("land failed after cleanup"),
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/wt runs an explicit switch from a deleted working directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-deleted-cwd-test-"));
  const main = join(root, "repo");
  const source = join(root, "repo.deleted");
  const commonDir = join(main, ".git");
  const sessionDir = join(root, "sessions");
  await mkdir(commonDir, { recursive: true });

  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  let command: any;
  const calls: Array<{ program: string; args: string[]; cwd?: string }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const switchedSessions: string[] = [];
  const sourceManager = SessionManager.create(source, sessionDir);
  const stat = statSync(commonDir);
  sourceManager.appendCustomEntry("pi-worktrunk-repository", {
    commonDir,
    device: stat.dev,
    inode: stat.ino,
  });
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
      appendEntry() {},
      registerCommand(_name: string, definition: any) {
        command = definition;
      },
      registerTool() {},
      async exec(program: string, args: string[], options?: { cwd?: string }) {
        calls.push({ program, args: [...args], cwd: options?.cwd });
        if (program === "git" && args.includes("worktree")) {
          return {
            code: 0,
            stdout: `worktree ${main}\0HEAD aaaa\0branch refs/heads/main\0\0`,
            stderr: "",
            killed: false,
          };
        }
        if (program === "git") {
          return { code: 0, stdout: `${commonDir}\n`, stderr: "", killed: false };
        }
        if (args.length === 1 && args[0] === "--help") {
          return { code: 0, stdout: "Commands:\n  switch\n", stderr: "", killed: false };
        }
        if (args.includes("list")) {
          return { code: 0, stdout: list, stderr: "", killed: false };
        }
        if (args.includes("switch")) {
          return {
            code: 0,
            stdout: JSON.stringify({ action: "existing", branch: "main", path: main }),
            stderr: "○ Switched to main",
            killed: false,
          };
        }
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as any);

    await handlers.get("session_start")?.({}, {
      cwd: source,
      signal: undefined,
      sessionManager: sourceManager,
    });

    await command.handler("switch main --go", {
      cwd: source,
      mode: "tui",
      hasUI: true,
      signal: undefined,
      sessionManager: sourceManager,
      async waitForIdle() {},
      async switchSession(path: string, options: any) {
        switchedSessions.push(path);
        await options.withSession({ ui: { notify() {} } });
        return { cancelled: false };
      },
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    } as any);

    assert.ok(calls.some(({ program, args, cwd }) =>
      program === "wt" && args.includes("switch") && cwd === main,
    ));
    assert.equal(switchedSessions.length, 1);
    assert.equal(
      SessionManager.open(switchedSessions[0], sessionDir).getCwd(),
      realpathSync(main),
    );
    assert.ok(notifications.every(({ message }) => !message.includes("ENOENT")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("relocated lists do not claim the fallback is Pi's current worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrunk-test-"));
  const main = join(root, "repo");
  const removed = join(root, "repo.deleted");
  await mkdir(main);
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
    assert.equal((await client.list(removed))[0].worktree?.current, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
      sendMessage() {},
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

    await command.handler("list", {
      cwd: source,
      mode: "json",
      hasUI: false,
      signal: undefined,
      async waitForIdle() {},
      sessionManager: {
        getSessionFile: () => "/sessions/source.jsonl",
        getEntries: () => [identityEntry],
      },
      ui: { notify() {} },
    });

    assert.ok(calls.some(({ program, cwd }) =>
      program === "wt" && cwd === main,
    ));
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
  const confirmations: Array<{ title: string; message: string }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  let confirmAlias = true;
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
          if (args.includes("--remove-cwd") || args.length === 4) {
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
    assert.doesNotMatch(aliasTool.description, /merge-pr/);
    assert.match(
      aliasTool.parameters.properties.alias.description,
      /land: merge-pr -> verify -> sync-main -> cleanup/,
    );
    assert.deepEqual(aliasTool.parameters.properties.alias.enum, ["land"]);

    const aliasContext = {
      cwd: root,
      hasUI: true,
      ui: {
        async confirm(title: string, message: string) {
          confirmations.push({ title, message });
          return confirmAlias;
        },
      },
    };
    await assert.rejects(
      aliasTool.execute(
        "call-no-ui",
        { alias: "land", args: [] },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      ),
      /requires interactive or RPC mode/,
    );
    await assert.rejects(
      aliasTool.execute(
        "call-unknown",
        { alias: "deploy", args: [] },
        new AbortController().signal,
        undefined,
        aliasContext,
      ),
      /Worktrunk alias not available: deploy/,
    );

    confirmAlias = false;
    const callsBeforeCancellation = calls.length;
    const cancelled = await aliasTool.execute(
      "call-cancelled",
      { alias: "land", args: ["42"] },
      new AbortController().signal,
      undefined,
      aliasContext,
    );
    assert.equal(calls.length, callsBeforeCancellation);
    assert.equal(cancelled.content[0].text, "Cancelled Worktrunk alias land.");
    assert.deepEqual(cancelled.details, {
      alias: "land",
      args: ["42"],
      cancelled: true,
      truncated: false,
    });

    confirmAlias = true;
    const toolResult = await aliasTool.execute(
      "call-land",
      { alias: "land", args: ["42"] },
      new AbortController().signal,
      undefined,
      aliasContext,
    );
    assert.deepEqual(calls.at(-1), {
      program: "wt",
      args: ["land", "42"],
      cwd: root,
    });
    assert.match(confirmations.at(-1)?.message ?? "", /Command: .*land.*42/);
    assert.match(
      confirmations.at(-1)?.message ?? "",
      /Pipeline: merge-pr -> verify -> sync-main -> cleanup/,
    );
    assert.match(toolResult.content[0].text, /Merged pull request 42/);
    assert.deepEqual(toolResult.details, {
      alias: "land",
      args: ["42"],
      truncated: false,
    });

    const removedCwd = await aliasTool.execute(
      "call-remove-cwd",
      { alias: "land", args: ["--remove-cwd"] },
      new AbortController().signal,
      undefined,
      aliasContext,
    );
    assert.match(removedCwd.content[0].text, /removed Pi's working directory/);
    assert.deepEqual(removedCwd.details, {
      alias: "land",
      args: ["--remove-cwd"],
      truncated: false,
    });
    await mkdir(root);

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
      mode: "tui",
      hasUI: true,
      signal: undefined,
      sessionManager: {
        getSessionFile: () => "/sessions/source.jsonl",
        getEntries: () => [],
      },
      async waitForIdle() {},
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    };
    await command.handler(`land 42 "two words"`, commandContext);
    await command.handler("land 42 --go", commandContext);

    assert.ok(calls.some((call) =>
      call.program === "wt" &&
      call.args.join("\0") === ["land", "42", "two words"].join("\0") &&
      call.cwd === root,
    ));
    assert.ok(notifications.some(({ message, level }) =>
      level === "warning" && message.includes("no unique target"),
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extension registers markers, /wt, and the worktree tool", () => {
  const events: string[] = [];
  const commands: string[] = [];
  const tools: string[] = [];
  const messageRenderers = new Map<string, (...args: any[]) => any>();

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
    registerMessageRenderer(type: string, renderer: (...args: any[]) => any) {
      messageRenderers.set(type, renderer);
    },
    exec() {
      throw new Error("exec should not run during registration");
    },
  } as any);

  assert.deepEqual(commands, ["wt"]);
  assert.deepEqual(tools, ["worktree"]);
  const renderer = messageRenderers.get("pi-worktrunk-session-transition");
  assert.ok(renderer);
  const theme = {
    fg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  };
  const message = {
    content: "Previous absolute paths may be stale.",
    details: {
      kind: "move",
      source: {
        branch: "feature/wt-session-placement",
        path: `${homedir()}/code/pi-worktrunk.feature`,
      },
      target: {
        branch: "main",
        path: `${homedir()}/code/pi-worktrunk`,
      },
    },
  };
  const renderTransition = (expanded: boolean) =>
    renderer(message, { expanded, outputPad: 0 }, theme)
      .render(100)
      .map((line: string) => line.trimEnd());
  assert.deepEqual(renderTransition(false), [
    "↪ Session moved",
    "  feature/wt-session-placement → main",
  ]);
  assert.deepEqual(
    renderTransition(true),
    [
      "↪ Session moved",
      "  feature/wt-session-placement → main",
      "",
      "  From  ~/code/pi-worktrunk.feature",
      "  To    ~/code/pi-worktrunk",
    ],
  );
  for (const [kind, title] of [
    ["fork", "⑂ Session forked"],
    ["recovery", "↩ Session recovered"],
  ]) {
    message.details.kind = kind;
    assert.equal(renderTransition(false)[0], title);
  }
  assert.deepEqual(events, [
    "session_start",
    "agent_start",
    "agent_end",
    "session_shutdown",
  ]);
});
