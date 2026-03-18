import test from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "../src/utils/ansi.ts";

test("stripAnsi removes color control codes", () => {
  assert.equal(stripAnsi("\u001b[31mred\u001b[0m"), "red");
});
