export const GETTING_STARTED = `# Pyon MCP - Getting started

Pyon (app.pyon.io) is an AI-native trading platform: node-graph strategies, AI research reports,
backtesting, and parameter optimization. This MCP server exposes it to agents via api.pyon.io.

## Auth setup

1. Sign in at app.pyon.io and open Account > API Access.
2. Create a personal access token; it looks like \`pyk_...\`.
3. Set it as \`PYON_API_KEY\` in this server's environment. Optional: \`PYON_API_URL\` overrides
   the API base (default https://api.pyon.io).

A 401 error means the key is missing, invalid, or revoked - create a fresh one in Account > API Access.

## Know the vocabulary before you write anything

Read the **\`pyon://capabilities\`** resource, or call **get_capabilities**, BEFORE writing a strategy
description, an edit instruction, or sweep bounds. Strategy text is turned into a node graph literally:
an indicator name the engine does not know, or a threshold outside an indicator's range, produces a
strategy that backtests to zero trades and looks broken for no visible reason. RSI, STOCH_K, STOCH_D,
ADX and MFI are bounded 0-100; WILLR is -100 to 0; BB is %B on a 0-100 scale, not a price.

## Typical agent workflow

0. **get_capabilities** - load the real indicator, operator, action and ticker names once per session.
1. **search_symbols** - resolve names to exact tickers before writing prompts.
2. **create_research(prompt)** - generate a saved research report; note the returned analysisId.
   Use list_research / get_research to reuse existing reports.
3. **create_strategy(description, analysisId?)** - AI-build a strategy, optionally grounded in
   the research. Always run run_backtest on a newly created strategy before trusting it.
4. **run_backtest(strategyId)** - measure real performance (defaults: last 365 days, native
   timeframe, 50000 capital). Always read the diagnostics: they contain gate pass-rate evidence
   explaining why the strategy did or did not trade. 0 trades with orders opened means the
   strategy entered and is still holding - not a dead strategy.
5. **diagnose_strategy(strategyId, question?)** - when results are zero or confusing, get a causal
   diagnosis plus a ready-to-use fix instruction (agentRequest) for edit_strategy.
6. **edit_strategy(strategyId, instruction)** - apply targeted changes. Check the verification
   verdict (improved / unchanged / degraded / broke / still_zero) and re-run run_backtest.
7. **get_strategy(strategyId)** then **optimize_strategy(...)** - once the strategy trades
   sensibly, sweep two numeric node config fields over a grid to tune parameters.
8. **get_job_status(jobId)** - if any waiting tool times out, the job keeps running server-side;
   the timeout error names the id to check here.

## Input rules that are enforced, not suggested

Every tool schema is strict: an unknown or misspelled parameter is rejected outright rather than
silently ignored, so \`timeFrame\` or \`start_date\` will fail loudly. Ids are UUIDs, dates are
\`YYYY-MM-DD\` real past calendar dates, timeframes are one of \`1m, 5m, 15m, 1h, 1d\` (lowercase),
backtest windows must span at least 7 days with endDate after startDate, sweep \`steps\` is 3-10, and
build/edit prompts must be at least 10 characters. Every rejection message states what IS allowed.

## Plan limits

Some operations (AI builds, research generation, sweeps, backtest volume) are limited by the
user's plan. A 402 error passes through the exact limit message - relay it to the user and
mention that plans can be upgraded at app.pyon.io/app/billing. Do not retry 402s.

## Output conventions

All tools return compact JSON strings. Long narratives are truncated with explicit markers,
arrays are capped, and raw strategy graphs or equity curves are never dumped.

## Resources

- \`pyon://getting-started\` - this document.
- \`pyon://capabilities\` - the full indicator / operator / action / ticker catalog as markdown.
`;
