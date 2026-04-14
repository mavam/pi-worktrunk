import assert from "node:assert/strict";
import test from "node:test";

import extension, { MARKERS, createMarkerUpdater, markerArgs } from "./worktrunk.ts";

test("markerArgs sets the requested worktrunk marker", () => {
  assert.deepEqual(markerArgs(MARKERS.working), [
    "config",
    "state",
    "marker",
    "set",
    MARKERS.working,
  ]);
});

test("markerArgs clears the marker when no value is provided", () => {
  assert.deepEqual(markerArgs(), ["config", "state", "marker", "clear"]);
});

test("createMarkerUpdater stops retrying after the first wt failure", async () => {
  const calls: string[][] = [];
  const tracker = createMarkerUpdater(async (args) => {
    calls.push([...args]);
    return { code: 1 };
  });

  await tracker.markWaiting();
  await tracker.markWorking();
  await tracker.clear();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], markerArgs(MARKERS.waiting));
});

test("extension registers the expected lifecycle handlers", () => {
  const events: string[] = [];

  extension({
    on(event: string, _handler: unknown) {
      events.push(event);
    },
    exec() {
      throw new Error("exec should not run during registration");
    },
  } as any);

  assert.deepEqual(events, [
    "session_start",
    "agent_start",
    "agent_end",
    "session_shutdown",
  ]);
});
