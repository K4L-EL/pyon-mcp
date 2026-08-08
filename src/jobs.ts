/**
 * Async job polling for Pyon's job-based endpoints (AI builds, edits,
 * diagnosis, sweeps, research generation).
 */

import { pyonFetch, PyonApiError } from "./client.js";
import { getProp, getStatus, getString, truncate } from "./format.js";

export class JobTimeoutError extends Error {
  readonly jobId: string;

  constructor(message: string, jobId: string) {
    super(message);
    this.name = "JobTimeoutError";
    this.jobId = jobId;
  }
}

export interface PollJobOptions {
  timeoutMs: number;
  intervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Every async endpoint answers with a jobId; refuse to poll without one. */
export function requireJobId(res: unknown): string {
  const jobId = getString(res, "jobId");
  if (!jobId) throw new Error(`Pyon did not return a jobId: ${truncate(res, 400)}`);
  return jobId;
}

/** Parse a job's resultJson defensively: it is usually a stringified JSON blob but may already be an object. */
export function parseResultJson(job: unknown): unknown {
  const raw = getProp(job, "resultJson") ?? getProp(job, "result");
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * Poll GET /api/jobs/{jobId} until status is "completed" or "error".
 * Resolves with the parsed resultJson on completion.
 * Throws PyonApiError on job error, JobTimeoutError on timeout
 * (the message tells the agent to fall back to get_job_status).
 */
export async function pollJob(jobId: string, opts: PollJobOptions): Promise<unknown> {
  const intervalMs = opts.intervalMs ?? 3000;
  const deadline = Date.now() + opts.timeoutMs;
  let lastStatus = "unknown";

  for (;;) {
    const job = await pyonFetch<unknown>(`/api/jobs/${encodeURIComponent(jobId)}`);
    const status = getStatus(job);
    lastStatus = status;

    if (status === "completed") {
      return parseResultJson(job);
    }
    if (status === "error" || status === "failed") {
      const errMsg = getString(job, "error") ?? "unknown error";
      throw new PyonApiError(`Pyon job ${jobId} failed: ${errMsg}`);
    }
    if (Date.now() >= deadline) {
      throw new JobTimeoutError(
        `Timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for job ${jobId} (last status: ${lastStatus}). ` +
          `The job is most likely still running on the server - call get_job_status("${jobId}") in a little while to fetch the result.`,
        jobId
      );
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Generic poller for non-job endpoints (backtests). Calls fetchState until
 * isDone returns true or the timeout is reached, then returns the last state.
 */
export async function pollUntil<T>(
  fetchState: () => Promise<T>,
  isDone: (state: T) => boolean,
  opts: { timeoutMs: number; intervalMs?: number; timeoutMessage: string }
): Promise<T> {
  const intervalMs = opts.intervalMs ?? 3000;
  const deadline = Date.now() + opts.timeoutMs;

  for (;;) {
    const state = await fetchState();
    if (isDone(state)) return state;
    if (Date.now() >= deadline) {
      throw new PyonApiError(opts.timeoutMessage);
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}
