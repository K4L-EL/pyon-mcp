import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pyonFetch } from "../client.js";
import { pollJob, requireJobId, progressNotifier } from "../jobs.js";
import { getAny, getArray, getNumber, getObject, getProp, getString, run, truncate } from "../format.js";
import { CreateStrategyInput, DiagnoseStrategyInput, EditStrategyInput, MIN_PROMPT_CHARS } from "../schemas.js";
import type { CreateStrategyResult, DiagnoseStrategyResult, EditStrategyResult } from "../types.js";

const VERDICT_MEANINGS: Record<string, string> = {
  improved: "the edit made the sample backtest better (more return and/or healthier trading)",
  unchanged: "the edit did not measurably change the sample backtest results",
  degraded:
    "the edit made the sample backtest worse - keep it only if intentional, otherwise revert via edit_strategy (revertToVersion identifies the pre-edit version)",
  broke:
    "the edit broke the strategy (it errored or stopped producing trades) - revert via edit_strategy using revertToVersion",
  still_zero:
    "the strategy produced zero trades both before and after the edit - the underlying no-trade cause is still there; use diagnose_strategy to find it",
};

const DEFAULT_DIAGNOSE_QUESTION =
  "Diagnose this strategy: is it trading as intended, why is it underperforming or not trading, and what exactly should be changed?";

export function registerAiTools(server: McpServer): void {
  server.registerTool(
    "create_strategy",
    {
      title: "Create strategy (AI build)",
      description:
        "Build a brand new trading strategy from a natural-language description using Pyon's AI builder, waiting up to " +
        "300s for the build to finish. Use this when the user wants a new strategy; pass analysisId to ground the build " +
        "in a saved research report from create_research. " +
        `Parameters: description (string, ${MIN_PROMPT_CHARS} to 8000 characters, required) - name the instrument, entry rule, ` +
        "exit rule and position size; analysisId (optional, a Pyon research id like analysis_7f342df3dd6d4a4, from create_research or list_research). " +
        "Call get_capabilities FIRST so the indicator names, operators, action types and tickers you write into the " +
        "description are ones the engine supports, and so thresholds stay inside each indicator's range (an RSI entry above " +
        "100 can never fire). " +
        "Returns the new strategyId, name, a summary of what was built, and a nextSteps hint. Always evaluate the result " +
        "with run_backtest before editing or optimizing. If the wait times out, the error includes a jobId for get_job_status.",
      inputSchema: CreateStrategyInput,
    },
    async ({ description, analysisId }, extra) =>
      run(async () => {
        const onTick = progressNotifier(extra, "create_strategy");
        const res = await pyonFetch<unknown>("/api/ai/generate-strategy-async", {
          method: "POST",
          body: { description, ...(analysisId ? { analysisId } : {}) },
        });
        const result = await pollJob(requireJobId(res), { timeoutMs: 300_000, onTick });

        const strategyId = getString(result, "strategyId", "id");
        const out: CreateStrategyResult = {
          strategyId,
          name: getString(result, "name", "strategyName"),
          summary: truncate(getAny(result, "summary", "message"), 1500),
          nextSteps:
            "Run run_backtest(strategyId) over a real window to evaluate this strategy before editing or optimizing it.",
        };
        if (strategyId === undefined) {
          const raw = truncate(result, 2000);
          if (raw !== undefined) out.raw = raw;
        }
        return out;
      })
  );

  server.registerTool(
    "edit_strategy",
    {
      title: "Edit strategy (AI edit)",
      description:
        "Modify an existing strategy with a natural-language instruction using Pyon's AI editor, waiting up to 300s. " +
        "Use this to change entry/exit logic, thresholds, position sizing, symbols, or to fix issues found by " +
        "diagnose_strategy. " +
        `Parameters: strategyId (UUID, required; from list_strategies); instruction (string, ${MIN_PROMPT_CHARS} to 8000 ` +
        "characters, required) stating exactly what to change and to what - diagnose_strategy's agentRequest can be pasted " +
        "here verbatim. Use get_capabilities to check indicator names and ranges before writing the instruction. " +
        "Returns a verification verdict comparing a sample backtest before and after the edit, with before/after trade " +
        "counts and return percentages, plus revertToVersion for undoing a bad edit. " +
        "Verdict values: improved (better), unchanged (no measurable change), degraded (worse), broke (errored or " +
        "stopped trading - revert), still_zero (zero trades before and after - root cause not fixed). " +
        "If the wait times out, the error includes a jobId to check with get_job_status.",
      inputSchema: EditStrategyInput,
    },
    async ({ strategyId, instruction }, extra) =>
      run(async () => {
        const onTick = progressNotifier(extra, "edit_strategy");
        const res = await pyonFetch<unknown>(
          `/api/ai/edit-strategy-async/${encodeURIComponent(strategyId)}`,
          { method: "POST", body: { description: instruction } }
        );
        const result = await pollJob(requireJobId(res), { timeoutMs: 300_000, onTick });

        const verification = getObject(result, "verification");
        const verdict = getString(verification, "verdict");
        const revertRaw = getProp(verification, "revertToVersion");

        const out: EditStrategyResult = {
          strategyId,
          summary: truncate(getAny(result, "summary", "message"), 1200),
          verdict,
          beforeTrades: getNumber(verification, "beforeTrades"),
          afterTrades: getNumber(verification, "afterTrades"),
          beforeReturnPct: getNumber(verification, "beforeReturnPct"),
          afterReturnPct: getNumber(verification, "afterReturnPct"),
          revertToVersion:
            typeof revertRaw === "string" || typeof revertRaw === "number" ? revertRaw : undefined,
          note:
            "Before/after numbers come from a short sample backtest used for verification, not a full backtest. " +
            "Run run_backtest for real performance.",
        };

        const meaning = verdict !== undefined ? VERDICT_MEANINGS[verdict.toLowerCase()] : undefined;
        if (meaning !== undefined) out.verdictMeaning = meaning;
        return out;
      })
  );

  server.registerTool(
    "diagnose_strategy",
    {
      title: "Diagnose strategy (AI debugger)",
      description:
        "Ask Pyon's AI debugger to analyze a strategy, running a fresh sample backtest as evidence; waits up to 300s. " +
        "Use this when run_backtest shows zero trades, poor returns, or confusing diagnostics and you need a causal " +
        "explanation before editing. " +
        `Parameters: strategyId (UUID, required); question (string, ${MIN_PROMPT_CHARS} to 2000 characters, optional) - ` +
        "ask something specific such as 'why did this take zero trades in 2025?', or omit it entirely for a general " +
        "health check. " +
        "Returns a diagnosis message, a structured list of up to 10 issues, and, when available, a ready-to-use edit " +
        "request (agentRequest) that can be passed directly to edit_strategy as the instruction. " +
        "If the wait times out, the error includes a jobId to check with get_job_status.",
      inputSchema: DiagnoseStrategyInput,
    },
    async ({ strategyId, question }, extra) =>
      run(async () => {
        const onTick = progressNotifier(extra, "diagnose_strategy");
        const res = await pyonFetch<unknown>(
          `/api/ai/debug-strategy-async/${encodeURIComponent(strategyId)}`,
          {
            method: "POST",
            body: {
              question: question ?? DEFAULT_DIAGNOSE_QUESTION,
              includeBacktest: true,
              includeRunHistory: false,
            },
          }
        );
        const result = await pollJob(requireJobId(res), { timeoutMs: 300_000, onTick });

        const issues = getArray(result, "issues")
          .slice(0, 10)
          .map((it) => (typeof it === "string" ? it : truncate(it, 500) ?? ""))
          .filter((it) => it.length > 0);

        const out: DiagnoseStrategyResult = {
          strategyId,
          message: truncate(getAny(result, "message"), 3000),
          issues,
        };

        const agentRequest = truncate(getProp(result, "agentRequest"), 1000);
        if (agentRequest !== undefined) {
          out.agentRequest = agentRequest;
          out.hint =
            "agentRequest is a suggested fix - you can pass it verbatim to edit_strategy as the instruction.";
        }
        return out;
      })
  );
}
