import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import register from "../src/index.ts";
import { getJobManager, resetRuntimeContextForTests } from "../src/runtime/runtime-context.ts";
import type { OpenClawPluginCommandDefinition } from "../src/types.ts";

const workingDir = path.resolve(".");

async function waitForCompletion(
  api: Record<string, unknown>,
  jobId: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = getJobManager(api).getStatus(jobId);
    if (status.finished_at) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${jobId} did not finish within ${timeoutMs}ms`);
}

function createApi() {
  const hooks = new Map<string, (event: Record<string, unknown>, context: Record<string, unknown>) => unknown>();
  const events: Array<{ text: string; sessionKey: string }> = [];
  const heartbeats: Array<{ sessionKey?: string; agentId?: string }> = [];
  const registrations: Array<{ name: string; execute: (invocationId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> = [];
  const commands: OpenClawPluginCommandDefinition[] = [];

  const api = {
    pluginConfig: {
      allowedCommands: ["bash", "claude"],
      allowedWorkingDirs: [workingDir],
      defaultWorkingDir: workingDir,
      commandPrefix: "/cc",
      defaultTimeoutSeconds: 2,
      maxLogChars: 4000,
      previewFlushBytes: 1,
      previewFlushIntervalMs: 10,
      maxConcurrentJobs: 4,
      deliverToChannelOnCompletion: true,
    },
    registerTool(tool: { name: string; execute: (invocationId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }) {
      registrations.push(tool);
    },
    registerCommand(command: OpenClawPluginCommandDefinition) {
      commands.push(command);
    },
    on(hookName: string, handler: (event: Record<string, unknown>, context: Record<string, unknown>) => unknown) {
      hooks.set(hookName, handler);
    },
    runtime: {
      system: {
        enqueueSystemEvent(text: string, options: { sessionKey: string }) {
          events.push({ text, sessionKey: options.sessionKey });
          return true;
        },
        requestHeartbeatNow(options?: { sessionKey?: string; agentId?: string }) {
          heartbeats.push({
            sessionKey: options?.sessionKey,
            agentId: options?.agentId,
          });
        },
      },
    },
  };

  register(api);

  return {
    api,
    hooks,
    events,
    heartbeats,
    commands,
    submitTool: registrations.find((tool) => tool.name === "execute_ai_cli_submit"),
  };
}

test.afterEach(() => {
  resetRuntimeContextForTests();
});

test("plugin injects session context into submit via before_tool_call hook", () => {
  let beforeHookHandler:
    | ((event: Record<string, unknown>, context: Record<string, unknown>) => unknown)
    | undefined;
  let afterHookHandler:
    | ((event: Record<string, unknown>, context: Record<string, unknown>) => unknown)
    | undefined;
  const registeredToolNames: string[] = [];
  const registeredCommands: string[] = [];

  register({
    registerTool(tool) {
      registeredToolNames.push(tool.name);
    },
    registerCommand(command) {
      registeredCommands.push(command.name);
    },
    on(hookName, handler) {
      if (hookName === "before_tool_call") {
        beforeHookHandler = handler as typeof beforeHookHandler;
      }
      if (hookName === "after_tool_call") {
        afterHookHandler = handler as typeof afterHookHandler;
      }
    },
  });

  const result = beforeHookHandler?.(
    {
      toolName: "execute_ai_cli_submit",
      toolCallId: "call-1",
      params: { cli_cmd: "claude" },
    },
    {
      sessionKey: "agent:main:main",
      agentId: "main",
      runId: "run-1",
    },
  ) as { params: Record<string, unknown> } | undefined;

  assert.equal(result?.params._openclaw_session_key, "agent:main:main");
  assert.equal(result?.params._openclaw_agent_id, "main");
  assert.equal(result?.params._openclaw_run_id, "run-1");
  assert.equal(registeredCommands.includes("cc"), true);
  assert.equal(registeredToolNames.includes("execute_ai_cli_submit"), true);
  assert.equal(typeof afterHookHandler, "function");
});

test("submit tool consumes before_tool_call context and relays completion", async () => {
  const { hooks, events, heartbeats, submitTool, api } = createApi();
  const beforeHook = hooks.get("before_tool_call");

  assert.ok(beforeHook);
  assert.ok(submitTool);

  beforeHook?.(
    {
      toolName: "execute_ai_cli_submit",
      toolCallId: "call-ctx",
      params: { cli_cmd: "bash" },
    },
    {
      sessionKey: "agent:main:main",
      agentId: "main",
      runId: "run-ctx",
    },
  );

  const response = await submitTool!.execute("call-ctx", {
    cli_cmd: "bash",
    args: ["-lc", "printf 'done\\n'"],
    working_dir: workingDir,
  });
  const payload = JSON.parse(response.content[0]!.text) as { job_id: string };

  await waitForCompletion(api, payload.job_id);

  assert.equal(events.length, 1);
  assert.equal(events[0]!.sessionKey, "agent:main:main");
  assert.equal(events[0]!.text.includes(payload.job_id), true);
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0]!.sessionKey, "agent:main:main");
});

test("after_tool_call can attach origin for already-finished jobs", async () => {
  const { hooks, events, heartbeats, submitTool, api } = createApi();
  const afterHook = hooks.get("after_tool_call");

  assert.ok(afterHook);
  assert.ok(submitTool);

  const response = await submitTool!.execute("call-after", {
    cli_cmd: "bash",
    args: ["-lc", "printf 'done\\n'"],
    working_dir: workingDir,
  });
  const payload = JSON.parse(response.content[0]!.text) as { job_id: string };

  await waitForCompletion(api, payload.job_id);
  assert.equal(events.length, 0);

  afterHook?.(
    {
      toolName: "execute_ai_cli_submit",
      result: response,
    },
    {
      sessionKey: "agent:main:main",
      agentId: "main",
      runId: "run-after",
    },
  );

  await waitForCompletion(api, payload.job_id);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && events.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(events.length, 1);
  assert.equal(events[0]!.sessionKey, "agent:main:main");
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0]!.agentId, "main");
});

test("cc command returns parse error directly without going through message hooks", async () => {
  const { commands } = createApi();
  const ccCommand = commands.find((command) => command.name === "cc");

  assert.ok(ccCommand);

  const result = await ccCommand!.handler({
    channel: "telegram",
    channelId: "telegram",
    isAuthorizedSender: true,
    commandBody: "/cc",
    args: "",
    to: "chat-1",
    from: "user-1",
    accountId: "acct-1",
  });

  assert.equal(typeof result.text, "string");
  assert.equal(result.text?.includes("Claude Code指令错误"), true);
  assert.equal(result.text?.includes("用法:/cc <任务描述> @/绝对路径"), true);
});
