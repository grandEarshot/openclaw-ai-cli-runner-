import { randomUUID } from "node:crypto";

export function createJobId(): string {
  return randomUUID();
}
