import type { OpenClawPluginApi } from "./types.ts";
import { createCancelTool } from "./tools/cancel.ts";
import { createResultTool } from "./tools/result.ts";
import { createStatusTool } from "./tools/status.ts";
import { createSubmitTool } from "./tools/submit.ts";
import { getJobManager, rememberSubmitInvocation } from "./runtime/runtime-context.ts";
import { handleCcCommand } from "./runtime/cc-dispatch.ts";

function extractJobIdFromToolResult(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const directJobId = "job_id" in result && typeof result.job_id === "string" ? result.job_id : null;
  if (directJobId) {
    return directJobId;
  }

  const content = "content" in result && Array.isArray(result.content) ? result.content : null;
  if (!content) {
    return null;
  }

  for (const block of content) {
    if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") {
      continue;
    }

    try {
      const parsed = JSON.parse(block.text) as { job_id?: unknown };
      if (typeof parsed.job_id === "string" && parsed.job_id.length > 0) {
        return parsed.job_id;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export default function register(api: OpenClawPluginApi): void {
  api.registerTool(createSubmitTool(api), { optional: true });
  api.registerTool(createStatusTool(api), { optional: true });
  api.registerTool(createResultTool(api), { optional: true });
  api.registerTool(createCancelTool(api), { optional: true });
  api.registerCommand?.({
    name: "cc",
    description: "Submit a Claude Code task as an asynchronous background job.",
    acceptsArgs: true,
    handler: async (context) => handleCcCommand(api, context),
  });

  api.on?.("before_tool_call", (event, context) => {
    if (event?.toolName !== "execute_ai_cli_submit") {
      return;
    }

    if (
      typeof event?.toolCallId === "string" &&
      typeof context?.sessionKey === "string" &&
      context.sessionKey.length > 0
    ) {
      rememberSubmitInvocation(event.toolCallId, {
        sessionKey: context.sessionKey,
        agentId: typeof context?.agentId === "string" ? context.agentId : null,
        runId: typeof context?.runId === "string" ? context.runId : null,
      });
    }

    const params = event && typeof event === "object" && event.params &&
        typeof event.params === "object"
      ? { ...(event.params as Record<string, unknown>) }
      : {};

    if (typeof context?.sessionKey === "string" && context.sessionKey.length > 0) {
      params._openclaw_session_key = context.sessionKey;
    }
    if (typeof context?.agentId === "string" && context.agentId.length > 0) {
      params._openclaw_agent_id = context.agentId;
    }
    if (typeof context?.runId === "string" && context.runId.length > 0) {
      params._openclaw_run_id = context.runId;
    }

    return { params };
  });

  api.on?.("after_tool_call", (event, context) => {
    if (event?.toolName !== "execute_ai_cli_submit") {
      return;
    }

    const jobId = extractJobIdFromToolResult(event?.result);
    if (!jobId || typeof context?.sessionKey !== "string" || context.sessionKey.length === 0) {
      return;
    }

    getJobManager(api).attachOrigin(jobId, {
      originSessionKey: context.sessionKey,
      originAgentId: typeof context?.agentId === "string" ? context.agentId : null,
      originRunId: typeof context?.runId === "string" ? context.runId : null,
    });
  });
}
