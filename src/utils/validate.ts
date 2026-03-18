import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { OpenClawPluginApi, PluginConfig, SubmitParams } from "../types.ts";
import { PLUGIN_ID } from "../types.ts";

const DEFAULT_CONFIG: PluginConfig = {
  allowedCommands: ["claude", "codex", "gemini"],
  allowedWorkingDirs: ["/workspace", "/home/pc/.openclaw/workspace/cc-jobs"],
  defaultWorkingDir: "/home/pc/.openclaw/workspace/cc-jobs",
  commandPrefix: "/cc",
  defaultTimeoutSeconds: 900,
  maxLogChars: 4000,
  previewFlushBytes: 1024,
  previewFlushIntervalMs: 500,
  maxConcurrentJobs: 4,
  deliverToChannelOnCompletion: true,
};

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : fallback;
}

function asPositiveInteger(value: unknown, fallback: number, minimum = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.trunc(value);
  return normalized >= minimum ? normalized : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function normalizePluginConfig(raw: unknown): PluginConfig {
  const config = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};

  return {
    allowedCommands: asStringArray(config.allowedCommands, DEFAULT_CONFIG.allowedCommands),
    allowedWorkingDirs: asStringArray(
      config.allowedWorkingDirs,
      DEFAULT_CONFIG.allowedWorkingDirs,
    ),
    defaultWorkingDir: asString(config.defaultWorkingDir, DEFAULT_CONFIG.defaultWorkingDir),
    commandPrefix: asString(config.commandPrefix, DEFAULT_CONFIG.commandPrefix),
    defaultTimeoutSeconds: asPositiveInteger(
      config.defaultTimeoutSeconds,
      DEFAULT_CONFIG.defaultTimeoutSeconds,
    ),
    maxLogChars: asPositiveInteger(config.maxLogChars, DEFAULT_CONFIG.maxLogChars, 4000),
    previewFlushBytes: asPositiveInteger(
      config.previewFlushBytes,
      DEFAULT_CONFIG.previewFlushBytes,
    ),
    previewFlushIntervalMs: asPositiveInteger(
      config.previewFlushIntervalMs,
      DEFAULT_CONFIG.previewFlushIntervalMs,
    ),
    maxConcurrentJobs: asPositiveInteger(
      config.maxConcurrentJobs,
      DEFAULT_CONFIG.maxConcurrentJobs,
    ),
    deliverToChannelOnCompletion: asBoolean(
      config.deliverToChannelOnCompletion,
      DEFAULT_CONFIG.deliverToChannelOnCompletion,
    ),
  };
}

export function resolvePluginConfig(api: OpenClawPluginApi): PluginConfig {
  const apiLike = api as OpenClawPluginApi & {
    config?: Record<string, unknown>;
    pluginConfig?: unknown;
  };

  if (apiLike.pluginConfig) {
    return normalizePluginConfig(apiLike.pluginConfig);
  }

  const pluginEntryConfig = apiLike.config &&
    typeof apiLike.config === "object" &&
    "plugins" in apiLike.config
    ? (apiLike.config as {
        plugins?: {
          entries?: Record<string, { config?: unknown }>;
        };
      }).plugins?.entries?.[PLUGIN_ID]?.config
    : undefined;

  if (pluginEntryConfig) {
    return normalizePluginConfig(pluginEntryConfig);
  }

  return normalizePluginConfig({});
}

function ensureDirectoryExists(directory: string): string {
  const resolved = realpathSync(directory);
  const stats = statSync(resolved);

  if (!stats.isDirectory()) {
    throw new Error("working_dir must be a directory");
  }

  return resolved;
}

function isWithinAllowedDir(candidate: string, allowedDir: string): boolean {
  const relative = path.relative(allowedDir, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export interface ValidatedSubmitInput {
  cliCmd: string;
  args: string[];
  workingDir: string;
  timeoutSeconds: number;
  label?: string;
  notifyOnCompletion: boolean;
  originSessionKey: string | null;
  originAgentId: string | null;
  originRunId: string | null;
}

export function validateSubmitParams(
  params: SubmitParams,
  config: PluginConfig,
): ValidatedSubmitInput {
  if (!params || typeof params !== "object") {
    throw new Error("submit parameters must be an object");
  }

  if (typeof params.cli_cmd !== "string" || params.cli_cmd.length === 0) {
    throw new Error("cli_cmd must be a non-empty string");
  }

  if (!config.allowedCommands.includes(params.cli_cmd)) {
    throw new Error(`cli_cmd is not allowed: ${params.cli_cmd}`);
  }

  if (!Array.isArray(params.args) || params.args.some((value) => typeof value !== "string")) {
    throw new Error("args must be a string array");
  }

  if (typeof params.working_dir !== "string" || !path.isAbsolute(params.working_dir)) {
    throw new Error("working_dir must be an absolute path");
  }

  if (config.allowedWorkingDirs.length === 0) {
    throw new Error("plugin configuration has no allowedWorkingDirs");
  }

  const resolvedWorkingDir = ensureDirectoryExists(params.working_dir);
  const resolvedAllowedDirs = config.allowedWorkingDirs.map((entry) => ensureDirectoryExists(entry));

  if (!resolvedAllowedDirs.some((entry) => isWithinAllowedDir(resolvedWorkingDir, entry))) {
    throw new Error("working_dir is outside allowedWorkingDirs");
  }

  const timeoutSeconds = params.timeout_seconds === undefined
    ? config.defaultTimeoutSeconds
    : asPositiveInteger(params.timeout_seconds, Number.NaN);

  if (!Number.isFinite(timeoutSeconds)) {
    throw new Error("timeout_seconds must be a positive integer");
  }

  if (params.label !== undefined && typeof params.label !== "string") {
    throw new Error("label must be a string when provided");
  }

  return {
    cliCmd: params.cli_cmd,
    args: [...params.args],
    workingDir: resolvedWorkingDir,
    timeoutSeconds,
    label: params.label,
    notifyOnCompletion: params.notify_on_completion ?? true,
    originSessionKey: typeof params._openclaw_session_key === "string"
      ? params._openclaw_session_key
      : null,
    originAgentId: typeof params._openclaw_agent_id === "string"
      ? params._openclaw_agent_id
      : null,
    originRunId: typeof params._openclaw_run_id === "string" ? params._openclaw_run_id : null,
  };
}
