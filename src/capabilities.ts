/**
 * The Pyon strategy capability catalog: which indicators, operators, triggers,
 * actions, timeframes, quantity types and tickers the engine actually accepts.
 *
 * Source of truth is GET /api/capabilities. That endpoint is new, so everything
 * here is written to survive its absence: any failure (404, 401, network error,
 * malformed payload) falls back to BUNDLED_CAPABILITIES below, and every caller
 * is told which source it got. The bundled copy mirrors the catalog embedded in
 * the backend's AI build prompt (BuildJobService.GetGenerateSystemPrompt /
 * userPrompt) plus BarsPerSession for the timeframes.
 */

import { apiBaseUrl, sharedFetchCredential } from "./client.js";
import { asString, getArray, getString } from "./format.js";
import type {
  Capabilities,
  CapabilitiesBundle,
  CapabilitySection,
  IndicatorSpec,
  NamedSpec,
  TickerSpec,
  TimeframeSpec,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* Bundled catalog                                                     */
/* ------------------------------------------------------------------ */

const MARKET_INDICATORS: IndicatorSpec[] = [
  { name: "RSI", category: "momentum", description: "Relative Strength Index", valueRange: "0-100", params: "period" },
  { name: "MACD", category: "momentum", description: "MACD line value", params: "fastPeriod, slowPeriod" },
  { name: "SMA", category: "trend", description: "Simple moving average price", params: "period" },
  { name: "EMA", category: "trend", description: "Exponential moving average price", params: "period" },
  {
    name: "BB",
    category: "volatility",
    description:
      "Bollinger %B - where price sits inside the band, NOT a price. 0 = on the lower band, 100 = on the upper band. For an absolute band price use BB_LOWER / BB_UPPER",
    valueRange: "0-100",
    params: "period, stdDevMultiplier",
  },
  { name: "Price", category: "price", description: "Latest bar close price" },
  { name: "Volume", category: "volume", description: "Bar volume" },
  { name: "DailyPnL", category: "position", description: "Profit and loss so far today" },
  { name: "NewsSentiment", category: "news", description: "Aggregated news sentiment score" },
  { name: "NewsCount", category: "news", description: "Number of recent news items" },
  { name: "ATR", category: "volatility", description: "Average True Range in price terms", params: "period" },
  { name: "ATR_PCT", category: "volatility", description: "ATR as a percentage of price", params: "period" },
  { name: "STOCH_K", category: "momentum", description: "Stochastic %K", valueRange: "0-100", params: "period" },
  { name: "STOCH_D", category: "momentum", description: "Stochastic %D signal line", valueRange: "0-100", params: "period" },
  {
    name: "WILLR",
    category: "momentum",
    description: "Williams %R - oversold is about -80, NOT +20",
    valueRange: "-100 to 0",
    params: "period",
  },
  { name: "ADX", category: "trend", description: "Average Directional Index trend strength", valueRange: "0-100", params: "period" },
  { name: "CCI", category: "momentum", description: "Commodity Channel Index", params: "period" },
  { name: "MFI", category: "momentum", description: "Money Flow Index", valueRange: "0-100", params: "period" },
  { name: "OBV", category: "volume", description: "On-Balance Volume" },
  { name: "RETURN_PCT", category: "price", description: "Trailing N-bar percentage return", params: "period" },
  { name: "SPREAD", category: "pairs", description: "Price spread against a second asset", params: "asset2" },
  { name: "RATIO", category: "pairs", description: "Price ratio against a second asset", params: "asset2" },
  { name: "ZSCORE", category: "pairs", description: "Z-score of the pair spread", params: "asset2, period" },
  { name: "DONCHIAN_HIGH", category: "price", description: "Highest high over the lookback - use for breakouts", params: "period" },
  { name: "DONCHIAN_LOW", category: "price", description: "Lowest low over the lookback", params: "period" },
  { name: "NEW_HIGH", category: "price", description: "1 when the bar prints a new N-bar high", valueRange: "0 or 1", params: "period" },
  { name: "NEW_LOW", category: "price", description: "1 when the bar prints a new N-bar low", valueRange: "0 or 1", params: "period" },
  { name: "CONSECUTIVE_UP", category: "price", description: "Count of consecutive up bars" },
  { name: "CONSECUTIVE_DOWN", category: "price", description: "Count of consecutive down bars" },
  { name: "GAP_PCT", category: "price", description: "Overnight gap as a percentage" },
  { name: "OPENING_RANGE_HIGH", category: "intraday", description: "High of the opening range (intraday only)", params: "minutes" },
  { name: "OPENING_RANGE_LOW", category: "intraday", description: "Low of the opening range (intraday only)", params: "minutes" },
  { name: "RETURN_RANK", category: "rotation", description: "Return rank within a universe, 1 = strongest", params: "universe, period" },
  { name: "DAYS_TO_EX_DIV", category: "calendar", description: "Days until the next ex-dividend date" },
  { name: "NEXT_DIV_AMOUNT", category: "calendar", description: "Amount of the next dividend" },
  {
    name: "EarningsSurprisePct",
    category: "calendar",
    description: "Last earnings surprise percentage - may be unavailable on the current data plan",
  },
  {
    name: "DaysToEarnings",
    category: "calendar",
    description: "Days until earnings; negative after the event. Shifts by weekends, so use ranges, never equals",
  },
  { name: "SUPERTREND", category: "trend", description: "Supertrend ATR flip line; compare Price crosses_above/below it", params: "period, multiplier" },
  { name: "SUPERTREND_DIR", category: "trend", description: "Supertrend direction", valueRange: "+1 or -1", params: "period, multiplier" },
  { name: "PSAR", category: "trend", description: "Parabolic SAR level", params: "step, maxStep" },
  { name: "ICHIMOKU_TENKAN", category: "trend", description: "Ichimoku conversion line (9)" },
  { name: "ICHIMOKU_KIJUN", category: "trend", description: "Ichimoku base line (26)" },
  { name: "CLOUD_TOP", category: "trend", description: "Top of the Ichimoku cloud; price above it is a bullish breakout" },
  { name: "CLOUD_BOTTOM", category: "trend", description: "Bottom of the Ichimoku cloud" },
  { name: "HA_TREND", category: "trend", description: "Consecutive Heikin-Ashi candles, +N bullish / -N bearish" },
  { name: "BB_UPPER", category: "volatility", description: "Absolute upper Bollinger band price", params: "period, stdDevMultiplier" },
  { name: "BB_LOWER", category: "volatility", description: "Absolute lower Bollinger band price", params: "period, stdDevMultiplier" },
  { name: "BB_WIDTH", category: "volatility", description: "Bollinger band width in percent; low means compression", params: "period, stdDevMultiplier" },
  { name: "KELTNER_UPPER", category: "volatility", description: "Upper Keltner channel", params: "period, atrPeriod, multiplier" },
  { name: "KELTNER_LOWER", category: "volatility", description: "Lower Keltner channel", params: "period, atrPeriod, multiplier" },
  {
    name: "SQUEEZE",
    category: "volatility",
    description: "TTM squeeze: 1 when Bollinger sits inside Keltner. Entry is SQUEEZE crosses_below 1 plus a direction filter",
    valueRange: "0 or 1",
  },
  { name: "REALIZED_VOL", category: "volatility", description: "Annualized realized volatility percentage", params: "period" },
  {
    name: "RSI_DIVERGENCE",
    category: "momentum",
    description: "RSI divergence signal",
    valueRange: "-1 bearish, 0 none, +1 bullish",
    params: "period, lookback",
  },
  { name: "PIVOT_P", category: "intraday", description: "Classic floor pivot from the previous session" },
  { name: "PIVOT_R1", category: "intraday", description: "First resistance pivot" },
  { name: "PIVOT_S1", category: "intraday", description: "First support pivot" },
  { name: "PIVOT_R2", category: "intraday", description: "Second resistance pivot" },
  { name: "PIVOT_S2", category: "intraday", description: "Second support pivot" },
  { name: "VOL_RANK", category: "rotation", description: "Realized-vol rank within a universe, 1 = LOWEST vol", params: "universe, period" },
  { name: "DAYS_IN_POSITION", category: "position", description: "Days since the position opened - use for 'hold N days then exit'" },
  {
    name: "DAYS_TO_EXPIRY",
    category: "position",
    description:
      "Days to the nearest open option expiration; 999 when no option is open. Gate option entries with equals 999 and exits with less_than 999",
  },
];

const PORTFOLIO_INDICATORS: IndicatorSpec[] = [
  { name: "PortfolioValue", category: "portfolio", description: "Total portfolio value (cash plus positions)" },
  { name: "CashBalance", category: "portfolio", description: "Uninvested cash" },
  { name: "TotalPnL", category: "portfolio", description: "Total profit and loss in currency" },
  { name: "TotalPnLPct", category: "portfolio", description: "Total profit and loss as a percentage" },
  { name: "PositionCount", category: "portfolio", description: "Number of open positions" },
  { name: "PositionPnL", category: "portfolio", description: "Profit and loss of the current position" },
  {
    name: "PositionSize",
    category: "portfolio",
    description:
      "Size of the current position in the underlying. Does NOT detect open options - options are keyed by contract, so use DAYS_TO_EXPIRY for those",
  },
  { name: "ExposurePct", category: "portfolio", description: "Invested percentage of the portfolio" },
  { name: "DailyPnL", category: "portfolio", description: "Profit and loss so far today" },
];

const OPERATORS: NamedSpec[] = [
  { name: "greater_than", description: "value > threshold" },
  { name: "less_than", description: "value < threshold" },
  { name: "equals", description: "value == threshold (also used for text labels such as ML current_state)" },
  { name: "greater_than_or_equal", description: "value >= threshold" },
  { name: "less_than_or_equal", description: "value <= threshold" },
  { name: "crosses_above", description: "value crossed the threshold upward on this bar" },
  { name: "crosses_below", description: "value crossed the threshold downward on this bar" },
  { name: "between", description: "threshold <= value <= threshold2" },
];

const TRIGGER_TYPES: NamedSpec[] = [
  { name: "price_change", description: "Fires on a percentage price move" },
  { name: "indicator_signal", description: "Fires when an indicator condition is met" },
  { name: "time_based", description: "Fires at a time of day" },
  { name: "schedule", description: "Fires on a cron schedule; a specific day-of-week is honored in daily backtests" },
  { name: "manual", description: "Fires only when the user runs the strategy" },
  { name: "portfolio_value_change", description: "Fires on a portfolio value move" },
  { name: "position_pnl", description: "Fires on a position profit and loss threshold" },
  { name: "portfolio_drawdown", description: "Fires on a portfolio drawdown threshold" },
];

const ACTION_TYPES: NamedSpec[] = [
  { name: "buy", description: "Open or add to a long position" },
  { name: "sell", description: "Reduce or short a position" },
  { name: "pair_trade", description: "Open both legs of a pairs trade as one managed combo (asset1, asset2, side, notional, hedgeRatio)" },
  { name: "option_combo", description: "Open an option structure; REQUIRES strategyType and dteTarget" },
  { name: "close_position", description: "Close one position" },
  { name: "close_all_positions", description: "Close everything - the only safe exit for hedged option structures" },
  { name: "set_stop_loss", description: "Persistent stop; type 'percent' plus limitPrice, trailing true to ratchet. Place after buy/sell" },
  { name: "set_take_profit", description: "Persistent take profit; type 'percent' plus limitPrice. Place after buy/sell" },
  { name: "notify", description: "Send a notification" },
  { name: "log", description: "Write a log line" },
  { name: "api_request", description: "Call an external API. Opt-in only, and returns nothing in a backtest" },
  { name: "llm_request", description: "Ask an LLM at run time. Opt-in only, and returns nothing in a backtest" },
  { name: "ml_predict", description: "Run a trained ML model. Opt-in only, and mlModelId must be one of your trained models" },
];

const TIMEFRAMES: TimeframeSpec[] = [
  { value: "1m", label: "1 minute (intraday)" },
  { value: "5m", label: "5 minutes (intraday)" },
  { value: "15m", label: "15 minutes (intraday)" },
  { value: "1h", label: "1 hour (intraday)" },
  { value: "1d", label: "1 day (daily bars)" },
];

const QUANTITY_TYPES: NamedSpec[] = [
  { name: "units", description: "A fixed share/contract count. Use only when the user names a share count" },
  { name: "usd", description: "A dollar notional. REQUIRED for crypto (X:) and forex (C:) - 1000 units of BTC is $85M" },
  {
    name: "percent_cash",
    description:
      "Percentage of available cash. The default choice: 15-30 for one of several positions, 50-100 when the strategy holds one position at a time",
  },
];

const OPTION_STRATEGY_TYPES: NamedSpec[] = [
  { name: "vertical_spread", description: "Debit or credit vertical; direction 'bear' gives a bear put spread" },
  { name: "straddle", description: "Long or short at-the-money call plus put" },
  { name: "strangle", description: "Out-of-the-money call plus put" },
  { name: "iron_condor", description: "Four-leg range-bound structure" },
  { name: "covered_call", description: "Short call against long stock - pair it with a buy action" },
  { name: "short_put", description: "Cash-secured short put" },
  { name: "custom", description: "Hand-built structure; requires legs[]" },
];

function tickers(assetClass: string, symbols: string[]): TickerSpec[] {
  return symbols.map((symbol) => ({ symbol, assetClass }));
}

const TICKERS: TickerSpec[] = [
  ...tickers("stock", [
    "AAPL", "GOOGL", "MSFT", "AMZN", "TSLA", "NVDA", "META", "NFLX", "AMD", "INTC",
    "SPY", "QQQ", "DIA", "IWM", "VOO", "VTI", "ARKK", "BA", "JPM", "GS",
    "V", "MA", "WMT", "KO", "PEP", "JNJ", "PFE", "UNH", "XOM", "CVX",
  ]),
  ...tickers("crypto", ["X:BTCUSD", "X:ETHUSD", "X:SOLUSD", "X:XRPUSD", "X:DOGEUSD", "X:ADAUSD"]),
  ...tickers("forex", ["C:EURUSD", "C:GBPUSD", "C:USDJPY", "C:AUDUSD", "C:USDCAD", "C:USDCHF", "C:NZDUSD"]),
  ...tickers("index", ["I:SPX", "I:NDX", "I:DJI", "I:RUT"]),
];

export const BUNDLED_CAPABILITIES: Capabilities = {
  version: "bundled-2026-08-08",
  marketIndicators: MARKET_INDICATORS,
  portfolioIndicators: PORTFOLIO_INDICATORS,
  operators: OPERATORS,
  triggerTypes: TRIGGER_TYPES,
  actionTypes: ACTION_TYPES,
  timeframes: TIMEFRAMES,
  quantityTypes: QUANTITY_TYPES,
  optionStrategyTypes: OPTION_STRATEGY_TYPES,
  tickers: TICKERS,
};

/** Rules that are not a list but that agents get wrong constantly. */
export const CAPABILITY_NOTES: string[] = [
  "Bounded oscillators: RSI, STOCH_K, STOCH_D, ADX and MFI are 0-100, so a threshold above 100 or below 0 can NEVER fire. WILLR is -100 to 0 (oversold is about -80, not +20). BB is %B on a 0-100 scale, not a price - use BB_UPPER / BB_LOWER for absolute band prices.",
  "Crypto (X:) and forex (C:) orders MUST use quantityType 'usd'. 1000 'units' of BTC is about $85M.",
  "Default to quantityType 'percent_cash'. A hardcoded share count risks a trivial slice of equity, so even a good strategy backtests to near-zero return and looks broken.",
  "option_combo always needs strategyType and dteTarget. Option positions are keyed by contract, so gate entries on DAYS_TO_EXPIRY equals 999 (nothing open) and exits on DAYS_TO_EXPIRY less_than 999 - PositionSize on the underlying does not see them.",
  "Never exit only the stock leg of a covered call; use close_all_positions so the short call closes with it.",
  "api_request and llm_request return nothing during a backtest, so any condition on them never fires (0 trades, 0%). Use them only when the user explicitly asks for an external call.",
  "DaysToEarnings shifts with weekends - use ranges (between -3 and -1 for 'the day after earnings'), never equals.",
  "For breakouts use OPENING_RANGE_HIGH or DONCHIAN_HIGH. 'Price crosses_above day_high' can never cross, because the day high includes the current bar.",
];

/* ------------------------------------------------------------------ */
/* Fetch with fallback                                                 */
/* ------------------------------------------------------------------ */

const CAPABILITIES_PATH = "/api/capabilities";
const FETCH_TIMEOUT_MS = 8_000;

/**
 * How long a BUNDLED result is reused before the live endpoint is tried again.
 * A live result is cached for the whole session - the catalog is static - but a
 * fallback must not be, or a single blip at startup pins a server that may run
 * for days to the bundled copy, still quoting an outage that ended hours ago.
 * The window only exists so a burst of calls during a real outage does not pay
 * the fetch timeout every time.
 */
export const FALLBACK_RETRY_MS = 60_000;

let cached: CapabilitiesBundle | undefined;
let cachedAt = 0;

/**
 * The cache policy on its own, so the smoke suite can check it with fabricated
 * clocks instead of waiting out a real minute: a live catalog is good for the
 * session, a fallback only until the retry window passes.
 */
export function shouldUseCached(
  bundle: CapabilitiesBundle | undefined,
  cachedAtMs: number,
  nowMs: number
): boolean {
  if (!bundle) return false;
  if (bundle.source === "api") return true;
  return nowMs - cachedAtMs < FALLBACK_RETRY_MS;
}

function readIndicators(value: unknown, fallbackCategory: string): IndicatorSpec[] {
  const out: IndicatorSpec[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const name = getString(raw, "name");
    if (!name) continue;
    const valueRange = getString(raw, "valueRange");
    const params = getString(raw, "params");
    out.push({
      name,
      category: getString(raw, "category") ?? fallbackCategory,
      description: getString(raw, "description") ?? "",
      ...(valueRange !== undefined ? { valueRange } : {}),
      ...(params !== undefined ? { params } : {}),
    });
  }
  return out;
}

function readNamed(value: unknown): NamedSpec[] {
  const out: NamedSpec[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    // The endpoint may send plain strings for the simpler lists.
    const asPlain = asString(raw);
    if (asPlain !== undefined) {
      out.push({ name: asPlain, description: "" });
      continue;
    }
    const name = getString(raw, "name", "value");
    if (!name) continue;
    out.push({ name, description: getString(raw, "description", "label") ?? "" });
  }
  return out;
}

function readTimeframes(value: unknown): TimeframeSpec[] {
  const out: TimeframeSpec[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const asPlain = asString(raw);
    if (asPlain !== undefined) {
      out.push({ value: asPlain, label: asPlain });
      continue;
    }
    const v = getString(raw, "value", "name");
    if (!v) continue;
    out.push({ value: v, label: getString(raw, "label", "description") ?? v });
  }
  return out;
}

function readTickers(value: unknown): TickerSpec[] {
  const out: TickerSpec[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const asPlain = asString(raw);
    if (asPlain !== undefined) {
      out.push({ symbol: asPlain, assetClass: "unknown" });
      continue;
    }
    const symbol = getString(raw, "symbol", "ticker");
    if (!symbol) continue;
    out.push({ symbol, assetClass: getString(raw, "assetClass", "class", "type") ?? "unknown" });
  }
  return out;
}

/**
 * Coerce an /api/capabilities payload into Capabilities, or return undefined if
 * it does not carry the one thing that makes it worth using: a market indicator
 * list. A half-empty response must not silently replace the bundled catalog.
 */
export function parseCapabilitiesPayload(payload: unknown): Capabilities | undefined {
  const marketIndicators = readIndicators(getArray(payload, "marketIndicators", "indicators"), "market");
  if (marketIndicators.length === 0) return undefined;

  const portfolioIndicators = readIndicators(getArray(payload, "portfolioIndicators"), "portfolio");
  const operators = readNamed(getArray(payload, "operators"));
  const triggerTypes = readNamed(getArray(payload, "triggerTypes", "triggers"));
  const actionTypes = readNamed(getArray(payload, "actionTypes", "actions"));
  const timeframesFromApi = readTimeframes(getArray(payload, "timeframes"));
  const quantityTypes = readNamed(getArray(payload, "quantityTypes"));
  const optionStrategyTypes = readNamed(getArray(payload, "optionStrategyTypes"));
  const tickerList = readTickers(getArray(payload, "tickers"));

  return {
    version: getString(payload, "version") ?? "api",
    marketIndicators,
    portfolioIndicators: portfolioIndicators.length > 0 ? portfolioIndicators : BUNDLED_CAPABILITIES.portfolioIndicators,
    operators: operators.length > 0 ? operators : BUNDLED_CAPABILITIES.operators,
    triggerTypes: triggerTypes.length > 0 ? triggerTypes : BUNDLED_CAPABILITIES.triggerTypes,
    actionTypes: actionTypes.length > 0 ? actionTypes : BUNDLED_CAPABILITIES.actionTypes,
    timeframes: timeframesFromApi.length > 0 ? timeframesFromApi : BUNDLED_CAPABILITIES.timeframes,
    quantityTypes: quantityTypes.length > 0 ? quantityTypes : BUNDLED_CAPABILITIES.quantityTypes,
    optionStrategyTypes:
      optionStrategyTypes.length > 0 ? optionStrategyTypes : BUNDLED_CAPABILITIES.optionStrategyTypes,
    tickers: tickerList.length > 0 ? tickerList : BUNDLED_CAPABILITIES.tickers,
  };
}

function bundled(reason: string): CapabilitiesBundle {
  return {
    catalog: BUNDLED_CAPABILITIES,
    source: "bundled",
    sourceNote:
      `Served from the catalog bundled with this MCP server (${BUNDLED_CAPABILITIES.version}) because ${reason}. ` +
      `It mirrors the backend's AI build prompt and is safe to rely on, but a very new indicator may be missing.`,
  };
}

/**
 * Fetch the live catalog, falling back to the bundled copy on any problem.
 * A live result is cached for the lifetime of the server session; a fallback is
 * only held for FALLBACK_RETRY_MS, so a server that started during an outage
 * recovers to the real catalog on its own.
 */
export async function loadCapabilities(): Promise<CapabilitiesBundle> {
  if (cached && shouldUseCached(cached, cachedAt, Date.now())) return cached;

  // Every user shares this cache, so the hosted server fetches the public catalog without anyone's token.
  const key = sharedFetchCredential();
  const url = apiBaseUrl() + CAPABILITIES_PATH;
  let resolved: CapabilitiesBundle;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          // The catalog is static, but send auth when we have it in case the
          // endpoint is behind the normal API gate.
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      resolved = bundled(
        res.status === 404
          ? `GET ${CAPABILITIES_PATH} returned 404 (the endpoint is not deployed on ${apiBaseUrl()} yet)`
          : `GET ${CAPABILITIES_PATH} returned HTTP ${res.status}`
      );
    } else {
      const text = await res.text();
      let payload: unknown;
      try {
        payload = text ? JSON.parse(text) : undefined;
      } catch {
        payload = undefined;
      }
      const parsed = parseCapabilitiesPayload(payload);
      resolved = parsed
        ? {
            catalog: parsed,
            source: "api",
            sourceNote: `Served live from GET ${apiBaseUrl()}${CAPABILITIES_PATH} (catalog version ${parsed.version}).`,
          }
        : bundled(`GET ${CAPABILITIES_PATH} returned a payload with no usable marketIndicators list`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    resolved = bundled(`GET ${CAPABILITIES_PATH} could not be reached (${msg})`);
  }

  cached = resolved;
  cachedAt = Date.now();
  return resolved;
}

/** Test/maintenance hook: drop the in-process cache. */
export function resetCapabilitiesCache(): void {
  cached = undefined;
  cachedAt = 0;
}

/* ------------------------------------------------------------------ */
/* Slicing and rendering                                               */
/* ------------------------------------------------------------------ */

export function sliceCapabilities(catalog: Capabilities, section: CapabilitySection): Record<string, unknown> {
  switch (section) {
    case "indicators":
      return { marketIndicators: catalog.marketIndicators };
    case "portfolio_indicators":
      return { portfolioIndicators: catalog.portfolioIndicators };
    case "operators":
      return { operators: catalog.operators };
    case "triggers":
      return { triggerTypes: catalog.triggerTypes };
    case "actions":
      return { actionTypes: catalog.actionTypes };
    case "timeframes":
      return { timeframes: catalog.timeframes };
    case "tickers":
      return { tickers: catalog.tickers };
    case "all":
      return {
        marketIndicators: catalog.marketIndicators,
        portfolioIndicators: catalog.portfolioIndicators,
        operators: catalog.operators,
        triggerTypes: catalog.triggerTypes,
        actionTypes: catalog.actionTypes,
        timeframes: catalog.timeframes,
        quantityTypes: catalog.quantityTypes,
        optionStrategyTypes: catalog.optionStrategyTypes,
        tickers: catalog.tickers,
      };
  }
}

function indicatorRows(items: IndicatorSpec[]): string {
  const rows = items.map(
    (i) =>
      `| \`${i.name}\` | ${i.category} | ${i.valueRange ?? "-"} | ${i.params ?? "-"} | ${i.description || "-"} |`
  );
  return ["| Indicator | Category | Value range | indicatorParams | Notes |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function namedRows(title: string, items: NamedSpec[]): string {
  const rows = items.map((i) => `| \`${i.name}\` | ${i.description || "-"} |`);
  return [`| ${title} | Meaning |`, "| --- | --- |", ...rows].join("\n");
}

/** Render the catalog as the pyon://capabilities resource. */
export function renderCapabilitiesMarkdown(bundle: CapabilitiesBundle): string {
  const c = bundle.catalog;
  const byClass = new Map<string, string[]>();
  for (const t of c.tickers) {
    const list = byClass.get(t.assetClass) ?? [];
    list.push(t.symbol);
    byClass.set(t.assetClass, list);
  }
  const tickerLines = [...byClass.entries()].map(
    ([cls, syms]) => `- **${cls}** (${syms.length}): ${syms.map((s) => `\`${s}\``).join(", ")}`
  );

  return `# Pyon strategy capability catalog

Source: ${bundle.source === "api" ? "live API" : "bundled fallback"}. ${bundle.sourceNote}

Everything an agent writes into a strategy description, an edit instruction or a sweep axis has to come
from these lists. An indicator name the engine does not know, or a threshold outside an indicator's range,
produces a strategy that backtests to zero trades and looks broken for no visible reason.

The \`get_capabilities\` tool returns the same catalog as JSON, one section at a time.

## Market indicators (${c.marketIndicators.length})

${indicatorRows(c.marketIndicators)}

## Portfolio indicators (${c.portfolioIndicators.length})

${indicatorRows(c.portfolioIndicators)}

## Operators

${namedRows("Operator", c.operators)}

## Trigger types

${namedRows("Trigger", c.triggerTypes)}

## Action types

${namedRows("Action", c.actionTypes)}

## Backtest timeframes

${namedRows("Timeframe", c.timeframes.map((t) => ({ name: t.value, description: t.label })))}

## Order sizing (quantityType)

${namedRows("quantityType", c.quantityTypes)}

## Option strategy types

${namedRows("strategyType", c.optionStrategyTypes)}

## Supported tickers (${c.tickers.length})

${tickerLines.join("\n")}

Only these tickers are tradable. Crypto needs the \`X:\` prefix, forex \`C:\`, indices \`I:\`; stocks have no prefix.

## Rules agents get wrong

${CAPABILITY_NOTES.map((n) => `- ${n}`).join("\n")}
`;
}
