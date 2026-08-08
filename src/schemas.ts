/**
 * Shared, reusable input primitives plus one strict input schema per tool.
 *
 * Two rules govern everything in this file:
 *
 * 1. Every message states what IS allowed, not just what failed. An agent that
 *    reads only the error text should be able to retry correctly on the next
 *    call without guessing.
 * 2. Every tool object is `.strict()`, so a misspelled or invented parameter is
 *    a loud rejection instead of a silently ignored key. Silently ignoring
 *    `timeFrame` or `start_date` is the worst failure mode here: the tool
 *    happily runs with the wrong window and the agent trusts the answer.
 *
 * Cross-field rules live on a `superRefine` wrapper (the `*Input` exports).
 * They are NOT what gets registered with MCP: the SDK renders `{}` as the JSON
 * Schema for any ZodEffects, which would hide every parameter from clients that
 * only read tools/list. So the plain `.strict()` object (the `*Object` exports)
 * is registered for discovery and per-field validation, and the tool handler
 * re-parses with the `*Input` schema to enforce the cross-field rules.
 */

import { z } from "zod";
import { CAPABILITY_SECTIONS } from "./types.js";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Bar timeframes the Pyon engine can actually resolve (StrategyExecutionService.BarsPerSession). */
export const TIMEFRAME_VALUES = ["1m", "5m", "15m", "1h", "1d"] as const;
export const TIMEFRAME_LIST = TIMEFRAME_VALUES.join(", ");
export type TimeframeValue = (typeof TIMEFRAME_VALUES)[number];

export const DEFAULT_INITIAL_CAPITAL = 50_000;
export const MIN_INITIAL_CAPITAL = 100;
export const MAX_INITIAL_CAPITAL = 100_000_000;

export const DEFAULT_STEPS = 5;
export const MIN_STEPS = 3;
export const MAX_STEPS = 10;

export const DEFAULT_BACKTEST_WINDOW_DAYS = 365;
/** Anything shorter cannot produce a meaningful result on any timeframe. */
export const MIN_BACKTEST_WINDOW_DAYS = 7;
/** Below this, a 1d strategy has too few bars for its metrics to mean much. */
export const SHORT_DAILY_WINDOW_DAYS = 300;

/** Minimum useful length of a free-text build/edit/diagnose prompt. */
export const MIN_PROMPT_CHARS = 10;

const VAGUE_PROMPT_HINT =
  `Pyon's AI builder turns this text directly into a node graph, so a vague prompt produces a poor, generic ` +
  `strategy. Name the instrument, the entry rule, the exit rule and the position size, e.g. ` +
  `"RSI mean reversion on AAPL: buy when RSI(14) crosses below 30, sell when RSI crosses above 55, 25% of cash per entry". ` +
  `Call get_capabilities first so the indicator names and thresholds you write are ones the engine actually supports.`;

/* ------------------------------------------------------------------ */
/* Date helpers (shared by the schema and by the tools)                */
/* ------------------------------------------------------------------ */

export const EARLIEST_BACKTEST_DATE = "2000-01-01";
export const MAX_BACKTEST_WINDOW_DAYS = 3_650;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse YYYY-MM-DD as a real UTC calendar date, or undefined if it is not one. */
export function parseIsoDateUtc(value: string): Date | undefined {
  if (!ISO_DATE_RE.test(value)) return undefined;
  const parts = value.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Rejects 2025-02-30, 2025-13-01 and friends: Date rolls them over silently.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return dt;
}

/** Today in UTC as YYYY-MM-DD. */
export function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Zero-width, bidi-control, and C0/C1 control characters that survive trim()
 * but render as nothing - without stripping them, "\u200b".repeat(20) passes a
 * 10-character minimum and an invisible suffix defeats equality guards. */
const INVISIBLES_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\uFEFF]/g;

export function stripInvisibles(value: string): string {
  return value.replace(INVISIBLES_RE, "");
}

/** Canonical form for comparing user-supplied identifiers (sweep axes etc.). */
export function canonicalKey(value: string): string {
  return stripInvisibles(value).trim().toLowerCase();
}


function isoDaysAgoUtc(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from startDate to endDate (negative when endDate precedes startDate). */
export function daysBetween(startIso: string, endIso: string): number {
  const a = parseIsoDateUtc(startIso);
  const b = parseIsoDateUtc(endIso);
  if (!a || !b) return Number.NaN;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export interface ResolvedWindow {
  startDate: string;
  endDate: string;
  days: number;
}

/**
 * Apply run_backtest's defaults (last 365 days ending today) exactly once, so
 * the cross-field validation and the tool body always agree on the window.
 */
export function resolveBacktestWindow(startDate?: string, endDate?: string): ResolvedWindow {
  const resolvedEnd = endDate ?? todayIsoUtc();
  // Anchor the default start to the END the caller chose, not to today -
  // otherwise an endDate in the past yields errors blaming a startDate the
  // caller never sent.
  const endParsed = parseIsoDateUtc(resolvedEnd);
  const resolvedStart = startDate ?? (endParsed
    ? new Date(endParsed.getTime() - DEFAULT_BACKTEST_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
    : isoDaysAgoUtc(DEFAULT_BACKTEST_WINDOW_DAYS));
  return { startDate: resolvedStart, endDate: resolvedEnd, days: daysBetween(resolvedStart, resolvedEnd) };
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export interface NonEmptyStringOptions {
  /** Minimum length AFTER trimming. Default 1. */
  min?: number;
  /** Maximum length AFTER trimming. Default 20000. */
  max?: number;
  /** Sentence appended to every message explaining what a valid value looks like. */
  allowed?: string;
}

/**
 * A trimmed, non-empty string whose every failure message names the field and
 * says what a valid value looks like.
 */
export function NonEmptyString(field: string, options: NonEmptyStringOptions = {}) {
  const min = options.min ?? 1;
  const max = options.max ?? 20_000;
  const allowed = options.allowed ? ` ${options.allowed}` : "";
  return z
    .string({
      required_error: `${field} is required.${allowed}`,
      invalid_type_error: `${field} must be a string.${allowed}`,
    })
    .trim()
    .min(
      min,
      min <= 1
        ? { message: `${field} must not be empty or whitespace.${allowed}` }
        : { message: `${field} must be at least ${min} characters after trimming.${allowed}` }
    )
    .max(max, { message: `${field} must be at most ${max} characters.` })
    // Zero-width, bidi and control characters render as nothing, so they must
    // not count toward the minimum: "\u200b".repeat(20) is NOT ten characters.
    // A refine (not a transform) keeps the schema derivable for tools/list.
    .refine((value) => stripInvisibles(value).trim().length >= min, {
      message:
        min <= 1
          ? `${field} must contain visible characters - zero-width and control characters do not count.${allowed}`
          : `${field} must contain at least ${min} visible characters - zero-width and control characters do not count.${allowed}`,
    });
}

export const StrategyId = z
  .string({
    required_error:
      "strategyId is required. Call list_strategies to see every strategy id on this account; create_strategy returns a new one.",
    invalid_type_error:
      "strategyId must be a string UUID. Call list_strategies to see every strategy id on this account.",
  })
  .trim()
  .uuid({
    message:
      "strategyId must be a UUID like '3f0c1e7a-2b44-4d19-9f5e-8a1c2d3e4f50'. Names, labels and slugs are not accepted - " +
      "call list_strategies to look up the id for a strategy by name (create_strategy also returns the id it just built).",
  })
  .describe(
    "Strategy UUID. Find it with list_strategies (it is also returned by create_strategy). Not a strategy name."
  );

export const AnalysisId = z
  .string({
    required_error:
      "analysisId is required. Call list_research to see saved research report ids; create_research returns a new one.",
    invalid_type_error: "analysisId must be a string UUID. Call list_research to see saved research report ids.",
  })
  .trim()
  .uuid({
    message:
      "analysisId must be a UUID like '3f0c1e7a-2b44-4d19-9f5e-8a1c2d3e4f50'. Call list_research to look up the id of a " +
      "saved report (create_research also returns the id it just generated).",
  })
  .describe("Research report UUID from create_research or list_research.");

export const Timeframe = z
  .enum(TIMEFRAME_VALUES, {
    errorMap: () => ({
      message:
        `timeframe must be exactly one of: ${TIMEFRAME_LIST} (lowercase). The Pyon engine resolves only these five bar ` +
        `sizes - '1D', 'daily', 'D', '1w', '1wk', '1mo', '30m' and '4h' are not supported. Use '1d' for daily bars.`,
    }),
  })
  .describe(`Bar timeframe. One of: ${TIMEFRAME_LIST} (lowercase only).`);

/**
 * A YYYY-MM-DD calendar date that really exists and is not in the future.
 *
 * Built fresh per call on purpose: zod-to-json-schema de-duplicates identical
 * schema *instances* into a `$ref`, so sharing one object between startDate and
 * endDate would publish endDate as `{"$ref": ".../startDate"}`, which several
 * agent clients render as "no information about this parameter". A distinct
 * instance per field keeps every parameter fully self-describing.
 */
export function isoDate(): z.ZodType<string, z.ZodTypeDef, string> {
  return z
    .string({
      required_error: "Dates must be given as a YYYY-MM-DD string, e.g. '2024-01-15'.",
      invalid_type_error: "Dates must be a YYYY-MM-DD string, e.g. '2024-01-15' - not a number or Date object.",
    })
    .trim()
    .regex(ISO_DATE_RE, {
      message:
        "Date must be in ISO format YYYY-MM-DD with zero padding, e.g. '2024-01-15'. Formats like '15/01/2024', " +
        "'Jan 15 2024', '2024-1-5' and full timestamps are not accepted.",
    })
    .refine((value) => parseIsoDateUtc(value) !== undefined, {
      message:
        "Date must be a real calendar date: '2024-02-29' exists but '2025-02-29', '2024-02-30' and '2024-13-01' do not. " +
        "Months are 01-12 and the day must exist in that month.",
    })
    .refine(
      (value) => parseIsoDateUtc(value) === undefined || value <= todayIsoUtc(),
      // Built per parse so the quoted "today" never goes stale in a long-lived server.
      () => ({
        message:
          "Date cannot be in the future - Pyon backtests only run over history that already happened. " +
          `The latest date you can use is today, ${todayIsoUtc()} (UTC).`,
      })
    )
    .refine((value) => parseIsoDateUtc(value) === undefined || value >= EARLIEST_BACKTEST_DATE, {
      message:
        `Date must be ${EARLIEST_BACKTEST_DATE} or later - Pyon's market data does not extend before the year 2000, ` +
        "so earlier windows always return zero bars.",
    })
    .describe(`Calendar date as YYYY-MM-DD. A real date between ${EARLIEST_BACKTEST_DATE} and today (UTC).`);
}

/** The shared ISO-date primitive. Prefer isoDate() when embedding it in a tool object. */
export const IsoDate = isoDate();

export const InitialCapital = z
  .number({
    required_error: `initialCapital must be a number between ${MIN_INITIAL_CAPITAL} and ${MAX_INITIAL_CAPITAL}.`,
    invalid_type_error: `initialCapital must be a plain number (not a string), between ${MIN_INITIAL_CAPITAL} and ${MAX_INITIAL_CAPITAL}. Default ${DEFAULT_INITIAL_CAPITAL}.`,
  })
  .finite({
    message: `initialCapital must be a finite number between ${MIN_INITIAL_CAPITAL} and ${MAX_INITIAL_CAPITAL}.`,
  })
  .positive({
    message: `initialCapital must be positive - a backtest cannot start with zero or negative cash. Allowed range ${MIN_INITIAL_CAPITAL} to ${MAX_INITIAL_CAPITAL}, default ${DEFAULT_INITIAL_CAPITAL}.`,
  })
  .min(MIN_INITIAL_CAPITAL, {
    message: `initialCapital must be at least ${MIN_INITIAL_CAPITAL} - below that, position sizing rounds to nothing and the strategy looks dead. Allowed range ${MIN_INITIAL_CAPITAL} to ${MAX_INITIAL_CAPITAL}, default ${DEFAULT_INITIAL_CAPITAL}.`,
  })
  .max(MAX_INITIAL_CAPITAL, {
    message: `initialCapital must be at most ${MAX_INITIAL_CAPITAL} (100 million). Allowed range ${MIN_INITIAL_CAPITAL} to ${MAX_INITIAL_CAPITAL}, default ${DEFAULT_INITIAL_CAPITAL}.`,
  })
  .default(DEFAULT_INITIAL_CAPITAL)
  .describe(
    `Starting cash for the backtest. Number between ${MIN_INITIAL_CAPITAL} and ${MAX_INITIAL_CAPITAL}; defaults to ${DEFAULT_INITIAL_CAPITAL}.`
  );

export const Steps = z
  .number({
    required_error: `steps must be a whole number between ${MIN_STEPS} and ${MAX_STEPS}.`,
    invalid_type_error: `steps must be a plain whole number (not a string) between ${MIN_STEPS} and ${MAX_STEPS}. Default ${DEFAULT_STEPS}.`,
  })
  .int({
    message: `steps must be a whole number - grid resolution cannot be fractional. Allowed ${MIN_STEPS} to ${MAX_STEPS}, default ${DEFAULT_STEPS}.`,
  })
  .min(MIN_STEPS, {
    message: `steps must be at least ${MIN_STEPS} - fewer points cannot show a shape in the parameter surface. Allowed ${MIN_STEPS} to ${MAX_STEPS}, default ${DEFAULT_STEPS}.`,
  })
  .max(MAX_STEPS, {
    message: `steps must be at most ${MAX_STEPS} - the sweep runs steps x steps backtests, so ${MAX_STEPS} already means ${MAX_STEPS * MAX_STEPS} runs. Allowed ${MIN_STEPS} to ${MAX_STEPS}, default ${DEFAULT_STEPS}.`,
  })
  .default(DEFAULT_STEPS)
  .describe(
    `Grid resolution per axis; steps x steps backtests are run. Whole number ${MIN_STEPS} to ${MAX_STEPS}, default ${DEFAULT_STEPS}.`
  );

export const NodeId = NonEmptyString("nodeId", {
  max: 200,
  allowed: "It must be a node id exactly as returned by get_strategy(strategyId) - the id, not the node's label.",
}).describe("Node id exactly as returned by get_strategy. Use the id field, not the label.");

export const ConfigField = NonEmptyString("configField", {
  max: 200,
  allowed:
    "It must be one of the config keys get_strategy lists for that node, e.g. 'period', 'threshold' or 'quantity'.",
}).describe("Numeric config field name on that node, exactly as listed by get_strategy (e.g. 'period', 'threshold').");

/** A finite number for one end of a sweep axis. */
function SweepBound(field: string): z.ZodNumber {
  return z
    .number({
      required_error: `${field} is required and must be a finite number.`,
      invalid_type_error: `${field} must be a plain finite number (not a string).`,
    })
    .finite({ message: `${field} must be a finite number - Infinity and NaN are not valid sweep bounds.` });
}

/* ------------------------------------------------------------------ */
/* Error formatting + handler-side parsing                             */
/* ------------------------------------------------------------------ */

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join(" | ");
}

/**
 * Parse inside a tool handler so cross-field rules apply. The thrown message is
 * what the agent sees, so it names the tool and lists every violated rule.
 */
export function parseInput<T>(toolName: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, args: unknown): T {
  const result = schema.safeParse(args);
  if (result.success) return result.data;
  throw new Error(`Invalid arguments for ${toolName}: ${formatZodIssues(result.error)}`);
}

/* ------------------------------------------------------------------ */
/* Per-tool input schemas                                              */
/* ------------------------------------------------------------------ */

export const SearchSymbolsInput = z
  .object({
    query: NonEmptyString("query", {
      max: 100,
      allowed: "Pass a ticker or a company/asset name fragment, e.g. 'AAPL', 'apple' or 'bitcoin'.",
    }).describe("Ticker or name fragment to search for, e.g. 'AAPL', 'apple', 'bitcoin'. 1-100 characters."),
  })
  .strict();

export const ListStrategiesInput = z.object({}).strict();

export const GetStrategyInput = z
  .object({
    strategyId: StrategyId,
  })
  .strict();

export const CreateStrategyInput = z
  .object({
    description: NonEmptyString("description", {
      min: MIN_PROMPT_CHARS,
      max: 8000,
      allowed: VAGUE_PROMPT_HINT,
    }).describe(
      `What to build, in plain language - at least ${MIN_PROMPT_CHARS} characters. Name the instrument, entry rule, exit rule ` +
        `and position size, e.g. 'RSI mean reversion on AAPL: buy when RSI(14) crosses below 30, sell when RSI crosses above 55, ` +
        `25% of cash per entry'. Call get_capabilities first so you use real indicator names and in-range thresholds.`
    ),
    analysisId: AnalysisId.optional().describe(
      "Optional research report UUID from create_research or list_research; grounds the build in that research."
    ),
  })
  .strict();

export const EditStrategyInput = z
  .object({
    strategyId: StrategyId,
    instruction: NonEmptyString("instruction", {
      min: MIN_PROMPT_CHARS,
      max: 8000,
      allowed:
        "State exactly what to change and to what, e.g. 'loosen the RSI entry threshold from 30 to 35 and add a 5% trailing stop loss'. " +
        "A vague instruction produces a vague edit; diagnose_strategy's agentRequest can be passed here verbatim.",
    }).describe(
      `The change to make, in plain language - at least ${MIN_PROMPT_CHARS} characters, e.g. 'loosen the RSI entry threshold from ` +
        `30 to 35 and add a 5% trailing stop loss'. diagnose_strategy's agentRequest can be pasted here verbatim.`
    ),
  })
  .strict();

export const DiagnoseStrategyInput = z
  .object({
    strategyId: StrategyId,
    question: NonEmptyString("question", {
      min: MIN_PROMPT_CHARS,
      max: 2000,
      allowed:
        "Ask something specific, e.g. 'why did this take zero trades in 2025?'. A vague question produces a vague diagnosis - " +
        "omit the parameter entirely to get a general health check instead.",
    })
      .optional()
      .describe(
        `Optional specific question, at least ${MIN_PROMPT_CHARS} characters, e.g. 'why did this take zero trades in 2025?'. ` +
          `Omit it entirely for a general health check.`
      ),
  })
  .strict();

export const RunBacktestObject = z
  .object({
    strategyId: StrategyId,
    startDate: isoDate()
      .optional()
      .describe(
        `Window start, YYYY-MM-DD (${EARLIEST_BACKTEST_DATE} or later). Defaults to ${DEFAULT_BACKTEST_WINDOW_DAYS} days before endDate.`
      ),
    endDate: isoDate()
      .optional()
      .describe(
        `Window end, YYYY-MM-DD. Must be a real calendar date no later than today, after startDate, and at least ${MIN_BACKTEST_WINDOW_DAYS} days from it. Defaults to today.`
      ),
    timeframe: Timeframe.optional().describe(
      `Bar timeframe: one of ${TIMEFRAME_LIST} (lowercase). Defaults to the strategy's native timeframe, fetched automatically.`
    ),
    initialCapital: InitialCapital,
  })
  .strict();

export const RunBacktestInput = RunBacktestObject.superRefine((value, ctx) => {
  const window = resolveBacktestWindow(value.startDate, value.endDate);
  if (!Number.isFinite(window.days)) return;
  if (window.days <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endDate"],
      message:
        `endDate (${window.endDate}) must be strictly AFTER startDate (${window.startDate}). ` +
        `Backtests run forward in time; swap the two values if they are the wrong way round. ` +
        `Omitting both gives the default window: the last ${DEFAULT_BACKTEST_WINDOW_DAYS} days.`,
    });
    return;
  }
  if (window.days < MIN_BACKTEST_WINDOW_DAYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["startDate"],
      message:
        `The backtest window must span at least ${MIN_BACKTEST_WINDOW_DAYS} days; ${window.startDate} to ${window.endDate} is ` +
        `${window.days} day(s). A window this short contains too few bars to warm up indicators, so it always reports zero ` +
        `trades. Use at least ${MIN_BACKTEST_WINDOW_DAYS} days, and at least ${SHORT_DAILY_WINDOW_DAYS} days for a 1d strategy.`,
    });
    return;
  }
  if (window.days > MAX_BACKTEST_WINDOW_DAYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["startDate"],
      message:
        `The backtest window (${window.startDate} to ${window.endDate}) spans ${window.days} days; the maximum is ` +
        `${MAX_BACKTEST_WINDOW_DAYS} (about 10 years). Longer windows exceed available market data and time out.`,
    });
  }
});

export const OptimizeStrategyObject = z
  .object({
    strategyId: StrategyId,
    xNodeId: NodeId.describe("Node id whose config field varies along the x axis. Exactly as returned by get_strategy."),
    xField: ConfigField.describe("Numeric config field on the x node, e.g. 'period' or 'threshold'."),
    xMin: SweepBound("xMin").describe("Lowest x value to test. Must be strictly less than xMax."),
    xMax: SweepBound("xMax").describe("Highest x value to test. Must be strictly greater than xMin."),
    yNodeId: NodeId.describe("Node id whose config field varies along the y axis. May be the same node as xNodeId."),
    yField: ConfigField.describe(
      "Numeric config field on the y node. Must differ from xField when yNodeId equals xNodeId."
    ),
    yMin: SweepBound("yMin").describe("Lowest y value to test. Must be strictly less than yMax."),
    yMax: SweepBound("yMax").describe("Highest y value to test. Must be strictly greater than yMin."),
    steps: Steps,
    timeframe: Timeframe.optional().describe(
      `Optional bar timeframe override: one of ${TIMEFRAME_LIST} (lowercase). Defaults to what the server picks for the strategy.`
    ),
  })
  .strict();

export const OptimizeStrategyInput = OptimizeStrategyObject.superRefine((value, ctx) => {
  if (value.xMax <= value.xMin) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["xMax"],
      message:
        `xMax (${value.xMax}) must be strictly greater than xMin (${value.xMin}) - a sweep axis needs a range to walk. ` +
        `For an RSI threshold a typical axis is xMin 20, xMax 40; for a lookback period, xMin 5, xMax 50.`,
    });
  }
  if (value.yMax <= value.yMin) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["yMax"],
      message:
        `yMax (${value.yMax}) must be strictly greater than yMin (${value.yMin}) - a sweep axis needs a range to walk. ` +
        `Pick bounds that bracket the value get_strategy currently shows for that field.`,
    });
  }
  if (
    canonicalKey(value.xNodeId) === canonicalKey(value.yNodeId) &&
    canonicalKey(value.xField) === canonicalKey(value.yField)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["yField"],
      message:
        `The two sweep axes point at the same parameter (${value.xNodeId}.${value.xField}), so the grid would test one ` +
        `dimension twice and every row would be identical. Pick a different node id or a different config field for the y ` +
        `axis - call get_strategy(strategyId) to see the other numeric fields available.`,
    });
  }
});

export const CreateResearchInput = z
  .object({
    prompt: NonEmptyString("prompt", {
      min: MIN_PROMPT_CHARS,
      max: 8000,
      allowed:
        "Say what to research and from which angle, e.g. 'deep dive on NVDA: AI capex cycle, competitive risks, and valuation'.",
    }).describe(
      `What to research - at least ${MIN_PROMPT_CHARS} characters, e.g. 'deep dive on NVDA: AI capex cycle, risks, and valuation'.`
    ),
  })
  .strict();

export const GetResearchInput = z
  .object({
    analysisId: AnalysisId,
  })
  .strict();

export const ListResearchInput = z.object({}).strict();

export const GetJobStatusInput = z
  .object({
    jobId: NonEmptyString("jobId", {
      max: 200,
      allowed:
        "Use the id quoted in a timeout error message - a job id from create_strategy / edit_strategy / diagnose_strategy / " +
        "optimize_strategy / create_research, or a backtest id from a run_backtest timeout.",
    }).describe(
      "Job id copied from a timeout error message. A backtest id from a run_backtest timeout is also accepted."
    ),
  })
  .strict();

export const GetCapabilitiesInput = z
  .object({
    section: z
      .enum(CAPABILITY_SECTIONS, {
        errorMap: () => ({
          message: `section must be one of: ${CAPABILITY_SECTIONS.join(", ")}. Omit it to get everything ("all").`,
        }),
      })
      .default("all")
      .describe(
        `Which slice of the catalog to return: ${CAPABILITY_SECTIONS.join(", ")}. Defaults to "all" (the whole catalog).`
      ),
  })
  .strict();

/**
 * Every tool's full validation schema, keyed by tool name. The smoke test drives
 * this map directly, so a new tool cannot ship without its validation covered.
 */
export const TOOL_INPUT_SCHEMAS = {
  search_symbols: SearchSymbolsInput,
  list_strategies: ListStrategiesInput,
  get_strategy: GetStrategyInput,
  create_strategy: CreateStrategyInput,
  edit_strategy: EditStrategyInput,
  run_backtest: RunBacktestInput,
  diagnose_strategy: DiagnoseStrategyInput,
  optimize_strategy: OptimizeStrategyInput,
  create_research: CreateResearchInput,
  get_research: GetResearchInput,
  list_research: ListResearchInput,
  get_job_status: GetJobStatusInput,
  get_capabilities: GetCapabilitiesInput,
} as const;

export type ToolName = keyof typeof TOOL_INPUT_SCHEMAS;
