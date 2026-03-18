import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export function spawnProcess(
  cliCmd: string,
  args: string[],
  workingDir: string,
): ChildProcessWithoutNullStreams {
  return spawn(cliCmd, args, {
    cwd: workingDir,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function stopProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.killed) {
    return;
  }

  child.kill("SIGTERM");
}
