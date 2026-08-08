import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pyonFetch } from "../client.js";
import { pollUntil } from "../jobs.js";
import { getArray, getNumber, getObject, getStatus, getString, run, truncate } from "../format.js";
import {
  DEFAULT_BACKTEST_WINDOW_DAYS,
  DEFAULT_INITIAL_CAPITAL,
  MAX_INITIAL_CAPITAL,
  MIN_BACKTEST_WINDOW_DAYS,
  MIN_INITIAL_CAPITAL,
  RunBacktestInput,
  RunBacktestObject,
  SHORT_DAILY_WINDOW_DAYS,
  TIMEFRAME_LIST,
  parseInput,
  resolveBacktestWindow,
} from "../schemas.js";
import type { BacktestMetrics, BacktestResult } from "../types.js";

const BACKTEST_TIMEOUT_MS = 180_000;
const MAX_DIAGNOSTICS = 8;

export function registerBacktestTools(server: McpServer): void {
  server.registerTool(
    "run_backtest",
    {
      title: "Run backtest",
      description:
        "Backtest a strategy over a historical window and wait up to 180s for it to finish. Use this after " +
        "create_strategy or edit_strategy to measure real performance, and before optimize_strategy to establish a " +
        "baseline. " +
        "Parameters: strategyId (UUID, required); startDate and endDate (YYYY-MM-DD, optional, must be real past dates " +
        `with endDate after startDate and at least ${MIN_BACKTEST_WINDOW_DAYS} days between them - default is the last ` +
        `${DEFAULT_BACKTEST_WINDOW_DAYS} days); timeframe: one of ${TIMEFRAME_LIST} - defaults to the strategy's native ` +
        `timeframe, fetched automatically; initialCapital in USD (number ${MIN_INITIAL_CAPITAL} to ${MAX_INITIAL_CAPITAL}, ` +
        `default ${DEFAULT_INITIAL_CAPITAL}). ` +
        "Returns metrics (totalTrades, totalOrders, totalReturnPct, sharpeRatio, maxDrawdownPct, winRate) plus up to " +
        `${MAX_DIAGNOSTICS} diagnostic messages verbatim - read these, they carry gate pass-rate evidence explaining WHY ` +
        "the strategy did or did not trade - and an explicit note when 0 trades closed but orders were opened (the " +
        "strategy entered and is still holding, which is not the same as a dead strategy). A warning is added when a " +
        `1d strategy is tested over fewer than ${SHORT_DAILY_WINDOW_DAYS} days, since that is too few bars to judge it. ` +
        "On timeout the error names the backtest id, which get_job_status accepts as a fallback.",
      inputSchema: RunBacktestObject,
    },
    async (args) =>
      run(async () => {
        // Re-parse with the cross-field rules (endDate after startDate, minimum
        // window). The registered schema is the plain object so tools/list can
        // still render a complete JSON Schema.
        const input = parseInput("run_backtest", RunBacktestInput, args);
        const { strategyId, initialCapital } = input;
        const window = resolveBacktestWindow(input.startDate, input.endDate);

        let timeframe: string | undefined = input.timeframe;
        if (!timeframe) {
          const detail = await pyonFetch<unknown>(`/api/strategies/${encodeURIComponent(strategyId)}`);
          timeframe = getString(detail, "nativeTimeframe") ?? "1d";
        }

        const started = await pyonFetch<unknown>(
          `/api/strategies/${encodeURIComponent(strategyId)}/backtest`,
          {
            method: "POST",
            body: {
              startDate: window.startDate,
              endDate: window.endDate,
              initialCapital,
              timeframe,
            },
          }
        );
        const backtestId = getString(started, "backtestId", "id");
        if (!backtestId) throw new Error(`Pyon did not return a backtestId: ${truncate(started, 400)}`);

        const bt = await pollUntil<unknown>(
          () => pyonFetch<unknown>(`/api/backtests/${encodeURIComponent(backtestId)}`),
          (state) => {
            const status = getStatus(state);
            return status === "completed" || status === "error" || status === "failed";
          },
          {
            timeoutMs: BACKTEST_TIMEOUT_MS,
            intervalMs: 3000,
            timeoutMessage:
              `Timed out after ${BACKTEST_TIMEOUT_MS / 1000}s waiting for backtest ${backtestId}. ` +
              `It is likely still running on the server - call get_job_status("${backtestId}") shortly; ` +
              `it falls back to the backtest endpoint for backtest ids.`,
          }
        );

        const status = getStatus(bt);
        if (status !== "completed") {
          throw new Error(`Backtest ${backtestId} failed: ${getString(bt, "error") ?? "unknown error"}`);
        }

        const metricsRaw = getObject(bt, "metrics");
        const totalTrades = getNumber(metricsRaw, "totalTrades");
        const totalOrders = getNumber(metricsRaw, "totalOrders");
        const winRate = getNumber(metricsRaw, "winRatePct");

        const metrics: BacktestMetrics = {
          totalTrades,
          ...(totalOrders !== undefined ? { totalOrders } : {}),
          totalReturnPct: getNumber(metricsRaw, "totalReturnPct"),
          sharpeRatio: getNumber(metricsRaw, "sharpeRatio"),
          maxDrawdownPct: getNumber(metricsRaw, "maxDrawdownPct"),
          ...(winRate !== undefined ? { winRate } : {}),
        };

        const diagnostics = getArray(bt, "diagnostics")
          .map((d) => getString(d, "message") ?? (typeof d === "string" ? d : JSON.stringify(d)) ?? "")
          .filter((d) => d.length > 0)
          .slice(0, MAX_DIAGNOSTICS);

        const out: BacktestResult = {
          strategyId,
          backtestId,
          window,
          timeframe,
          initialCapital,
          metrics,
          diagnostics,
        };

        if (totalTrades === 0 && totalOrders !== undefined && totalOrders > 0) {
          out.note =
            `0 closed trades but ${totalOrders} order(s) were opened: the strategy entered and is still holding at ` +
            `the end of the window. Exit conditions never fired inside the window - this is not a dead strategy, ` +
            `but return metrics reflect an open, unrealized position.`;
        } else if (totalTrades === 0) {
          out.note =
            "0 trades and no orders: the strategy never entered during this window. Check the diagnostics for which " +
            "gate blocked entries, or call diagnose_strategy for a causal explanation.";
        }

        // Advisory, not an error: a daily strategy needs a long window before its
        // metrics mean anything, and a short one is a common cause of "it looks broken".
        if (timeframe === "1d" && window.days < SHORT_DAILY_WINDOW_DAYS) {
          out.warning =
            `This is a 1d strategy tested over only ${window.days} days (${window.startDate} to ${window.endDate}). ` +
            `That is roughly ${Math.max(0, Math.round((window.days * 5) / 7))} trading bars, too few for indicator warm-up ` +
            `plus a meaningful trade sample, so a low trade count or an odd Sharpe here may say more about the window than ` +
            `about the strategy. Re-run with at least ${SHORT_DAILY_WINDOW_DAYS} days (the default window is ` +
            `${DEFAULT_BACKTEST_WINDOW_DAYS} days) before drawing conclusions.`;
        }

        return out;
      })
  );
}
