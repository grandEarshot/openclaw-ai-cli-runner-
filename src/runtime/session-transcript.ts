import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawPluginApi } from "../types.ts";

interface SessionStoreEntry {
  sessionId?: string;
  updatedAt?: number;
  sessionFile?: string;
}

interface SessionStore {
  [sessionKey: string]: SessionStoreEntry | undefined;
}

export interface TranscriptAppendResult {
  ok: boolean;
  reason?: string;
  sessionFile?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createEventId(): string {
  return randomBytes(4).toString("hex");
}

type TranscriptUpdateEmitterModule = {
  t?: (sessionFile: string) => void;
  emitSessionTranscriptUpdate?: (sessionFile: string) => void;
};

type TranscriptUpdateEmitter = (sessionFile: string) => void;

type OfficialTranscriptAppender = (params: {
  agentId?: string;
  sessionKey: string;
  text?: string;
  mediaUrls?: string[];
  storePath?: string;
}) => Promise<TranscriptAppendResult>;

let transcriptEmitterPromise: Promise<TranscriptUpdateEmitter[] | null> | undefined;
let transcriptAppenderPromise: Promise<OfficialTranscriptAppender | null> | undefined;
let coreTranscriptAppenderPromise: Promise<OfficialTranscriptAppender | null> | undefined;

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
  } catch (error) {
    api.logger?.warn?.("ai-cli transcript relay: resolve store path failed", {
      error: error instanceof Error ? error.message : String(error),
      agentId: agentId ?? null,
    });
    return null;
  }
}

async function readSessionStore(storePath: string): Promise<SessionStore> {
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as SessionStore : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeSessionStore(storePath: string, store: SessionStore): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
}

async function touchSessionStoreEntry(
  storePath: string,
  sessionKey: string,
  sessionFile?: string,
): Promise<void> {
  const store = await readSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) {
    return;
  }

  store[sessionKey] = {
    ...entry,
    ...(sessionFile?.trim() ? { sessionFile } : {}),
    updatedAt: Date.now(),
  };
  await writeSessionStore(storePath, store);
}

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

async function resolveTranscriptUpdateEmitter(): Promise<TranscriptUpdateEmitter[] | null> {
  if (!transcriptEmitterPromise) {
    transcriptEmitterPromise = (async () => {
      const packageRoot = await resolveOpenClawPackageRoot();
      if (!packageRoot) {
        return null;
      }

      const candidates = [
        path.join(packageRoot, "dist"),
        path.join(packageRoot, "dist", "plugin-sdk"),
      ];

      const emitters: TranscriptUpdateEmitter[] = [];
      for (const directory of candidates) {
        let entries: string[];
        try {
          entries = await fs.readdir(directory);
        } catch {
          continue;
        }

        const transcriptModule = entries.find((entry) =>
          /^transcript-events-.*\.js$/.test(entry)
        );
        if (!transcriptModule) {
          continue;
        }

        try {
          const module = await import(pathToFileURL(path.join(directory, transcriptModule)).href) as TranscriptUpdateEmitterModule;
          const emitter = module.emitSessionTranscriptUpdate ?? module.t;
          if (typeof emitter === "function") {
            emitters.push(emitter);
          }
        } catch {
          continue;
        }
      }

      return emitters.length > 0 ? emitters : null;
    })();
  }

  return transcriptEmitterPromise;
}

function resolveTranscriptAppenderExport(module: Record<string, unknown>): OfficialTranscriptAppender | null {
  const direct = module.appendAssistantMessageToSessionTranscript;
  if (typeof direct === "function") {
    return direct as OfficialTranscriptAppender;
  }

  const aliased = module.pt;
  if (typeof aliased === "function") {
    return aliased as OfficialTranscriptAppender;
  }

  for (const value of Object.values(module)) {
    if (typeof value === "function" && value.name === "appendAssistantMessageToSessionTranscript") {
      return value as OfficialTranscriptAppender;
    }
  }

  return null;
}

async function resolveOfficialTranscriptAppender(): Promise<OfficialTranscriptAppender | null> {
  if (!transcriptAppenderPromise) {
    transcriptAppenderPromise = (async () => {
      const packageRoot = await resolveOpenClawPackageRoot();
      if (!packageRoot) {
        return null;
      }

      const pluginSdkDir = path.join(packageRoot, "dist", "plugin-sdk");
      let entries: string[];
      try {
        entries = (await fs.readdir(pluginSdkDir))
          .filter((entry) => /^pi-embedded-helpers-.*\.js$/.test(entry))
          .sort();
      } catch {
        return null;
      }

      for (const helperModule of entries) {
        try {
          const module = await import(pathToFileURL(path.join(pluginSdkDir, helperModule)).href) as Record<string, unknown>;
          const appender = resolveTranscriptAppenderExport(module);
          if (appender) {
            return appender;
          }
        } catch {
          continue;
        }
      }

      return null;
    })();
  }

  return transcriptAppenderPromise;
}

function resolveCoreTranscriptAppenderExport(module: Record<string, unknown>): OfficialTranscriptAppender | null {
  const direct = module.appendAssistantMessageToSessionTranscript;
  if (typeof direct === "function") {
    return direct as OfficialTranscriptAppender;
  }

  const aliased = module.t;
  if (typeof aliased === "function") {
    return aliased as OfficialTranscriptAppender;
  }

  for (const value of Object.values(module)) {
    if (typeof value === "function" && value.name === "appendAssistantMessageToSessionTranscript") {
      return value as OfficialTranscriptAppender;
    }
  }

  return null;
}

async function resolveCoreTranscriptAppender(): Promise<OfficialTranscriptAppender | null> {
  if (!coreTranscriptAppenderPromise) {
    coreTranscriptAppenderPromise = (async () => {
      const packageRoot = await resolveOpenClawPackageRoot();
      if (!packageRoot) {
        return null;
      }

      const distDir = path.join(packageRoot, "dist");
      let entries: string[];
      try {
        entries = (await fs.readdir(distDir))
          .filter((entry) => /^sessions-.*\.js$/.test(entry))
          .sort();
      } catch {
        return null;
      }

      for (const sessionsModule of entries) {
        try {
          const module = await import(pathToFileURL(path.join(distDir, sessionsModule)).href) as Record<string, unknown>;
          const appender = resolveCoreTranscriptAppenderExport(module);
          if (appender) {
            return appender;
          }
        } catch {
          continue;
        }
      }

      return null;
    })();
  }

  return coreTranscriptAppenderPromise;
}

async function emitTranscriptUpdate(sessionFile: string): Promise<void> {
  const emitters = await resolveTranscriptUpdateEmitter();
  if (!emitters) {
    return;
  }

  for (const emitter of emitters) {
    emitter(sessionFile);
  }
}

async function ensureSessionTranscriptFile(sessionFile: string, sessionId: string): Promise<void> {
  try {
    await fs.access(sessionFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    const header = {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: nowIso(),
      cwd: process.cwd(),
    };
    await fs.writeFile(sessionFile, `${JSON.stringify(header)}\n`, "utf-8");
  }
}

function resolveParentId(lines: string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as { id?: unknown };
      if (typeof parsed.id === "string" && parsed.id.length > 0) {
        return parsed.id;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export async function appendAssistantTranscriptMessage(
  api: OpenClawPluginApi,
  params: {
    agentId?: string | null;
    sessionKey: string;
    text: string;
  },
): Promise<TranscriptAppendResult> {
  const sessionKey = params.sessionKey.trim();
  const text = params.text.trim();

  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }
  if (!text) {
    return { ok: false, reason: "empty text" };
  }

  const storePath = resolveStorePath(api, params.agentId);
  if (!storePath) {
    return { ok: false, reason: "session store path unavailable" };
  }

  const coreAppender = await resolveCoreTranscriptAppender();
  if (coreAppender) {
    try {
      const coreResult = await coreAppender({
        agentId: typeof params.agentId === "string" && params.agentId.length > 0
          ? params.agentId
          : undefined,
        sessionKey,
        text,
        storePath: storePath ?? undefined,
      });

      if (coreResult.ok) {
        if (storePath) {
          await touchSessionStoreEntry(storePath, sessionKey, coreResult.sessionFile);
        }
        return coreResult;
      }

      api.logger?.warn?.("ai-cli transcript relay: core transcript append failed", {
        reason: coreResult.reason ?? "unknown error",
        sessionKey,
        agentId: params.agentId ?? null,
      });
    } catch (error) {
      api.logger?.warn?.("ai-cli transcript relay: core transcript append threw", {
        error: error instanceof Error ? error.message : String(error),
        sessionKey,
        agentId: params.agentId ?? null,
      });
    }
  }

  const officialAppender = await resolveOfficialTranscriptAppender();
  if (officialAppender) {
    try {
      const officialResult = await officialAppender({
        agentId: typeof params.agentId === "string" && params.agentId.length > 0
          ? params.agentId
          : undefined,
        sessionKey,
        text,
        storePath: storePath ?? undefined,
      });

      if (officialResult.ok) {
        if (storePath) {
          await touchSessionStoreEntry(storePath, sessionKey, officialResult.sessionFile);
        }
        return officialResult;
      }

      api.logger?.warn?.("ai-cli transcript relay: official transcript append failed", {
        reason: officialResult.reason ?? "unknown error",
        sessionKey,
        agentId: params.agentId ?? null,
      });
    } catch (error) {
      api.logger?.warn?.("ai-cli transcript relay: official transcript append threw", {
        error: error instanceof Error ? error.message : String(error),
        sessionKey,
        agentId: params.agentId ?? null,
      });
    }
  }

  const store = await readSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
  }

  const sessionFile = entry.sessionFile?.trim()
    ? entry.sessionFile
    : path.join(path.dirname(storePath), `${entry.sessionId}.jsonl`);

  await ensureSessionTranscriptFile(sessionFile, entry.sessionId);

  const transcriptRaw = await fs.readFile(sessionFile, "utf-8");
  const lines = transcriptRaw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const parentId = resolveParentId(lines);
  const timestamp = nowIso();

  const messageEvent = {
    type: "message",
    id: createEventId(),
    parentId,
    timestamp,
    message: {
      role: "assistant",
      content: [{
        type: "text",
        text,
      }],
      api: "openai-responses",
      provider: "openclaw",
      model: "delivery-mirror",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  };

  await fs.appendFile(sessionFile, `${JSON.stringify(messageEvent)}\n`, "utf-8");

  store[sessionKey] = {
    ...entry,
    sessionFile,
    updatedAt: Date.now(),
  };
  await writeSessionStore(storePath, store);
  await emitTranscriptUpdate(sessionFile);

  return {
    ok: true,
    sessionFile,
  };
}

export async function readSessionChannelInfo(
  api: OpenClawPluginApi,
  params: { sessionKey: string; agentId?: string | null },
): Promise<{
  provider?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  deliveryChannel?: string;
  deliveryTo?: string;
  deliveryAccountId?: string;
} | null> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }

  const storePath = resolveStorePath(api, params.agentId);
  if (!storePath) {
    return null;
  }

  const store = await readSessionStore(storePath);
  const entry = store[sessionKey] as Record<string, unknown> | undefined;
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const origin = entry.origin as Record<string, unknown> | undefined;
  const deliveryContext = entry.deliveryContext as Record<string, unknown> | undefined;
  const provider = typeof origin?.provider === "string" ? origin.provider : undefined;
  const lastChannel = typeof entry.lastChannel === "string" ? entry.lastChannel : undefined;
  const lastTo = typeof entry.lastTo === "string" ? entry.lastTo : undefined;
  const lastAccountId = typeof entry.lastAccountId === "string" ? entry.lastAccountId : undefined;
  const deliveryChannel = typeof deliveryContext?.channel === "string" ? deliveryContext.channel : undefined;
  const deliveryTo = typeof deliveryContext?.to === "string" ? deliveryContext.to : undefined;
  const deliveryAccountId = typeof deliveryContext?.accountId === "string"
    ? deliveryContext.accountId
    : undefined;
  return {
    provider,
    lastChannel,
    lastTo,
    lastAccountId,
    deliveryChannel,
    deliveryTo,
    deliveryAccountId,
  };
}
