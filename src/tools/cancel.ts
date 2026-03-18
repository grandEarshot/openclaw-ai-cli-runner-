import type { OpenClawPluginApi } from "../types.ts";
import { jsonToolResponse } from "../utils/tool-response.ts";
import { getJobManager } from "../runtime/runtime-context.ts";

export function createCancelTool(api: OpenClawPluginApi) {
  return {
    name: "execute_ai_cli_cancel",
    description: "Cancel a queued or running asynchronous AI CLI job.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        job_id: { type: "string" },
      },
      required: ["job_id"],
    },
    async execute(_invocationId: string, params: { job_id: string }) {
      return jsonToolResponse(getJobManager(api).cancel(params.job_id));
    },
  };
}
