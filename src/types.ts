/**
 * Explicit TypeScript shapes for everything this server consumes from the Pyon
 * API and everything it hands back to an agent.
 *
 * The wire is tolerated loosely (see getProp in format.ts - the backend
 * serializes PascalCase in some places and camelCase in others), but every tool
 * assembles one of the interfaces below before returning. That way a backend
 * field rename shows up as a compile error here rather than as a silently
 * missing key in an agent's JSON.
 *
 * Convention: `field: T | undefined` means "always emitted as a key, value may
 * be missing on the wire" (JSON.stringify drops the undefined ones). `field?: T`
 * means "only present in some responses".
 */

export type ConfigPrimitive = string | number | boolean;

/* ------------------------------------------------------------------ */
/* Strategies                                                          */
/* ------------------------------------------------------------------ */

export interface StrategyListItem {
  id: string | undefined;
  name: string | undefined;
  nodeCount: number | undefined;
  updatedAt: string | undefined;
}

export interface StrategyListResult {
  count: number;
  strategies: StrategyListItem[];
  note?: string;
}

/** One node of a strategy graph, flattened for agent consumption. */
export interface GraphNode {
  id: string | undefined;
  type: string | undefined;
  label: string | undefined;
  config: Record<string, ConfigPrimitive>;
}

export interface StrategyDetail {
  id: string;
  name: string | undefined;
  description: string | undefined;
  nativeTimeframe: string | undefined;
  nodeCount: number;
  nodes: GraphNode[];
  hint: string;
}

/* ------------------------------------------------------------------ */
/* Backtests                                                           */
/* ------------------------------------------------------------------ */

export interface BacktestMetrics {
  totalTrades: number | undefined;
  totalOrders?: number;
  totalReturnPct: number | undefined;
  sharpeRatio: number | undefined;
  maxDrawdownPct: number | undefined;
  winRate?: number;
}

export interface BacktestWindow {
  startDate: string;
  endDate: string;
  days: number;
}

export interface BacktestResult {
  strategyId: string;
  backtestId: string;
  window: BacktestWindow;
  timeframe: string;
  initialCapital: number;
  metrics: BacktestMetrics;
  diagnostics: string[];
  /** Explains a 0-trade result (dead strategy vs entered-and-still-holding). */
  note?: string;
  /** Non-fatal advisory, e.g. a daily strategy tested over too short a window. */
  warning?: string;
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

export type JobState = "pending" | "running" | "building" | "completed" | "error" | "failed" | "unknown";

export interface JobStatus {
  jobId: string;
  status: string;
  result?: string;
  error?: string;
  hint?: string;
}

/** get_job_status falling back to the backtest endpoint for a backtest id. */
export interface BacktestJobStatus {
  backtestId: string;
  kind: "backtest";
  status: string;
  metrics?: BacktestMetrics;
  diagnostics?: string[];
  error?: string;
  hint?: string;
}

/* ------------------------------------------------------------------ */
/* AI build / edit / diagnose                                          */
/* ------------------------------------------------------------------ */

export interface CreateStrategyResult {
  strategyId: string | undefined;
  name: string | undefined;
  summary: string | undefined;
  raw?: string;
  nextSteps: string;
}

export interface EditStrategyResult {
  strategyId: string;
  summary: string | undefined;
  verdict: string | undefined;
  verdictMeaning?: string;
  beforeTrades: number | undefined;
  afterTrades: number | undefined;
  beforeReturnPct: number | undefined;
  afterReturnPct: number | undefined;
  revertToVersion: string | number | undefined;
  note: string;
}

export interface DiagnoseStrategyResult {
  strategyId: string;
  message: string | undefined;
  issues: string[];
  agentRequest?: string;
  hint?: string;
}

/* ------------------------------------------------------------------ */
/* Optimization (2-D sweep)                                            */
/* ------------------------------------------------------------------ */

export interface SweepCell {
  x: number;
  y: number;
  sharpe?: number;
  returnPct?: number;
  trades?: number;
}

export interface SweepCurrentCell {
  x: number | undefined;
  y: number | undefined;
  sharpe?: number;
  returnPct?: number;
  trades?: number;
}

export interface OptimizeResult {
  strategyId: string;
  xLabel: string | undefined;
  yLabel: string | undefined;
  xs: number[];
  ys: number[];
  windowDays: number | undefined;
  timeframe: string | undefined;
  best: SweepCell | undefined;
  current: SweepCurrentCell | undefined;
  sharpeGrid: (number | null)[][] | undefined;
  gridNote: string;
  allZeroTrades?: string;
}

/* ------------------------------------------------------------------ */
/* Research (Lab analyses)                                             */
/* ------------------------------------------------------------------ */

/** The stored analysis document as the API returns it, narrowed to what we read. */
export interface AnalysisConfig {
  analysisId: string | undefined;
  title: string | undefined;
  symbol: string | undefined;
  name: string | undefined;
  overallScore: number | undefined;
  overallView: string | undefined;
  executiveSummary: string | undefined;
  /** Raw narratives block; individual sections are pulled out with getProp. */
  narratives: unknown;
}

export interface AnalysisListItem {
  analysisId: string | undefined;
  title: string | undefined;
  symbol: string | undefined;
  createdAt: string | undefined;
  updatedAt: string | undefined;
}

export interface AnalysisListResult {
  count: number;
  reports: AnalysisListItem[];
  note?: string;
}

export interface CreateResearchResult {
  analysisId?: string;
  title?: string | undefined;
  symbol?: string | undefined;
  overallScore?: number | undefined;
  overallView?: string | undefined;
  executiveSummary?: string | undefined;
  hint?: string;
  warning?: string;
  raw?: string;
}

export interface ResearchReport {
  analysisId: string | undefined;
  title: string | undefined;
  symbol: string | undefined;
  name: string | undefined;
  overallScore: number | undefined;
  overallView: string | undefined;
  executiveSummary: string | undefined;
  thesis: string | undefined;
  risks: string | undefined;
  catalysts: string | undefined;
  conclusion: string | undefined;
}

/* ------------------------------------------------------------------ */
/* Symbol search                                                       */
/* ------------------------------------------------------------------ */

export interface SearchResult {
  symbol: string | undefined;
  name: string | undefined;
  exchange: string | undefined;
  assetClass: string | undefined;
  /** Only set when no symbol field could be located, so nothing is lost. */
  raw?: string;
}

export interface SearchResultSet {
  query: string;
  count: number;
  results: SearchResult[];
  note?: string;
}

/* ------------------------------------------------------------------ */
/* Capability catalog (GET /api/capabilities, with bundled fallback)   */
/* ------------------------------------------------------------------ */

export const CAPABILITY_SECTIONS = [
  "indicators",
  "portfolio_indicators",
  "operators",
  "triggers",
  "actions",
  "timeframes",
  "tickers",
  "all",
] as const;

export type CapabilitySection = (typeof CAPABILITY_SECTIONS)[number];

export interface IndicatorSpec {
  name: string;
  category: string;
  description: string;
  /** e.g. "0-100" - a threshold outside this range can never fire. */
  valueRange?: string;
  /** indicatorParams keys this indicator accepts, comma separated. */
  params?: string;
}

export interface NamedSpec {
  name: string;
  description: string;
}

export interface TimeframeSpec {
  value: string;
  label: string;
}

export interface TickerSpec {
  symbol: string;
  assetClass: string;
}

export interface Capabilities {
  version: string;
  marketIndicators: IndicatorSpec[];
  portfolioIndicators: IndicatorSpec[];
  operators: NamedSpec[];
  triggerTypes: NamedSpec[];
  actionTypes: NamedSpec[];
  timeframes: TimeframeSpec[];
  quantityTypes: NamedSpec[];
  optionStrategyTypes: NamedSpec[];
  tickers: TickerSpec[];
}

export type CapabilitiesSource = "api" | "bundled";

export interface CapabilitiesBundle {
  catalog: Capabilities;
  source: CapabilitiesSource;
  /** Human-readable explanation of which source was used and why. */
  sourceNote: string;
}
