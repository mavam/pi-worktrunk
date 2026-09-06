import assert from "node:assert/strict";
import test from "node:test";
import { Text } from "@earendil-works/pi-tui";
import extension from "./worktrunk.ts";

const theme = {
  fg(_color: string, text: string) { return text; },
  bold(text: string) { return text; },
};

function toolRenderer() {
  let tool: any;
  extension({
    on() {},
    registerCommand() {},
    registerEntryRenderer() {},
    registerTool(definition: any) { tool = definition; },
  } as any);
  return tool.renderResult;
}

for (const isError of [false, true]) {
  for (const output of ["", "short output", Array.from({ length: 100 }, (_, i) => `alias line ${i}`).join("\n"), "x".repeat(10_000)]) {
    test(`tool output collapses: error=${isError}, length=${output.length}`, () => {
      const render = toolRenderer();
      const result = { content: [{ type: "text", text: output }], details: { code: isError ? 1 : 0 } };
      const before = structuredClone(result);
      const collapsed = render(result, { expanded: false }, theme, { isError }).render(80);
      assert.equal(collapsed.length, 1);
      assert.match(collapsed[0], isError ? /Failed/ : /Done/);
      if (output) {
        assert.match(collapsed[0], /to expand/);
        assert.ok(!collapsed[0].includes(output.slice(0, 40)));
      } else {
        assert.doesNotMatch(collapsed[0], /to expand/);
      }
      const expanded = render(result, { expanded: true }, theme, { isError }).render(80);
      assert.deepEqual(expanded, output ? new Text(output, 0, 0).render(80) : collapsed);
      assert.deepEqual(render(result, { expanded: false }, theme, { isError }).render(80), collapsed);
      assert.deepEqual(result, before, "rendering must not alter model-visible content");
    });
  }
}

test("thrown errors without details collapse and expand", () => {
  const render = toolRenderer();
  const result = { content: [{ type: "text", text: "spawn failed\nerror details" }] };
  assert.match(render(result, { expanded: false }, theme, { isError: true }).render(80)[0], /Failed/);
  assert.deepEqual(render(result, { expanded: true }, theme, { isError: true }).render(80), new Text(result.content[0].text, 0, 0).render(80));
});

test("queued continuation results stay hidden in both modes", () => {
  const render = toolRenderer();
  for (const expanded of [false, true]) {
    assert.deepEqual(render({ content: [{ type: "text", text: "Queued wt land" }], details: { args: ["land"] } }, { expanded }, theme, { isError: false }).render(80), []);
  }
});
