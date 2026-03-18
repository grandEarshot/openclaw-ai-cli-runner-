import type { OpenClawPluginApi, OpenClawPluginCommandContext } from "../types.ts";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getJobManager } from "./runtime-context.ts";
import { resolvePluginConfig } from "../utils/validate.ts";
import {
  buildCcSubmitParams,
  formatCcDispatchFailure,
  formatCcDispatchReceipt,
  formatCcParseError,
  parseCcCommand,
} from "../utils/cc-command.ts";

interface ChannelInfo {
  deliveryChannel?: string;
  deliveryTo?: string;
}

function normalizeChannel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function buildCommandChannelInfo(context: OpenClawPluginCommandContext): ChannelInfo | null {
  const channel = normalizeChannel(context.channelId ?? context.channel);
  const to = typeof context.to === "string" && context.to.trim().length > 0 ? context.to.trim() : null;

  if (!channel || !to) {
    return null;
  }

  return {
    deliveryChannel: channel,
    deliveryTo: to,
  };
}

function extractCommandTargets(context: OpenClawPluginCommandContext): string[] {
  const targets: string[] = [];
  const candidates = [context.to, context.from];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      targets.push(candidate.trim());
    }
  }

  return targets;
}

function parseCcInvocation(
  context: OpenClawPluginCommandContext,
  prefix: string,
) {
  const directMatch = parseCcCommand(context.commandBody, prefix);
  if (directMatch) {
    return directMatch;
  }

  const reconstructed = context.args?.trim()
    ? `${prefix} ${context.args.trim()}`
    : prefix;
  return parseCcCommand(reconstructed, prefix);
}

interface SessionStoreEntry {
  origin?: {
    provider?: string;
    surface?: string;
    from?: string;
    to?: string;
    accountId?: string;
  };
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
  };
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
}

type SessionStore = Record<string, SessionStoreEntry>;

function resolveStorePath(api: OpenClawPluginApi, agentId?: string | null): string | null {
  const runtimeStoreResolver = api.runtime?.channel?.session?.resolveStorePath;
  if (!runtimeStoreResolver) {
    return null;
  }

  try {
    const store = api.runtime?.config?.loadConfig?.()?.session?.store;
    return runtimeStoreResolver(store, {
      agentId: typeof agentId === "string" && agentId.length > 0 ? agentId : undefined,
    });
  } catch {
    return null;
  }
}

async function loadSessionStore(storePath: string): Promise<SessionStore | null> {
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as SessionStore : null;
  } catch {
    return null;
  }
}

function entryMatchesSession(
  entry: SessionStoreEntry,
  channel: string,
  targets: string[],
  accountId?: string,
): boolean {
  const channelCandidates = [
    entry.deliveryContext?.channel,
    entry.lastChannel,
    entry.origin?.provider,
    entry.origin?.surface,
  ].filter((value): value is string => typeof value === "string");

  if (!channelCandidates.some((candidate) => candidate.toLowerCase() === channel)) {
    return false;
  }

  const targetCandidates = [
    entry.deliveryContext?.to,
    entry.lastTo,
    entry.origin?.to,
    entry.origin?.from,
  ].filter((value): value is string => typeof value === "string");

  if (!targets.some((target) => targetCandidates.includes(target))) {
    return false;
  }

  if (accountId) {
    const accountCandidates = [
      entry.deliveryContext?.accountId,
      entry.lastAccountId,
      entry.origin?.accountId,
    ].filter((value): value is string => typeof value === "string");
    if (!accountCandidates.includes(accountId)) {
      return false;
    }
  }

  return true;
}

async function resolveSessionKey(
  api: OpenClawPluginApi,
  options: {
    channelInfo: ChannelInfo | null;
    accountId?: string;
    agentId?: string;
    targets?: string[];
  },
): Promise<string | null> {
  if (!options.channelInfo) {
    return null;
  }

  const channel = options.channelInfo.deliveryChannel ?? options.channelInfo.lastChannel ?? null;
  if (!channel) {
    return null;
  }

  const targets = options.targets ?? [];
  const storePaths = new Set<string>();

  const agentCandidates = [options.agentId, "main"].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  for (const agentId of agentCandidates) {
    const storePath = resolveStorePath(api, agentId);
    if (storePath) {
      storePaths.add(storePath);
    }
  }

  if (storePaths.size === 0) {
    const agentsRoot = path.join(os.homedir(), ".openclaw", "agents");
    try {
      const agents = await fs.readdir(agentsRoot, { withFileTypes: true });
      for (const entry of agents) {
        if (!entry.isDirectory()) {
          continue;
        }
        const storePath = path.join(agentsRoot, entry.name, "sessions", "sessions.json");
        storePaths.add(storePath);
      }
    } catch {
      // ignore
    }
  }

  for (const storePath of storePaths) {
    const store = await loadSessionStore(storePath);
    if (!store) {
      continue;
    }
    for (const [sessionKey, entry] of Object.entries(store)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      if (entryMatchesSession(entry, channel, targets, options.accountId)) {
        return sessionKey;
      }
    }
  }

  return null;
}

export async function handleCcCommand(
  api: OpenClawPluginApi,
  context: OpenClawPluginCommandContext,
): Promise<{ text: string }> {
  const config = resolvePluginConfig(api);
  const parseResult = parseCcInvocation(context, config.commandPrefix);
  if (!parseResult) {
    return { text: formatCcParseError({ ok: false, reason: "missing_task" }) };
  }

  if (!parseResult.ok) {
    return { text: formatCcParseError(parseResult) };
  }

  const workingDir = parseResult.workingDir ?? config.defaultWorkingDir;
  const sessionKey = await resolveSessionKey(api, {
    channelInfo: buildCommandChannelInfo(context),
    accountId: context.accountId,
    targets: extractCommandTargets(context),
  });
  try {
    const submitParams = buildCcSubmitParams({
      task: parseResult.task,
      workingDir,
      sessionKey,
    });

    const result = await getJobManager(api).submit(submitParams);
    return { text: formatCcDispatchReceipt(parseResult.task, workingDir, result.job_id) };
  } catch (error) {
    return {
      text: formatCcDispatchFailure(
        parseResult.task,
        workingDir,
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}
