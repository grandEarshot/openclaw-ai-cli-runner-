import type { ToolResponse } from "../types.ts";

export function jsonToolResponse(payload: unknown): ToolResponse {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}
