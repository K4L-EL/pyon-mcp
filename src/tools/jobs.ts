import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pyonFetch, PyonApiError } from "../client.js";
import { parseResultJson } from "../jobs.js";
import { getArray, getNumber, getObject, getStatus, getString, run, truncate } from "../format.js";
import { GetJobStatusInput } from "../schemas.js";
import type { BacktestJobStatus, BacktestMetrics, JobStatus } from "../types.js";

const MAX_DIAGNOSTICS = 8;
const STILL_RUNNING_HINT = "Still running - call get_job_status again after a short wait.";

export function registerJobTools(server: McpServer): void {
  server.registerTool(
    "get_job_status",
    {
      title: "Get job status",
      description:
        "Check a Pyon async job directly - the escape hatch when a waiting tool timed out. create_strategy, " +
        "edit_strategy, diagnose_strategy, optimize_strategy, and create_research keep running server-side after a " +
        "client timeout, and their timeout errors include the jobId to pass here; run_backtest timeouts name a " +
        "backtest id, which this tool also accepts (it falls back to the backtest endpoint when the id is not a job). " +
        "Parameters: jobId (non-empty string, required) - copy it verbatim from the timeout error message; job ids stay " +
        "resolvable indefinitely, so a not-found error means the id is wrong, not expired. " +
        "Returns the job status plus, when completed, a compact view of the result, or the error message when failed. " +
        "Call it again after a short wait if the job is still running.",
      inputSchema: GetJobStatusInput,
    },
    async ({ jobId }) =>
      run(async () => {
        let job: unknown;
        try {
          job = await pyonFetch<unknown>(`/api/jobs/${encodeURIComponent(jobId)}`);
        } catch (err) {
          if (err instanceof PyonApiError && err.status === 404) {
            return await backtestFallback(jobId);
          }
          throw err;
        }

        const status = getStatus(job);
        if (status === "completed") {
          const out: JobStatus = { jobId, status };
          const result = truncate(parseResultJson(job), 4000);
          if (result !== undefined) out.result = result;
          return out;
        }
        if (status === "error" || status === "failed") {
          const out: JobStatus = { jobId, status, error: getString(job, "error") ?? "unknown error" };
          return out;
        }
        const out: JobStatus = { jobId, status, hint: STILL_RUNNING_HINT };
        return out;
      })
  );
}

async function backtestFallback(id: string): Promise<BacktestJobStatus> {
  const bt = await pyonFetch<unknown>(`/api/backtests/${encodeURIComponent(id)}`);
  const status = getStatus(bt);
  const out: BacktestJobStatus = { backtestId: id, kind: "backtest", status };

  if (status === "completed") {
    const metricsRaw = getObject(bt, "metrics");
    const totalOrders = getNumber(metricsRaw, "totalOrders");
    const winRate = getNumber(metricsRaw, "winRatePct");
    const metrics: BacktestMetrics = {
      totalTrades: getNumber(metricsRaw, "totalTrades"),
      ...(totalOrders !== undefined ? { totalOrders } : {}),
      totalReturnPct: getNumber(metricsRaw, "totalReturnPct"),
      sharpeRatio: getNumber(metricsRaw, "sharpeRatio"),
      maxDrawdownPct: getNumber(metricsRaw, "maxDrawdownPct"),
      ...(winRate !== undefined ? { winRate } : {}),
    };
    out.metrics = metrics;
    out.diagnostics = getArray(bt, "diagnostics")
      .map((d) => getString(d, "message") ?? (typeof d === "string" ? d : JSON.stringify(d)) ?? "")
      .filter((d) => d.length > 0)
      .slice(0, MAX_DIAGNOSTICS);
  } else if (status === "error" || status === "failed") {
    out.error = getString(bt, "error") ?? "unknown error";
  } else {
    out.hint = STILL_RUNNING_HINT;
  }

  return out;
}
