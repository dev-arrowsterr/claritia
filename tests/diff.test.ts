import assert from "node:assert/strict";
import { test } from "node:test";
import { lineDiff } from "../src/lib/diff.ts";

test("a fix's diff keeps shared lines and marks what changed", () => {
  const d = lineDiff("fill name\nfill email\nclick Book a call", "fill name\nfill email\nclick Book a demo");
  assert.deepEqual(d, [
    { kind: "same", text: "fill name" },
    { kind: "same", text: "fill email" },
    { kind: "del", text: "click Book a call" },
    { kind: "add", text: "click Book a demo" },
  ]);
  assert.deepEqual(lineDiff("", "a"), [{ kind: "add", text: "a" }]);
  assert.deepEqual(lineDiff("a\nb", "b"), [{ kind: "del", text: "a" }, { kind: "same", text: "b" }]);
});
