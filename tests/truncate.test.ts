import test from "node:test";
import assert from "node:assert/strict";
import { truncateLog } from "../src/utils/truncate.ts";

test("truncateLog keeps short logs unchanged", () => {
  const result = truncateLog("hello", 4000);
  assert.equal(result.text, "hello");
  assert.equal(result.isTruncated, false);
});

test("truncateLog truncates long logs with omission marker", () => {
  const input = "a".repeat(5000);
  const result = truncateLog(input, 4000);
  assert.equal(result.isTruncated, true);
  assert.equal(result.text.includes("[省略中间日志]"), true);
});
