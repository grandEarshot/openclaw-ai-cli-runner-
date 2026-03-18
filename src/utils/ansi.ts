const ANSI_COLOR_PATTERN = /\x1b\[[0-9;]*m/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_COLOR_PATTERN, "");
}
