import type { JobRecord } from "../types.ts";

export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  set(job: JobRecord): void {
    this.jobs.set(job.jobId, job);
  }

  has(jobId: string): boolean {
    return this.jobs.has(jobId);
  }
}
