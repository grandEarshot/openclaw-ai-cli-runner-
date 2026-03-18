import {
  LOG_OMISSION_MARKER,
  LOG_TRUNCATE_HEAD_CHARS,
  LOG_TRUNCATE_TAIL_CHARS,
} from "../types.ts";

export interface TruncateResult {
  text: string;
  isTruncated: boolean;
}

export function truncateLog(input: string, maxChars: number): TruncateResult {
  if (input.length <= maxChars) {
    return {
      text: input,
      isTruncated: false,
    };
  }

  const head = input.slice(0, LOG_TRUNCATE_HEAD_CHARS);
  const tail = input.slice(-LOG_TRUNCATE_TAIL_CHARS);

  return {
    text: `${head}${LOG_OMISSION_MARKER}${tail}`,
    isTruncated: true,
  };
}
