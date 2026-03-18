import { stripAnsi } from "../utils/ansi.ts";
import type { PluginConfig } from "../types.ts";
import { LOG_OMISSION_MARKER } from "../types.ts";

export type LogSource = "stdout" | "stderr";

export interface LogSnapshot {
  stdoutBytes: number;
  stderrBytes: number;
  combinedPreview: string;
  lastUpdateAt: string | null;
}

export interface FinalLogSnapshot {
  finalLog: string;
  isTruncated: boolean;
}

export class LogBuffer {
  private readonly maxLogChars: number;
  private readonly previewFlushBytes: number;
  private readonly previewFlushIntervalMs: number;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private combinedPreview = "";
  private lastUpdateAt: string | null = null;
  private fullLog = "";
  private hasOverflowed = false;
  private head = "";
  private tail = "";
  private pendingPreview = "";
  private pendingBytes = 0;
  private lastFlushAt = 0;

  constructor(config: PluginConfig) {
    this.maxLogChars = config.maxLogChars;
    this.previewFlushBytes = config.previewFlushBytes;
    this.previewFlushIntervalMs = config.previewFlushIntervalMs;
  }

  append(source: LogSource, chunk: Buffer | string): LogSnapshot {
    const rawText = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const cleaned = stripAnsi(rawText);
    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;

    if (source === "stdout") {
      this.stdoutBytes += bytes;
    } else {
      this.stderrBytes += bytes;
    }

    this.pendingPreview += cleaned;
    this.pendingBytes += bytes;
    this.pushToFinalLog(cleaned);

    const now = Date.now();
    if (
      this.pendingBytes >= this.previewFlushBytes ||
      now - this.lastFlushAt >= this.previewFlushIntervalMs
    ) {
      this.flush(now);
    }

    return this.snapshot();
  }

  flush(now = Date.now()): LogSnapshot {
    if (this.pendingPreview.length > 0) {
      this.combinedPreview += this.pendingPreview;
      if (this.combinedPreview.length > this.maxLogChars) {
        this.combinedPreview = this.combinedPreview.slice(-this.maxLogChars);
      }

      this.pendingPreview = "";
      this.pendingBytes = 0;
      this.lastUpdateAt = new Date(now).toISOString();
      this.lastFlushAt = now;
    }

    return this.snapshot();
  }

  snapshot(): LogSnapshot {
    return {
      stdoutBytes: this.stdoutBytes,
      stderrBytes: this.stderrBytes,
      combinedPreview: this.combinedPreview,
      lastUpdateAt: this.lastUpdateAt,
    };
  }

  finalize(): FinalLogSnapshot {
    this.flush();

    if (!this.hasOverflowed) {
      return {
        finalLog: this.fullLog,
        isTruncated: false,
      };
    }

    return {
      finalLog: `${this.head}${LOG_OMISSION_MARKER}${this.tail}`,
      isTruncated: true,
    };
  }

  private pushToFinalLog(cleaned: string): void {
    if (!this.hasOverflowed) {
      this.fullLog += cleaned;
      if (this.fullLog.length <= this.maxLogChars) {
        return;
      }

      this.hasOverflowed = true;
      this.head = this.fullLog.slice(0, 1000);
      this.tail = this.fullLog.slice(-2000);
      this.fullLog = "";
      return;
    }

    this.tail += cleaned;
    if (this.tail.length > 2000) {
      this.tail = this.tail.slice(-2000);
    }
  }
}
