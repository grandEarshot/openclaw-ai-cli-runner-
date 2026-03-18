import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCcLabel,
  buildCcSubmitParams,
  buildClaudeCcArgs,
  extractClaudeTaskFromArgs,
  formatCcDispatchFailure,
  formatCcDispatchReceipt,
  formatCcParseError,
  parseCcCommand,
} from "../src/utils/cc-command.ts";

test("parseCcCommand parses task and working dir", () => {
  const result = parseCcCommand("/cc fix the build @/tmp", "/cc");
  assert.ok(result && result.ok);
  assert.equal(result.task, "fix the build");
  assert.equal(result.workingDir, "/tmp");
});

test("parseCcCommand parses task without working dir", () => {
  const result = parseCcCommand("/cc ship it", "/cc");
  assert.ok(result && result.ok);
  assert.equal(result.task, "ship it");
  assert.equal(result.workingDir, null);
});

test("parseCcCommand rejects missing task", () => {
  const result = parseCcCommand("/cc   ", "/cc");
  assert.ok(result && !result.ok);
  assert.equal(result.reason, "missing_task");
});

test("parseCcCommand rejects non-absolute working dir", () => {
  const result = parseCcCommand("/cc do thing @relative/path", "/cc");
  assert.ok(result && !result.ok);
  assert.equal(result.reason, "working_dir_not_absolute");
});

test("buildCcSubmitParams uses claude -p template", () => {
  const params = buildCcSubmitParams({
    task: "summarize logs",
    workingDir: "/workspace",
    sessionKey: "agent:main:main",
    agentId: "main",
    runId: "run-123",
  });

  assert.equal(params.cli_cmd, "claude");
  assert.equal(params.args[0], "-p");
  assert.equal(params.args[1]?.includes("summarize logs"), true);
  assert.equal(params.args[1]?.includes("工作目录:/workspace"), true);
  assert.equal(params.args[1]?.includes("RESULT: OK"), true);
  assert.equal(params.args[1]?.includes("FILES:"), true);
  assert.equal(params.args.includes("--output-format"), true);
  assert.equal(params.args.includes("text"), true);
  assert.equal(params.args.includes("--permission-mode"), true);
  assert.equal(params.args.includes("bypassPermissions"), true);
  assert.equal(params.working_dir, "/workspace");
  assert.equal(params.notify_on_completion, true);
  assert.equal(params._openclaw_session_key, "agent:main:main");
  assert.equal(params._openclaw_agent_id, "main");
  assert.equal(params._openclaw_run_id, "run-123");
});

test("buildCcLabel truncates long task", () => {
  const label = buildCcLabel("this is a very long task description", 12);
  assert.equal(label.startsWith("cc:"), true);
  assert.equal(label.length, "cc:".length + 12);
});

test("extractClaudeTaskFromArgs recovers original task from generated prompt", () => {
  const args = buildClaudeCcArgs("write snake game", "/workspace");
  assert.equal(extractClaudeTaskFromArgs(args), "write snake game");
});

test("formatCcDispatchReceipt returns multiline receipt", () => {
  const message = formatCcDispatchReceipt("build app", "/workspace/app", "job-123");

  assert.equal(
    message,
    [
      "已派发 Claude Code",
      "任务:build app",
      "目录:/workspace/app",
      "任务ID:job-123",
      "完成后会自动通知到你。",
    ].join("\n"),
  );
});

test("formatCcParseError returns multiline help", () => {
  assert.equal(
    formatCcParseError({ ok: false, reason: "missing_task" }),
    [
      "Claude Code指令错误",
      "原因:缺少任务描述",
      "用法:/cc <任务描述> @/绝对路径",
    ].join("\n"),
  );
});

test("formatCcDispatchFailure returns multiline failure message", () => {
  assert.equal(
    formatCcDispatchFailure("build app", "/workspace/app", "boom"),
    [
      "Claude Code派发失败",
      "任务:build app",
      "目录:/workspace/app",
      "错误:boom",
    ].join("\n"),
  );
});
