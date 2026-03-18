import type { JobRecord, OpenClawPluginApi } from "../types.ts";
import { appendAssistantTranscriptMessage, readSessionChannelInfo } from "./session-transcript.ts";
import { resolvePluginConfig } from "../utils/validate.ts";
import { extractClaudeTaskFromArgs } from "../utils/cc-command.ts";
import { sendMessageToChannel } from "./channel-sender.ts";

function getCompletionOutput(job: JobRecord): string {
  return (job.finalLog ?? job.combinedPreview ?? "").trim();
}

function summarizeCompletionOutput(job: JobRecord, maxLength = 120): string {
  const output = getCompletionOutput(job);
  if (!output) {
    return "(no output)";
  }

  const firstLine = output.split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) {
    return "(no output)";
  }

  if (firstLine.length <= maxLength) {
    return firstLine;
  }

  return `${firstLine.slice(0, Math.max(1, maxLength - 3))}...`;
}

function looksLikeProjectFile(line: string): boolean {
  if (!line || line.length > 160) {
    return false;
  }

  if (/[<>{}]/.test(line) || /^https?:\/\//i.test(line)) {
    return false;
  }

  if (/\s{2,}/.test(line)) {
    return false;
  }

  const normalized = line.replace(/\\/g, "/");
  if (normalized.endsWith("/")) {
    return false;
  }

  if (
    /^(?:\.{0,2}\/)?[\w@][\w./-]*\.[A-Za-z0-9]+$/.test(normalized) ||
    /^(?:\.{0,2}\/)?(?:README(?:\.[A-Za-z0-9]+)?|LICENSE(?:\.[A-Za-z0-9]+)?|Dockerfile|Makefile)$/i
      .test(normalized)
  ) {
    return true;
  }

  return false;
}

function extractProjectFiles(job: JobRecord, maxFiles = 12): string[] {
  const output = getCompletionOutput(job);
  if (!output) {
    return [];
  }

  const files: string[] = [];
  const seen = new Set<string>();
  const lines = output.split(/\r?\n/);

  for (const rawLine of lines) {
    const candidate = rawLine
      .trim()
      .replace(/^[\-\*\u2022]+\s*/, "")
      .replace(/^\d+\.\s*/, "")
      .replace(/^`(.+)`$/, "$1")
      .replace(/^['"](.+)['"]$/, "$1")
      .trim();

    if (!looksLikeProjectFile(candidate)) {
      continue;
    }

    const normalized = candidate.replace(/\\/g, "/");
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    files.push(normalized);
    if (files.length >= maxFiles) {
      break;
    }
  }

  return files;
}

function formatCcCompletionEvent(job: JobRecord): string | null {
  if (!job.label?.startsWith("cc:")) {
    return null;
  }

  const task = extractClaudeTaskFromArgs(job.args) ?? job.label.slice(3);
  const files = extractProjectFiles(job);
  const lines = [
    job.status === "succeeded" ? "Claude Code任务完成" : "Claude Code任务结束",
    `任务:${task}`,
    `路径:${job.workingDir}`,
    `任务ID:${job.jobId}`,
  ];

  if (job.status !== "succeeded") {
    lines.push(`状态:${job.status}`);
  }

  if (job.exitCode !== null && job.exitCode !== 0) {
    lines.push(`退出码:${job.exitCode}`);
  }

  if (files.length > 0) {
    lines.push("项目文件:");
    lines.push(...files);
  } else {
    lines.push(`摘要:${summarizeCompletionOutput(job)}`);
  }

  return lines.join("\n");
}

function formatCompletionEvent(job: JobRecord): string {
  const cc = formatCcCompletionEvent(job);
  if (cc) {
    return cc;
  }

  return [
    "Async AI CLI job completed.",
    `job_id: ${job.jobId}`,
    `status: ${job.status}`,
    `command: ${job.cliCmd}`,
    `working_dir: ${job.workingDir}`,
    `exit_code: ${job.exitCode ?? "null"}`,
    job.label ? `label: ${job.label}` : null,
    "",
    "result:",
    (job.finalLog ?? job.combinedPreview).trim() || "(no output)",
  ].filter((line): line is string => line !== null).join("\n");
}

export class CompletionRelay {
  private readonly api: OpenClawPluginApi;

  constructor(api: OpenClawPluginApi) {
    this.api = api;
  }

  notify(job: JobRecord): void {
    const logger = this.api.logger;

    logger?.info?.("ai-cli completion relay: notify", {
      jobId: job.jobId,
      status: job.status,
      hasSessionKey: Boolean(job.originSessionKey),
      notifyOnCompletion: job.notifyOnCompletion,
    });

    if (!job.notifyOnCompletion || !job.originSessionKey) {
      return;
    }

    void this.notifyAsync(job);
  }

  private async notifyAsync(job: JobRecord): Promise<void> {
    const logger = this.api.logger;
    const requestHeartbeatNow = this.api.runtime?.system?.requestHeartbeatNow;
    const enqueueSystemEvent = this.api.runtime?.system?.enqueueSystemEvent;
    const heartbeatOptions = {
      reason: `ai-cli-job:${job.jobId}`,
      sessionKey: job.originSessionKey ?? undefined,
      agentId: job.originAgentId ?? undefined,
      coalesceMs: 250,
    };

    let channelInfo: Awaited<ReturnType<typeof readSessionChannelInfo>> | null = null;

    if (job.originSessionKey && enqueueSystemEvent && requestHeartbeatNow) {
      channelInfo = await readSessionChannelInfo(this.api, {
        sessionKey: job.originSessionKey,
        agentId: job.originAgentId,
      }).catch(() => null);

      const isWebchat = channelInfo?.provider === "webchat" ||
        channelInfo?.deliveryChannel === "webchat" ||
        channelInfo?.lastChannel === "webchat";
      if (isWebchat) {
        const enqueued = enqueueSystemEvent(formatCompletionEvent(job), {
          sessionKey: job.originSessionKey,
          contextKey: `ai-cli-job:${job.jobId}`,
        });

        logger?.info?.("ai-cli completion relay: webchat system event", {
          jobId: job.jobId,
          enqueued,
          sessionKey: job.originSessionKey,
        });

        if (enqueued) {
          requestHeartbeatNow(heartbeatOptions);
        }
      }
    }

    const transcriptResult = await appendAssistantTranscriptMessage(this.api, {
      agentId: job.originAgentId,
      sessionKey: job.originSessionKey ?? "",
      text: formatCompletionEvent(job),
    }).catch((error: unknown) => ({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }));

    logger?.info?.("ai-cli completion relay: transcript append result", {
      jobId: job.jobId,
      ok: transcriptResult.ok,
      reason: transcriptResult.ok ? null : transcriptResult.reason ?? "unknown error",
      sessionFile: transcriptResult.ok ? transcriptResult.sessionFile ?? null : null,
    });

    if (transcriptResult.ok) {
      requestHeartbeatNow?.(heartbeatOptions);
      if (job.originSessionKey) {
        if (!channelInfo) {
          channelInfo = await readSessionChannelInfo(this.api, {
            sessionKey: job.originSessionKey,
            agentId: job.originAgentId,
          }).catch(() => null);
        }
        const config = resolvePluginConfig(this.api);
        if (config.deliverToChannelOnCompletion && channelInfo) {
          await sendCompletionToChannel(this.api, job, channelInfo);
        }
      }
      return;
    }

    logger?.info?.("ai-cli completion relay: runtime check", {
      hasEnqueueSystemEvent: Boolean(enqueueSystemEvent),
      hasRequestHeartbeatNow: Boolean(requestHeartbeatNow),
    });

    if (!enqueueSystemEvent || !requestHeartbeatNow) {
      return;
    }

    const enqueued = enqueueSystemEvent(formatCompletionEvent(job), {
      sessionKey: job.originSessionKey,
      contextKey: `ai-cli-job:${job.jobId}`,
    });

    logger?.info?.("ai-cli completion relay: enqueue result", {
      jobId: job.jobId,
      enqueued,
      sessionKey: job.originSessionKey,
    });

    if (!enqueued) {
      return;
    }

    requestHeartbeatNow(heartbeatOptions);
  }
}

async function sendCompletionToChannel(
  api: OpenClawPluginApi,
  job: JobRecord,
  channelInfo: {
    deliveryChannel?: string;
    deliveryTo?: string;
    deliveryAccountId?: string;
    lastChannel?: string;
    lastTo?: string;
    lastAccountId?: string;
  },
): Promise<void> {
  const message = formatCompletionEvent(job);
  await sendMessageToChannel(api, message, channelInfo, {
    agentId: job.originAgentId ?? undefined,
    sessionKey: job.originSessionKey ?? undefined,
  });
}
