import type { OpenClawPluginApi } from "../types.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface ChannelInfo {
  deliveryChannel?: string;
  deliveryTo?: string;
  deliveryAccountId?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
}

type MessageActionRunner = (input: {
  cfg: Record<string, unknown>;
  action: string;
  params: Record<string, unknown>;
  agentId?: string;
  sessionKey?: string;
  toolContext?: { agentId?: string; sessionKey?: string };
  defaultAccountId?: string;
  deps?: Record<string, unknown>;
}) => Promise<unknown>;

type MessageDepsFactory = () => Record<string, unknown>;

let messageActionRunnerPromise: Promise<MessageActionRunner | null> | undefined;
let messageDepsFactoryPromise: Promise<MessageDepsFactory | null> | undefined;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveOpenClawPackageRoot(): Promise<string | null> {
  const candidates = [
    process.execPath,
    process.argv[1] ?? "",
    process.cwd(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    let cursor = path.resolve(candidate);
    if (!candidate.endsWith(".js") && !candidate.endsWith(".cjs") && !candidate.endsWith(".mjs")) {
      cursor = path.dirname(cursor);
    }

    for (let depth = 0; depth < 8; depth += 1) {
      const directPackage = path.join(cursor, "node_modules", "openclaw", "package.json");
      if (await pathExists(directPackage)) {
        return path.dirname(directPackage);
      }

      const globalPackage = path.join(cursor, "lib", "node_modules", "openclaw", "package.json");
      if (await pathExists(globalPackage)) {
        return path.dirname(globalPackage);
      }

      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  }

  return null;
}

function resolveMessageActionRunnerExport(module: Record<string, unknown>): MessageActionRunner | null {
  const direct = module.runMessageAction;
  if (typeof direct === "function") {
    return direct as MessageActionRunner;
  }

  const aliased = module.un;
  if (typeof aliased === "function") {
    return aliased as MessageActionRunner;
  }

  for (const value of Object.values(module)) {
    if (typeof value === "function" && value.name === "runMessageAction") {
      return value as MessageActionRunner;
    }
  }

  return null;
}

function resolveMessageDepsFactoryExport(module: Record<string, unknown>): MessageDepsFactory | null {
  const direct = module.createDefaultDeps;
  if (typeof direct === "function") {
    return direct as MessageDepsFactory;
  }

  const aliased = module.W;
  if (typeof aliased === "function") {
    return aliased as MessageDepsFactory;
  }

  for (const value of Object.values(module)) {
    if (typeof value === "function" && value.name === "createDefaultDeps") {
      return value as MessageDepsFactory;
    }
  }

  return null;
}

async function resolveMessageActionRunner(): Promise<MessageActionRunner | null> {
  if (!messageActionRunnerPromise) {
    messageActionRunnerPromise = (async () => {
      const packageRoot = await resolveOpenClawPackageRoot();
      if (!packageRoot) {
        return null;
      }

      const distDir = path.join(packageRoot, "dist");
      let entries: string[];
      try {
        entries = (await fs.readdir(distDir))
          .filter((entry) => /^reply-.*\.js$/.test(entry))
          .sort();
      } catch {
        return null;
      }

      for (const replyModule of entries) {
        try {
          const module = await import(pathToFileURL(path.join(distDir, replyModule)).href) as Record<string, unknown>;
          const runner = resolveMessageActionRunnerExport(module);
          if (runner) {
            return runner;
          }
        } catch {
          continue;
        }
      }

      return null;
    })();
  }

  return messageActionRunnerPromise;
}

async function resolveMessageDepsFactory(): Promise<MessageDepsFactory | null> {
  if (!messageDepsFactoryPromise) {
    messageDepsFactoryPromise = (async () => {
      const packageRoot = await resolveOpenClawPackageRoot();
      if (!packageRoot) {
        return null;
      }

      const distDir = path.join(packageRoot, "dist");
      let entries: string[];
      try {
        entries = (await fs.readdir(distDir))
          .filter((entry) => /^reply-.*\.js$/.test(entry))
          .sort();
      } catch {
        return null;
      }

      for (const replyModule of entries) {
        try {
          const module = await import(pathToFileURL(path.join(distDir, replyModule)).href) as Record<string, unknown>;
          const factory = resolveMessageDepsFactoryExport(module);
          if (factory) {
            return factory;
          }
        } catch {
          continue;
        }
      }

      return null;
    })();
  }

  return messageDepsFactoryPromise;
}

export async function sendMessageToChannel(
  api: OpenClawPluginApi,
  message: string,
  channelInfo: ChannelInfo,
  context: { agentId?: string | null; sessionKey?: string | null },
): Promise<void> {
  const cfg = api.runtime?.config?.loadConfig?.() as Record<string, unknown> | undefined;
  if (!cfg) {
    return;
  }

  const channel = channelInfo.deliveryChannel ?? channelInfo.lastChannel;
  if (!channel || channel === "webchat") {
    return;
  }

  const to = channelInfo.deliveryTo ?? channelInfo.lastTo;
  const accountId = channelInfo.deliveryAccountId ?? channelInfo.lastAccountId;
  if (!to) {
    return;
  }

  const runner = await resolveMessageActionRunner();
  if (!runner) {
    return;
  }

  const depsFactory = await resolveMessageDepsFactory();
  const deps = depsFactory ? depsFactory() : undefined;

  const attempt = async (target: string) => {
    await runner({
      cfg,
      action: "send",
      params: {
        channel,
        to: target,
        message,
        ...(accountId ? { accountId } : {}),
      },
      agentId: context.agentId ?? undefined,
      sessionKey: context.sessionKey ?? undefined,
      toolContext: {
        agentId: context.agentId ?? undefined,
        sessionKey: context.sessionKey ?? undefined,
      },
      defaultAccountId: accountId,
      deps,
    });
  };

  try {
    await attempt(to);
  } catch (error) {
    if (channel === "telegram" && to.startsWith("telegram:")) {
      try {
        await attempt(to.replace(/^telegram:/, ""));
        return;
      } catch {
        // fallthrough to logging below
      }
    }
    api.logger?.warn?.("ai-cli channel send failed", {
      error: error instanceof Error ? error.message : String(error),
      channel,
      to,
      accountId: accountId ?? null,
    });
  }
}
