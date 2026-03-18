import type { OpenClawPluginApi } from "../types.ts";
import { JobManager } from "./job-manager.ts";
import { resolvePluginConfig } from "../utils/validate.ts";
import { CompletionRelay } from "./completion-relay.ts";

let manager: JobManager | undefined;
const submitInvocationContext = new Map<string, {
  sessionKey: string;
  agentId: string | null;
  runId: string | null;
}>();

export function getJobManager(api: OpenClawPluginApi): JobManager {
  const config = resolvePluginConfig(api);

  if (!manager) {
    manager = new JobManager(config, {
      completionNotifier: new CompletionRelay(api),
    });
    return manager;
  }

  manager.updateConfig(config);
  return manager;
}

export function rememberSubmitInvocation(
  invocationId: string,
  context: { sessionKey: string; agentId: string | null; runId: string | null },
): void {
  if (!invocationId || !context.sessionKey) {
    return;
  }

  submitInvocationContext.set(invocationId, context);
}

export function consumeSubmitInvocation(
  invocationId: string,
): { sessionKey: string; agentId: string | null; runId: string | null } | undefined {
  if (!invocationId) {
    return undefined;
  }

  const context = submitInvocationContext.get(invocationId);
  submitInvocationContext.delete(invocationId);
  return context;
}

export function resetRuntimeContextForTests(): void {
  manager = undefined;
  submitInvocationContext.clear();
}
