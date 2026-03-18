import type { ChildProcessWithoutNullStreams } from "node:child_process";

export const PLUGIN_ID = "openclaw-ai-cli-runner";
export const LOG_OMISSION_MARKER = "\n... [省略中间日志] ...\n";
export const LOG_TRUNCATE_HEAD_CHARS = 1000;
export const LOG_TRUNCATE_TAIL_CHARS = 2000;

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface PluginConfig {
  allowedCommands: string[];
  allowedWorkingDirs: string[];
  defaultWorkingDir: string;
  commandPrefix: string;
  defaultTimeoutSeconds: number;
  maxLogChars: number;
  previewFlushBytes: number;
  previewFlushIntervalMs: number;
  maxConcurrentJobs: number;
  deliverToChannelOnCompletion: boolean;
}

export interface SubmitParams {
  cli_cmd: string;
  args: string[];
  working_dir: string;
  timeout_seconds?: number;
  label?: string;
  notify_on_completion?: boolean;
  _openclaw_session_key?: string;
  _openclaw_agent_id?: string;
  _openclaw_run_id?: string;
}

export interface JobRecord {
  jobId: string;
  label?: string;
  cliCmd: string;
  args: string[];
  workingDir: string;
  timeoutSeconds: number;
  notifyOnCompletion: boolean;
  originSessionKey: string | null;
  originAgentId: string | null;
  originRunId: string | null;
  status: JobStatus;
  startedAt: string | null;
  finishedAt: string | null;
  lastUpdateAt: string | null;
  exitCode: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  combinedPreview: string;
  finalLog: string | null;
  isTruncated: boolean;
  childPid?: number;
  cancelRequestedAt: string | null;
  child?: ChildProcessWithoutNullStreams;
  timeoutHandle?: NodeJS.Timeout;
  stdoutClosed: boolean;
  stderrClosed: boolean;
  processExited: boolean;
  terminationReason: "timeout" | "cancel" | null;
  finalizationError: string | null;
  completionNotified: boolean;
}

export interface StatusResponse {
  job_id: string;
  status: JobStatus;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  last_update_at: string | null;
  stdout_bytes: number;
  stderr_bytes: number;
  combined_preview: string;
  is_truncated: boolean;
}

export interface ResultResponse {
  job_id: string;
  status: JobStatus;
  exit_code: number | null;
  summary: string;
  final_log: string;
  is_truncated: boolean;
  finished_at: string | null;
}

export interface CancelResponse {
  job_id: string;
  status: JobStatus;
  cancelled_at: string | null;
}

export interface SubmitResponse {
  job_id: string;
  status: "accepted";
  started_at: string;
  working_dir: string;
}

export interface ToolContentText {
  type: "text";
  text: string;
}

export interface ToolResponse {
  content: ToolContentText[];
}

export interface OpenClawToolDefinition<TParams> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (invocationId: string, params: TParams) => Promise<ToolResponse>;
}

export interface OpenClawPluginCommandContext {
  senderId?: string;
  channel: string;
  channelId?: string;
  isAuthorizedSender: boolean;
  args?: string;
  commandBody: string;
  config?: unknown;
  from?: string;
  to?: string;
  accountId?: string;
  messageThreadId?: number;
}

export interface OpenClawPluginCommandResult {
  text?: string;
  [key: string]: unknown;
}

export interface OpenClawPluginCommandDefinition {
  name: string;
  nativeNames?: Partial<Record<string, string>> & { default?: string };
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (
    context: OpenClawPluginCommandContext,
  ) => OpenClawPluginCommandResult | Promise<OpenClawPluginCommandResult>;
}

export interface OpenClawPluginApi {
  config?: unknown;
  pluginConfig?: unknown;
  logger?: {
    debug?: (message: string, meta?: Record<string, unknown>) => void;
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
  registerTool: (
    tool: OpenClawToolDefinition<any>,
    options?: { optional?: boolean },
  ) => void;
  registerCommand?: (command: OpenClawPluginCommandDefinition) => void;
  registerHook?: (
    events: string | string[],
    handler: (event: any, context: any) => unknown,
    options?: { priority?: number },
  ) => void;
  on?: (
    hookName: string,
    handler: (event: any, context: any) => unknown,
    options?: { priority?: number },
  ) => void;
  runtime?: {
    config?: {
      loadConfig?: () => { session?: { store?: string } } | undefined;
    };
    system?: {
      enqueueSystemEvent?: (text: string, options: {
        sessionKey: string;
        contextKey?: string | null;
      }) => boolean;
      requestHeartbeatNow?: (options?: {
        reason?: string;
        sessionKey?: string;
        agentId?: string;
        coalesceMs?: number;
      }) => void;
    };
    channel?: {
      session?: {
        resolveStorePath?: (store?: string, options?: { agentId?: string }) => string;
      };
    };
  };
}
