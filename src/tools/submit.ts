import type { OpenClawPluginApi, SubmitParams } from "../types.ts";
import { jsonToolResponse } from "../utils/tool-response.ts";
import { consumeSubmitInvocation, getJobManager } from "../runtime/runtime-context.ts";

export function createSubmitTool(api: OpenClawPluginApi) {
  return {
    name: "execute_ai_cli_submit",
    description: "Submit an asynchronous local AI CLI job in a whitelisted working directory.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        cli_cmd: { type: "string" },
        args: {
          type: "array",
          items: { type: "string" },
        },
        working_dir: { type: "string" },
        timeout_seconds: { type: "integer", minimum: 1 },
        label: { type: "string" },
        notify_on_completion: { type: "boolean" },
      },
      required: ["cli_cmd", "args", "working_dir"],
    },
    async execute(invocationId: string, params: SubmitParams) {
      const invocationContext = consumeSubmitInvocation(invocationId);
      const effectiveParams: SubmitParams = invocationContext
        ? {
            ...params,
            _openclaw_session_key: params._openclaw_session_key ?? invocationContext.sessionKey,
            _openclaw_agent_id: params._openclaw_agent_id ?? invocationContext.agentId ?? undefined,
            _openclaw_run_id: params._openclaw_run_id ?? invocationContext.runId ?? undefined,
          }
        : params;

      const result = await getJobManager(api).submit(effectiveParams);
      return jsonToolResponse(result);
    },
  };
}
