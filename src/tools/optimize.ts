import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pyonFetch } from "../client.js";
import { pollJob, requireJobId, progressNotifier } from "../jobs.js";
import { asNumber, getNumber, getProp, getString, round2, round2opt, run } from "../format.js";
import {
  DEFAULT_STEPS,
  MAX_STEPS,
  MIN_STEPS,
  OptimizeStrategyInput,
  OptimizeStrategyObject,
  TIMEFRAME_LIST,
  parseInput,
} from "../schemas.js";
import type { OptimizeResult, SweepCell, SweepCurrentCell } from "../types.js";

/**
 * Normalize a sweep grid to rows indexed [yIndex][xIndex]. The API may return
 * either an array of row arrays or a flat row-major array of length xs*ys.
 */
function normalizeGrid(raw: unknown, xCount: number, yCount: number): number[][] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (Array.isArray(raw[0])) {
    return raw.map((row) => (Array.isArray(row) ? row.map((v) => asNumber(v) ?? Number.NaN) : []));
  }
  const flat = raw.map((v) => asNumber(v) ?? Number.NaN);
  if (xCount > 0 && flat.length === xCount * yCount) {
    const rows: number[][] = [];
    for (let i = 0; i < yCount; i++) rows.push(flat.slice(i * xCount, (i + 1) * xCount));
    return rows;
  }
  return [flat];
}

function cellAt(grid: number[][] | undefined, yi: number, xi: number): number | undefined {
  const v = grid?.[yi]?.[xi];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function numberList(value: unknown): number[] {
  return (Array.isArray(value) ? value : []).map((v) => asNumber(v)).filter((v): v is number => v !== undefined);
}

export function registerOptimizeTools(server: McpServer): void {
  server.registerTool(
    "optimize_strategy",
    {
      title: "Optimize strategy (2-D parameter sweep)",
      description:
        "Run a 2-D parameter sweep over two numeric config fields of a strategy's nodes, backtesting a steps x steps " +
        "grid of value combinations; waits up to 600s. Use this after a strategy already trades sensibly (verify with " +
        "run_backtest) to tune thresholds, periods, or sizes. " +
        "Call get_strategy FIRST to obtain the exact node ids and config field names, and get_capabilities to keep the " +
        "bounds inside the indicator's real range (sweeping an RSI threshold from 80 to 140 wastes half the grid on cells " +
        "that can never fire). " +
        "Parameters: strategyId (UUID, required); xNodeId and xField, yNodeId and yField (strings from get_strategy, " +
        "required) - the two axes must not be the same node id AND field; xMin/xMax and yMin/yMax (finite numbers, " +
        `required) with xMax > xMin and yMax > yMin - the steps values are spaced linearly and include both endpoints ` +
        `(xMin 10, xMax 30, steps 5 tests 10, 15, 20, 25, 30); steps (whole number ${MIN_STEPS} to ${MAX_STEPS}, default ` +
        `${DEFAULT_STEPS}); timeframe: one of ${TIMEFRAME_LIST} - optional override, defaults to what the server picks. ` +
        "Returns the best cell (highest sharpe, preferring cells that actually traded), the strategy's current cell, the " +
        "sharpe grid as compact rows of numbers (rows = y values top to bottom, columns = x values left to right), the " +
        "sweep window and timeframe, and a verbatim warning when every cell produced zero trades. " +
        "If the wait times out, the error includes a jobId to check with get_job_status.",
      inputSchema: OptimizeStrategyObject,
    },
    async (args, extra) =>
      run(async () => {
        const onTick = progressNotifier(extra, "optimize_strategy");
        // Re-parse with the cross-field rules (xMax > xMin, yMax > yMin, the two
        // axes addressing different parameters).
        const input = parseInput("optimize_strategy", OptimizeStrategyInput, args);
        const { strategyId, timeframe, steps, ...axes } = input;

        const res = await pyonFetch<unknown>(
          `/api/strategies/${encodeURIComponent(strategyId)}/sweep`,
          {
            method: "POST",
            body: { ...axes, steps, ...(timeframe ? { timeframe } : {}) },
          }
        );
        const result = await pollJob(requireJobId(res), { timeoutMs: 600_000, onTick });

        const xs = numberList(getProp(result, "xs"));
        const ys = numberList(getProp(result, "ys"));
        const sharpe = normalizeGrid(getProp(result, "sharpe"), xs.length, ys.length);
        const returnPct = normalizeGrid(getProp(result, "returnPct"), xs.length, ys.length);
        const trades = normalizeGrid(getProp(result, "trades"), xs.length, ys.length);

        // Best cell: highest sharpe, preferring cells with trades > 0 when a trades grid exists.
        let best: SweepCell | undefined;
        let bestScore = -Infinity;
        let bestTraded = false;
        for (let yi = 0; yi < ys.length; yi++) {
          for (let xi = 0; xi < xs.length; xi++) {
            const s = cellAt(sharpe, yi, xi);
            if (s === undefined) continue;
            const x = xs[xi];
            const y = ys[yi];
            if (x === undefined || y === undefined) continue;
            const t = cellAt(trades, yi, xi);
            const traded = t === undefined ? true : t > 0;
            const candidateWins =
              best === undefined || (traded && !bestTraded) || (traded === bestTraded && s > bestScore);
            if (candidateWins) {
              const sharpeVal = round2opt(s);
              const returnVal = round2opt(cellAt(returnPct, yi, xi));
              best = {
                x,
                y,
                ...(sharpeVal !== undefined ? { sharpe: sharpeVal } : {}),
                ...(returnVal !== undefined ? { returnPct: returnVal } : {}),
                ...(t !== undefined ? { trades: t } : {}),
              };
              bestScore = s;
              bestTraded = traded;
            }
          }
        }

        // Current cell: locate currentX/currentY inside the grid when present.
        const currentX = getNumber(result, "currentX");
        const currentY = getNumber(result, "currentY");
        let current: SweepCurrentCell | undefined;
        if (currentX !== undefined || currentY !== undefined) {
          current = { x: currentX, y: currentY };
          const xi = xs.findIndex((v) => v === currentX);
          const yi = ys.findIndex((v) => v === currentY);
          if (xi >= 0 && yi >= 0) {
            const sharpeVal = round2opt(cellAt(sharpe, yi, xi));
            const returnVal = round2opt(cellAt(returnPct, yi, xi));
            const tradesVal = cellAt(trades, yi, xi);
            if (sharpeVal !== undefined) current.sharpe = sharpeVal;
            if (returnVal !== undefined) current.returnPct = returnVal;
            if (tradesVal !== undefined) current.trades = tradesVal;
          }
        }

        const out: OptimizeResult = {
          strategyId,
          xLabel: getString(result, "xLabel"),
          yLabel: getString(result, "yLabel"),
          xs,
          ys,
          windowDays: getNumber(result, "windowDays"),
          timeframe: getString(result, "timeframe"),
          best,
          current,
          sharpeGrid: sharpe?.map((row) => row.map((v) => round2(v))),
          gridNote: "sharpeGrid rows correspond to ys (top to bottom), columns to xs (left to right).",
        };

        const allZeroTrades = getProp(result, "allZeroTrades");
        if (allZeroTrades) {
          out.allZeroTrades =
            typeof allZeroTrades === "string"
              ? allZeroTrades
              : "Every cell in this sweep produced zero trades. The tested ranges never trigger entries - widen the " +
                "ranges, check the entry gates with diagnose_strategy, or verify the timeframe.";
        }

        return out;
      })
  );
}
