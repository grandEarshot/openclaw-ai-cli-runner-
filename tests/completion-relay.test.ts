import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JobRecord, OpenClawPluginApi } from "../src/types.ts";
import { CompletionRelay } from "../src/runtime/completion-relay.ts";
import { appendAssistantTranscriptMessage } from "../src/runtime/session-transcript.ts";

async function createSessionFixture(): Promise<{
  cleanup: () => Promise<void>;
  sessionFile: string;
  sessionKey: string;
  storePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-ai-cli-runner-"));
  const sessionKey = "agent:main:main";
  const sessionId = "session-test-123";
  const sessionFile = path.join(rootDir, `${sessionId}.jsonl`);
  const storePath = path.join(rootDir, "sessions.json");

  await writeFile(storePath, `${JSON.stringify({
    [sessionKey]: {
      sessionId,
      updatedAt: 0,
      sessionFile,
    },
  }, null, 2)}\n`, "utf-8");

  return {
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
    sessionFile,
    sessionKey,
    storePath,
  };
}

function createApi(storePath: string): OpenClawPluginApi & {
  events: Array<{ text: string; sessionKey: string }>;
  heartbeats: Array<{ sessionKey?: string; agentId?: string }>;
} {
  const events: Array<{ text: string; sessionKey: string }> = [];
  const heartbeats: Array<{ sessionKey?: string; agentId?: string }> = [];

  return {
    events,
    heartbeats,
    registerTool() {},
    runtime: {
      config: {
        loadConfig() {
          return {
            session: {
              store: storePath,
            },
          };
        },
      },
      channel: {
        session: {
          resolveStorePath(store) {
            return store ?? storePath;
          },
        },
      },
      system: {
        enqueueSystemEvent(text, options) {
          events.push({ text, sessionKey: options.sessionKey });
          return true;
        },
        requestHeartbeatNow(options) {
          heartbeats.push({
            sessionKey: options?.sessionKey,
            agentId: options?.agentId,
          });
        },
      },
    },
  };
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

test("appendAssistantTranscriptMessage writes a visible assistant message to the session transcript", async () => {
  const fixture = await createSessionFixture();
  try {
    const api = createApi(fixture.storePath);
    const result = await appendAssistantTranscriptMessage(api, {
      agentId: "main",
      sessionKey: fixture.sessionKey,
      text: "Async completion visible reply",
    });

    assert.equal(result.ok, true);

    const transcript = await readFile(fixture.sessionFile, "utf-8");
    assert.equal(transcript.includes("Async completion visible reply"), true);
    assert.equal(transcript.includes("\"role\":\"assistant\""), true);

    const store = JSON.parse(await readFile(fixture.storePath, "utf-8")) as Record<string, {
      updatedAt?: number;
    }>;
    assert.equal(typeof store[fixture.sessionKey]?.updatedAt, "number");
    assert.equal((store[fixture.sessionKey]?.updatedAt ?? 0) > 0, true);
  } finally {
    await fixture.cleanup();
  }
});

test("CompletionRelay prefers transcript append over system events", async () => {
  const fixture = await createSessionFixture();
  try {
    const api = createApi(fixture.storePath);
    const relay = new CompletionRelay(api);
    const job: JobRecord = {
      jobId: "job-visible-1",
      label: "visible-test",
      cliCmd: "claude",
      args: ["-p", "Reply with exactly OK"],
      workingDir: "/tmp",
      timeoutSeconds: 30,
      notifyOnCompletion: true,
      originSessionKey: fixture.sessionKey,
      originAgentId: "main",
      originRunId: "run-visible-1",
      status: "succeeded",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      lastUpdateAt: new Date().toISOString(),
      exitCode: 0,
      stdoutBytes: 2,
      stderrBytes: 0,
      combinedPreview: "OK\n",
      finalLog: "OK\n",
      isTruncated: false,
      cancelRequestedAt: null,
      stdoutClosed: true,
      stderrClosed: true,
      processExited: true,
      terminationReason: null,
      finalizationError: null,
      completionNotified: false,
    };

    relay.notify(job);

    await waitFor(async () => {
      const transcript = await readFile(fixture.sessionFile, "utf-8").catch(() => "");
      return transcript.includes("job-visible-1");
    });

    const transcript = await readFile(fixture.sessionFile, "utf-8");
    assert.equal(transcript.includes("Async AI CLI job completed."), true);
    assert.equal(transcript.includes("job-visible-1"), true);
    assert.equal(api.events.length, 0);
    assert.equal(api.heartbeats.length, 1);
    assert.equal(api.heartbeats[0]?.sessionKey, fixture.sessionKey);
  } finally {
    await fixture.cleanup();
  }
});

test("CompletionRelay formats Claude Code completion receipts for cc jobs", async () => {
  const fixture = await createSessionFixture();
  try {
    const api = createApi(fixture.storePath);
    const relay = new CompletionRelay(api);
    const job: JobRecord = {
      jobId: "job-cc-1",
      label: "cc:short",
      cliCmd: "claude",
      args: ["-p", "run analysis", "--output-format", "text", "--dangerously-skip-permissions"],
      workingDir: "/home/pc/projects",
      timeoutSeconds: 30,
      notifyOnCompletion: true,
      originSessionKey: fixture.sessionKey,
      originAgentId: "main",
      originRunId: "run-cc-1",
      status: "succeeded",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      lastUpdateAt: new Date().toISOString(),
      exitCode: 0,
      stdoutBytes: 10,
      stderrBytes: 0,
      combinedPreview: "ARCHITECTURE.md\nengine.js\nindex.html\ntests.js\n",
      finalLog: "ARCHITECTURE.md\nengine.js\nindex.html\ntests.js\n",
      isTruncated: false,
      cancelRequestedAt: null,
      stdoutClosed: true,
      stderrClosed: true,
      processExited: true,
      terminationReason: null,
      finalizationError: null,
      completionNotified: false,
    };

    relay.notify(job);

    await waitFor(async () => {
      const transcript = await readFile(fixture.sessionFile, "utf-8").catch(() => "");
      return transcript.includes("Claude Code任务完成");
    });

    const transcript = await readFile(fixture.sessionFile, "utf-8");
    assert.equal(transcript.includes("Claude Code任务完成"), true);
    assert.equal(transcript.includes("任务ID:job-cc-1"), true);
    assert.equal(transcript.includes("任务:run analysis"), true);
    assert.equal(transcript.includes("路径:/home/pc/projects"), true);
    assert.equal(transcript.includes("项目文件:"), true);
    assert.equal(transcript.includes("ARCHITECTURE.md"), true);
    assert.equal(transcript.includes("engine.js"), true);
    assert.equal(transcript.includes("index.html"), true);
    assert.equal(transcript.includes("tests.js"), true);
  } finally {
    await fixture.cleanup();
  }
});

test("CompletionRelay falls back to summary when no project files are detected", async () => {
  const fixture = await createSessionFixture();
  try {
    const api = createApi(fixture.storePath);
    const relay = new CompletionRelay(api);
    const job: JobRecord = {
      jobId: "job-cc-2",
      label: "cc:short",
      cliCmd: "claude",
      args: ["-p", "summarize logs", "--output-format", "text", "--dangerously-skip-permissions"],
      workingDir: "/home/pc/projects",
      timeoutSeconds: 30,
      notifyOnCompletion: true,
      originSessionKey: fixture.sessionKey,
      originAgentId: "main",
      originRunId: "run-cc-2",
      status: "succeeded",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      lastUpdateAt: new Date().toISOString(),
      exitCode: 0,
      stdoutBytes: 10,
      stderrBytes: 0,
      combinedPreview: "build finished successfully\nsecond line\n",
      finalLog: "build finished successfully\nsecond line\n",
      isTruncated: false,
      cancelRequestedAt: null,
      stdoutClosed: true,
      stderrClosed: true,
      processExited: true,
      terminationReason: null,
      finalizationError: null,
      completionNotified: false,
    };

    relay.notify(job);

    await waitFor(async () => {
      const transcript = await readFile(fixture.sessionFile, "utf-8").catch(() => "");
      return transcript.includes("任务:summarize logs");
    });

    const transcript = await readFile(fixture.sessionFile, "utf-8");
    assert.equal(transcript.includes("摘要:build finished successfully"), true);
    assert.equal(transcript.includes("项目文件:"), false);
  } finally {
    await fixture.cleanup();
  }
});
