import type { SubmitParams } from "../types.ts";

export interface CcParseSuccess {
  ok: true;
  task: string;
  workingDir: string | null;
}

export interface CcParseFailure {
  ok: false;
  reason: "missing_task" | "working_dir_not_absolute";
}

export type CcParseResult = CcParseSuccess | CcParseFailure;

const CLAUDE_CC_SUFFIX = ["--output-format", "text", "--permission-mode", "bypassPermissions"] as const;
const TASK_START_MARKER = "<cc_task>";
const TASK_END_MARKER = "</cc_task>";

export function parseCcCommand(input: string, prefix: string): CcParseResult | null {
  if (typeof input !== "string") {
    return null;
  }

  const trimmed = input.trim();
  const normalizedPrefix = typeof prefix === "string" ? prefix.trim() : "";
  if (!normalizedPrefix || !trimmed.startsWith(normalizedPrefix)) {
    return null;
  }

  const remainder = trimmed.slice(normalizedPrefix.length);
  if (remainder.length > 0 && !/^\s/.test(remainder)) {
    return null;
  }

  const body = remainder.trim();
  if (!body) {
    return { ok: false, reason: "missing_task" };
  }

  const match = body.match(/^(.*?)(?:\s+@([^\s]+))?$/);
  if (!match) {
    return { ok: false, reason: "missing_task" };
  }

  const task = match[1]?.trim() ?? "";
  if (!task) {
    return { ok: false, reason: "missing_task" };
  }

  const workingDirToken = match[2]?.trim();
  if (workingDirToken) {
    if (!workingDirToken.startsWith("/")) {
      return { ok: false, reason: "working_dir_not_absolute" };
    }
    return { ok: true, task, workingDir: workingDirToken };
  }

  return { ok: true, task, workingDir: null };
}

function buildClaudeCcPrompt(task: string, workingDir?: string): string {
  return [
    "你是 Claude Code，需要直接在当前工作目录里完成任务。",
    workingDir ? `工作目录:${workingDir}` : null,
    "请直接创建、修改或删除所需文件，不要只输出代码片段、教程或“把以下内容保存为文件”的说明。",
    "如果任务需要产出代码，必须把代码实际写入文件。",
    "完成后请给出极简结果报告：",
    "RESULT: OK",
    "FILES:",
    "- 每行一个实际创建或修改过的相对路径",
    "如果最终没有写入任何文件，请明确输出 RESULT: NO_FILES。",
    TASK_START_MARKER,
    task,
    TASK_END_MARKER,
  ].filter((line): line is string => line !== null).join("\n");
}

export function buildClaudeCcArgs(task: string, workingDir?: string): string[] {
  return ["-p", buildClaudeCcPrompt(task, workingDir), ...CLAUDE_CC_SUFFIX];
}

export function extractClaudeTaskFromArgs(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-p" && typeof args[i + 1] === "string") {
      const prompt = args[i + 1] as string;
      const startIndex = prompt.indexOf(TASK_START_MARKER);
      const endIndex = prompt.indexOf(TASK_END_MARKER);
      if (startIndex >= 0 && endIndex > startIndex) {
        return prompt.slice(startIndex + TASK_START_MARKER.length, endIndex).trim();
      }
      return prompt;
    }
  }
  return null;
}

function normalizeTaskLabel(task: string): string {
  return task.trim().replace(/\s+/g, " ");
}

export function buildCcLabel(task: string, maxLength = 24): string {
  const normalized = normalizeTaskLabel(task);
  if (normalized.length <= maxLength) {
    return `cc:${normalized}`;
  }

  return `cc:${normalized.slice(0, Math.max(1, maxLength - 3))}...`;
}

export function buildCcSubmitParams(options: {
  task: string;
  workingDir: string;
  sessionKey?: string | null;
  agentId?: string | null;
  runId?: string | null;
}): SubmitParams {
  const params: SubmitParams = {
    cli_cmd: "claude",
    args: buildClaudeCcArgs(options.task, options.workingDir),
    working_dir: options.workingDir,
    label: buildCcLabel(options.task),
    notify_on_completion: true,
  };

  if (typeof options.sessionKey === "string" && options.sessionKey.length > 0) {
    params._openclaw_session_key = options.sessionKey;
  }
  if (typeof options.agentId === "string" && options.agentId.length > 0) {
    params._openclaw_agent_id = options.agentId;
  }
  if (typeof options.runId === "string" && options.runId.length > 0) {
    params._openclaw_run_id = options.runId;
  }

  return params;
}

export function formatCcDispatchReceipt(task: string, workingDir: string, jobId: string): string {
  return [
    "已派发 Claude Code",
    `任务:${task}`,
    `目录:${workingDir}`,
    `任务ID:${jobId}`,
    "完成后会自动通知到你。",
  ].join("\n");
}

export function formatCcParseError(result: CcParseFailure): string {
  switch (result.reason) {
    case "missing_task":
      return [
        "Claude Code指令错误",
        "原因:缺少任务描述",
        "用法:/cc <任务描述> @/绝对路径",
      ].join("\n");
    case "working_dir_not_absolute":
      return [
        "Claude Code指令错误",
        "原因:路径必须为绝对路径",
        "用法:/cc <任务描述> @/绝对路径",
      ].join("\n");
    default:
      return "Claude Code指令错误";
  }
}

export function formatCcDispatchFailure(task: string, workingDir: string, error: string): string {
  return [
    "Claude Code派发失败",
    `任务:${task}`,
    `目录:${workingDir}`,
    `错误:${error}`,
  ].join("\n");
}
