import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { JobManager } from "../src/runtime/job-manager.ts";
import type { PluginConfig } from "../src/types.ts";

const workingDir = path.resolve(".");
const shellCommand = "bash";

function createConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    allowedCommands: [shellCommand],
    allowedWorkingDirs: [workingDir],
    defaultWorkingDir: workingDir,
    commandPrefix: "/cc",
    defaultTimeoutSeconds: 2,
    maxLogChars: 4000,
    previewFlushBytes: 1,
    previewFlushIntervalMs: 10,
    maxConcurrentJobs: 4,
    deliverToChannelOnCompletion: true,
    ...overrides,
  };
}

async function waitForCompletion(
  manager: JobManager,
  jobId: string,
  timeoutMs = 3000,
): Promise<ReturnType<JobManager["getStatus"]>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = manager.getStatus(jobId);
    if (status.finished_at) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${jobId} did not finish within ${timeoutMs}ms`);
}

test("job manager executes a successful process and captures output", async () => {
  const manager = new JobManager(createConfig());
  const submit = await manager.submit({
    cli_cmd: shellCommand,
    args: ["-lc", "printf '\\033[32mok\\033[0m\\n'; printf 'warn\\n' >&2"],
    working_dir: workingDir,
  });

  const status = await waitForCompletion(manager, submit.job_id);
  const result = manager.getResult(submit.job_id);

  assert.equal(status.status, "succeeded");
  assert.equal(result.exit_code, 0);
  assert.equal(result.final_log.includes("ok"), true);
  assert.equal(result.final_log.includes("\u001b[32m"), false);
  assert.equal(result.final_log.includes("warn"), true);
});

test("job manager enforces maxConcurrentJobs by rejecting overflow submits", async () => {
  const manager = new JobManager(createConfig({ maxConcurrentJobs: 1 }));
  const submit = await manager.submit({
    cli_cmd: shellCommand,
    args: ["-lc", "sleep 0.3; printf 'done\\n'"],
    working_dir: workingDir,
  });

  await assert.rejects(
    manager.submit({
      cli_cmd: shellCommand,
      args: ["-lc", "printf 'second\\n'"],
      working_dir: workingDir,
    }),
    /maxConcurrentJobs reached/,
  );

  await waitForCompletion(manager, submit.job_id);
});

test("job manager cancels a running process", async () => {
  const manager = new JobManager(createConfig());
  const submit = await manager.submit({
    cli_cmd: shellCommand,
    args: ["-lc", "while true; do printf 'tick\\n'; sleep 0.05; done"],
    working_dir: workingDir,
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancelled = manager.cancel(submit.job_id);
  const status = await waitForCompletion(manager, submit.job_id);

  assert.equal(cancelled.status, "cancelled");
  assert.equal(status.status, "cancelled");
});

test("job manager times out long-running processes", async () => {
  const manager = new JobManager(createConfig({ defaultTimeoutSeconds: 1 }));
  const submit = await manager.submit({
    cli_cmd: shellCommand,
    args: ["-lc", "sleep 3; printf 'late\\n'"],
    working_dir: workingDir,
  });

  const status = await waitForCompletion(manager, submit.job_id, 4000);
  assert.equal(status.status, "timed_out");
});

test("job manager truncates oversized final logs", async () => {
  const manager = new JobManager(createConfig({ maxLogChars: 4000 }));
  const submit = await manager.submit({
    cli_cmd: shellCommand,
    args: ["-lc", "python3 - <<'PY'\nprint('x' * 5001)\nPY"],
    working_dir: workingDir,
  });

  await waitForCompletion(manager, submit.job_id);
  const result = manager.getResult(submit.job_id);

  assert.equal(result.is_truncated, true);
  assert.equal(result.final_log.includes("[省略中间日志]"), true);
});

test("job manager notifies completion when session context exists", async () => {
  const notifications: string[] = [];
  const manager = new JobManager(createConfig(), {
    completionNotifier: {
      notify(job) {
        notifications.push(`${job.jobId}:${job.status}:${job.originSessionKey}`);
      },
    },
  });

  const submit = await manager.submit({
    cli_cmd: shellCommand,
    args: ["-lc", "printf 'done\\n'"],
    working_dir: workingDir,
    _openclaw_session_key: "agent:main:main",
    _openclaw_agent_id: "main",
  });

  await waitForCompletion(manager, submit.job_id);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.includes("agent:main:main"), true);
});

test("job manager can attach origin after completion and notify once", async () => {
  const notifications: string[] = [];
  const manager = new JobManager(createConfig(), {
    completionNotifier: {
      notify(job) {
        notifications.push(`${job.jobId}:${job.status}:${job.originSessionKey}`);
      },
    },
  });

  const submit = await manager.submit({
    cli_cmd: shellCommand,
    args: ["-lc", "printf 'done\\n'"],
    working_dir: workingDir,
    notify_on_completion: true,
  });

  await waitForCompletion(manager, submit.job_id);
  assert.equal(notifications.length, 0);

  manager.attachOrigin(submit.job_id, {
    originSessionKey: "agent:main:main",
    originAgentId: "main",
  });
  manager.attachOrigin(submit.job_id, {
    originSessionKey: "agent:main:main",
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.includes("agent:main:main"), true);
});
