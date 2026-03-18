import type {
  CancelResponse,
  JobRecord,
  OpenClawPluginApi,
  PluginConfig,
  ResultResponse,
  StatusResponse,
  SubmitParams,
  SubmitResponse,
} from "../types.ts";
import { createJobId } from "../utils/id.ts";
import { validateSubmitParams } from "../utils/validate.ts";
import { JobStore } from "./store.ts";
import { LogBuffer } from "./log-buffer.ts";
import { spawnProcess, stopProcess } from "./process-runner.ts";

function nowIso(): string {
  return new Date().toISOString();
}

export interface JobCompletionNotifier {
  notify(job: JobRecord): void;
}

export interface JobOriginMetadata {
  originSessionKey?: string | null;
  originAgentId?: string | null;
  originRunId?: string | null;
  notifyOnCompletion?: boolean;
}

function buildSummary(job: JobRecord): string {
  return [
    `status=${job.status}`,
    `command=${job.cliCmd}`,
    `working_dir=${job.workingDir}`,
    `exit_code=${job.exitCode ?? "null"}`,
    `stdout_bytes=${job.stdoutBytes}`,
    `stderr_bytes=${job.stderrBytes}`,
    `truncated=${job.isTruncated}`,
  ].join("; ");
}

function toStatusResponse(job: JobRecord): StatusResponse {
  return {
    job_id: job.jobId,
    status: job.status,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    exit_code: job.exitCode,
    last_update_at: job.lastUpdateAt,
    stdout_bytes: job.stdoutBytes,
    stderr_bytes: job.stderrBytes,
    combined_preview: job.combinedPreview,
    is_truncated: job.isTruncated,
  };
}

function toResultResponse(job: JobRecord): ResultResponse {
  return {
    job_id: job.jobId,
    status: job.status,
    exit_code: job.exitCode,
    summary: buildSummary(job),
    final_log: job.finalLog ?? job.combinedPreview,
    is_truncated: job.isTruncated,
    finished_at: job.finishedAt,
  };
}

export class JobManager {
  private config: PluginConfig;
  private readonly store = new JobStore();
  private activeJobs = 0;
  private completionNotifier?: JobCompletionNotifier;

  constructor(config: PluginConfig, options?: { completionNotifier?: JobCompletionNotifier }) {
    this.config = config;
    this.completionNotifier = options?.completionNotifier;
  }

  updateConfig(config: PluginConfig): void {
    this.config = config;
  }

  async submit(params: SubmitParams): Promise<SubmitResponse> {
    const input = validateSubmitParams(params, this.config);

    if (this.activeJobs >= this.config.maxConcurrentJobs) {
      throw new Error("maxConcurrentJobs reached");
    }

    const jobId = createJobId();
    const acceptedAt = nowIso();
    this.activeJobs += 1;
    const job: JobRecord = {
      jobId,
      label: input.label,
      cliCmd: input.cliCmd,
      args: input.args,
      workingDir: input.workingDir,
      timeoutSeconds: input.timeoutSeconds,
      notifyOnCompletion: input.notifyOnCompletion,
      originSessionKey: input.originSessionKey,
      originAgentId: input.originAgentId,
      originRunId: input.originRunId,
      status: "queued",
      startedAt: null,
      finishedAt: null,
      lastUpdateAt: null,
      exitCode: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      combinedPreview: "",
      finalLog: null,
      isTruncated: false,
      cancelRequestedAt: null,
      stdoutClosed: false,
      stderrClosed: false,
      processExited: false,
      terminationReason: null,
      finalizationError: null,
      completionNotified: false,
    };

    this.store.set(job);
    queueMicrotask(() => {
      void this.startJob(jobId);
    });

    return {
      job_id: jobId,
      status: "accepted",
      started_at: acceptedAt,
      working_dir: input.workingDir,
    };
  }

  getStatus(jobId: string): StatusResponse {
    return toStatusResponse(this.requireJob(jobId));
  }

  getResult(jobId: string): ResultResponse {
    return toResultResponse(this.requireJob(jobId));
  }

  cancel(jobId: string): CancelResponse {
    const job = this.requireJob(jobId);

    if (job.status === "succeeded" || job.status === "failed" || job.status === "timed_out" ||
      job.status === "cancelled") {
      return {
        job_id: job.jobId,
        status: job.status,
        cancelled_at: job.cancelRequestedAt,
      };
    }

    const cancelledAt = nowIso();
    job.cancelRequestedAt = cancelledAt;
    job.terminationReason = "cancel";
    job.status = "cancelled";

    if (job.child) {
      stopProcess(job.child);
    } else {
      job.processExited = true;
      job.stdoutClosed = true;
      job.stderrClosed = true;
      this.finalizeJob(job);
    }

    return {
      job_id: job.jobId,
      status: job.status,
      cancelled_at: cancelledAt,
    };
  }

  attachOrigin(jobId: string, metadata: JobOriginMetadata): void {
    const job = this.requireJob(jobId);

    if (typeof metadata.originSessionKey === "string" && metadata.originSessionKey.length > 0) {
      job.originSessionKey = metadata.originSessionKey;
    }
    if (typeof metadata.originAgentId === "string" && metadata.originAgentId.length > 0) {
      job.originAgentId = metadata.originAgentId;
    }
    if (typeof metadata.originRunId === "string" && metadata.originRunId.length > 0) {
      job.originRunId = metadata.originRunId;
    }
    if (typeof metadata.notifyOnCompletion === "boolean") {
      job.notifyOnCompletion = metadata.notifyOnCompletion;
    }

    this.notifyCompletion(job);
  }

  private async startJob(jobId: string): Promise<void> {
    const job = this.store.get(jobId);
    if (!job || job.status === "cancelled") {
      return;
    }

    const logBuffer = new LogBuffer(this.config);

    try {
      const child = spawnProcess(job.cliCmd, job.args, job.workingDir);
      job.child = child;
      job.childPid = child.pid;
      job.status = "running";
      job.startedAt = nowIso();

      job.timeoutHandle = setTimeout(() => {
        job.terminationReason = "timeout";
        job.status = "timed_out";
        stopProcess(child);
      }, job.timeoutSeconds * 1000);

      child.stdout.on("data", (chunk: Buffer) => {
        const snapshot = logBuffer.append("stdout", chunk);
        job.stdoutBytes = snapshot.stdoutBytes;
        job.stderrBytes = snapshot.stderrBytes;
        job.combinedPreview = snapshot.combinedPreview;
        job.lastUpdateAt = snapshot.lastUpdateAt;
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const snapshot = logBuffer.append("stderr", chunk);
        job.stdoutBytes = snapshot.stdoutBytes;
        job.stderrBytes = snapshot.stderrBytes;
        job.combinedPreview = snapshot.combinedPreview;
        job.lastUpdateAt = snapshot.lastUpdateAt;
      });

      const closedStreams = {
        stdout: false,
        stderr: false,
      };

      const markStreamClosed = (stream: "stdout" | "stderr") => {
        if (closedStreams[stream]) {
          return;
        }
        closedStreams[stream] = true;

        if (stream === "stdout") {
          job.stdoutClosed = true;
        } else {
          job.stderrClosed = true;
        }

        const snapshot = logBuffer.flush();
        job.stdoutBytes = snapshot.stdoutBytes;
        job.stderrBytes = snapshot.stderrBytes;
        job.combinedPreview = snapshot.combinedPreview;
        job.lastUpdateAt = snapshot.lastUpdateAt;
        this.finalizeJob(job, logBuffer);
      };

      child.stdout.once("end", () => markStreamClosed("stdout"));
      child.stdout.once("close", () => markStreamClosed("stdout"));
      child.stderr.once("end", () => markStreamClosed("stderr"));
      child.stderr.once("close", () => markStreamClosed("stderr"));

      child.once("error", (error) => {
        job.finalizationError = error.message;
        job.exitCode = 1;
        job.processExited = true;
        job.stdoutClosed = true;
        job.stderrClosed = true;
        if (job.status === "running") {
          job.status = "failed";
        }
        this.finalizeJob(job, logBuffer);
      });

      child.once("exit", (code) => {
        job.processExited = true;
        job.exitCode = code ?? (job.terminationReason ? 0 : 1);

        if (job.terminationReason === "timeout") {
          job.status = "timed_out";
        } else if (job.terminationReason === "cancel") {
          job.status = "cancelled";
        } else if (job.finalizationError) {
          job.status = "failed";
        } else {
          job.status = code === 0 ? "succeeded" : "failed";
        }

        this.finalizeJob(job, logBuffer);
      });
    } catch (error) {
      job.status = "failed";
      job.finalizationError = error instanceof Error ? error.message : String(error);
      job.exitCode = 1;
      job.startedAt = job.startedAt ?? nowIso();
      job.processExited = true;
      job.stdoutClosed = true;
      job.stderrClosed = true;
      this.finalizeJob(job, logBuffer);
    }
  }

  private finalizeJob(job: JobRecord, logBuffer?: LogBuffer): void {
    if (!job.processExited || !job.stdoutClosed || !job.stderrClosed || job.finishedAt) {
      return;
    }

    if (job.timeoutHandle) {
      clearTimeout(job.timeoutHandle);
      job.timeoutHandle = undefined;
    }

    if (logBuffer) {
      const finalLog = logBuffer.finalize();
      job.finalLog = finalLog.finalLog;
      job.isTruncated = finalLog.isTruncated;
      const snapshot = logBuffer.snapshot();
      job.stdoutBytes = snapshot.stdoutBytes;
      job.stderrBytes = snapshot.stderrBytes;
      job.combinedPreview = snapshot.combinedPreview;
      job.lastUpdateAt = snapshot.lastUpdateAt;
    } else if (job.finalLog === null) {
      job.finalLog = job.combinedPreview;
      job.isTruncated = false;
    }

    job.finishedAt = nowIso();
    if (this.activeJobs > 0) {
      this.activeJobs -= 1;
    }
    job.child = undefined;
    this.notifyCompletion(job);
  }

  private requireJob(jobId: string): JobRecord {
    const job = this.store.get(jobId);
    if (!job) {
      throw new Error(`job not found: ${jobId}`);
    }
    return job;
  }

  private notifyCompletion(job: JobRecord): void {
    if (!job.finishedAt || job.completionNotified || !job.notifyOnCompletion || !job.originSessionKey) {
      return;
    }

    job.completionNotified = true;
    this.completionNotifier?.notify(job);
  }
}
