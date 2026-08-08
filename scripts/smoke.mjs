// Smoke test for pyon-mcp.
//
// Three blocks, all offline and all keyless:
//   1. tools/list and resources/list over an in-process transport.
//   2. JSON Schema completeness - every tool must publish its parameters and
//      reject unknown ones (a tool whose schema renders as "{}" is invisible to
//      agent clients that only read tools/list).
//   3. Input validation - every tool's zod schema is driven directly with a
//      table of bad inputs that must be rejected and good inputs that must parse.
//
// Deliberately runs WITHOUT an API key, and points the API base at a closed
// port so the capability catalog deterministically exercises its bundled
// fallback instead of reaching the network.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

delete process.env.PYON_API_KEY;
process.env.PYON_API_URL = "http://127.0.0.1:1";

const { createServer } = await import("../dist/server.js");
const { TOOL_INPUT_SCHEMAS } = await import("../dist/schemas.js");

const EXPECTED_TOOLS = [
  "get_capabilities",
  "search_symbols",
  "list_strategies",
  "get_strategy",
  "create_strategy",
  "edit_strategy",
  "run_backtest",
  "diagnose_strategy",
  "optimize_strategy",
  "create_research",
  "get_research",
  "list_research",
  "get_job_status",
];
const EXPECTED_TOOL_COUNT = 13;

/* ------------------------------------------------------------------ */
/* Tiny assertion harness                                              */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];

function ok(label) {
  passed++;
  console.log(`  PASS  ${label}`);
}

function bad(label, detail) {
  failures.push(`${label}${detail ? ` - ${detail}` : ""}`);
  console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
}

function assert(condition, label, detail) {
  if (condition) ok(label);
  else bad(label, detail);
}

/* ------------------------------------------------------------------ */
/* Date helpers (windows must stay valid as the calendar moves)        */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
const TODAY = iso(0);
const TOMORROW = iso(1);
const UUID = "3f0c1e7a-2b44-4d19-9f5e-8a1c2d3e4f50";
const UUID2 = "9b1d4e2c-7a35-4c88-b0f1-52d6e9a7c311";

/* ------------------------------------------------------------------ */
/* Block 1: tools/list and resources/list                              */
/* ------------------------------------------------------------------ */

console.log("\n[1] tools/list and resources/list (no API key)");

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServer();
const client = new Client({ name: "pyon-mcp-smoke", version: "0.0.0" });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log(`  tools/list returned ${tools.length} tools: ${names.join(", ")}`);

assert(tools.length === EXPECTED_TOOL_COUNT, `tools/list returns ${EXPECTED_TOOL_COUNT} tools`, `got ${tools.length}`);

const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
const extra = names.filter((n) => !EXPECTED_TOOLS.includes(n));
assert(missing.length === 0 && extra.length === 0, "tool set matches expectation", `missing=[${missing}] extra=[${extra}]`);

for (const t of tools) {
  assert(Boolean(t.description) && t.description.length >= 40, `${t.name} has a meaningful description`);
}

// Descriptions must carry the allowed values inline: many clients show the
// description but not the schema.
const tf = "1m, 5m, 15m, 1h, 1d";
for (const name of ["run_backtest", "optimize_strategy", "get_capabilities"]) {
  const t = tools.find((x) => x.name === name);
  assert(t.description.includes(tf), `${name} description lists the allowed timeframes inline`);
}
assert(
  tools.find((t) => t.name === "run_backtest").description.includes("50000"),
  "run_backtest description states the initialCapital default inline"
);
assert(
  tools.find((t) => t.name === "optimize_strategy").description.includes("default 5"),
  "optimize_strategy description states the steps default inline"
);

const { resources } = await client.listResources();
const resourceUris = resources.map((r) => r.uri);
console.log(`  resources/list returned: ${resourceUris.join(", ")}`);
assert(resourceUris.includes("pyon://getting-started"), "pyon://getting-started resource is registered");
assert(resourceUris.includes("pyon://capabilities"), "pyon://capabilities resource is registered");

/* ------------------------------------------------------------------ */
/* Block 2: published JSON Schemas                                     */
/* ------------------------------------------------------------------ */

console.log("\n[2] published JSON Schemas");

const EXPECTED_PROPS = {
  get_capabilities: ["section"],
  search_symbols: ["query"],
  list_strategies: [],
  get_strategy: ["strategyId"],
  create_strategy: ["description", "analysisId"],
  edit_strategy: ["strategyId", "instruction"],
  run_backtest: ["strategyId", "startDate", "endDate", "timeframe", "initialCapital"],
  diagnose_strategy: ["strategyId", "question"],
  optimize_strategy: [
    "strategyId", "xNodeId", "xField", "xMin", "xMax",
    "yNodeId", "yField", "yMin", "yMax", "steps", "timeframe",
  ],
  create_research: ["prompt"],
  get_research: ["analysisId"],
  list_research: [],
  get_job_status: ["jobId"],
};

for (const t of tools) {
  const schema = t.inputSchema ?? {};
  const props = Object.keys(schema.properties ?? {});
  const expected = EXPECTED_PROPS[t.name] ?? [];
  assert(
    schema.additionalProperties === false,
    `${t.name} schema is strict (additionalProperties: false)`,
    `got ${JSON.stringify(schema.additionalProperties)}`
  );
  assert(
    expected.every((p) => props.includes(p)) && props.length === expected.length,
    `${t.name} schema publishes exactly its parameters`,
    `expected [${expected}] got [${props}]`
  );
  for (const p of props) {
    const d = schema.properties[p]?.description;
    assert(Boolean(d) && d.length > 15, `${t.name}.${p} has a descriptive schema entry`);
  }
}

/* ------------------------------------------------------------------ */
/* Block 3: input validation tables                                    */
/* ------------------------------------------------------------------ */

console.log("\n[3] input validation");

assert(
  Object.keys(TOOL_INPUT_SCHEMAS).length === EXPECTED_TOOL_COUNT,
  `every one of the ${EXPECTED_TOOL_COUNT} tools has an exported validation schema`,
  `got ${Object.keys(TOOL_INPUT_SCHEMAS).length}`
);
for (const name of EXPECTED_TOOLS) {
  assert(Boolean(TOOL_INPUT_SCHEMAS[name]), `TOOL_INPUT_SCHEMAS exports ${name}`);
}

// [tool, label, input] - each MUST be rejected.
const BAD_INPUTS = [
  // Adversary regressions: invisible characters must not count as content
  ["create_strategy", "zero-width-only description", { description: "\u200b".repeat(20) }],
  ["search_symbols", "zero-width-only query", { query: "\u200b\u200b\u200b" }],
  // Same sweep axis disguised by case or invisible suffix
  ["optimize_strategy", "same axis via case variant", { strategyId: "3f0c1e7a-2b44-4f5e-9a10-6a1b2c3d4e5f", xNodeId: "node_1", xField: "period", xMin: 10, xMax: 30, yNodeId: "node_1", yField: "Period", yMin: 10, yMax: 30 }],
  ["optimize_strategy", "same axis via zero-width suffix", { strategyId: "3f0c1e7a-2b44-4f5e-9a10-6a1b2c3d4e5f", xNodeId: "node_1", xField: "period", xMin: 10, xMax: 30, yNodeId: "node_1", yField: "period\u200b", yMin: 10, yMax: 30 }],
  // Dates before market data exist, and windows beyond 10 years
  ["run_backtest", "startDate before 2000", { strategyId: "3f0c1e7a-2b44-4f5e-9a10-6a1b2c3d4e5f", startDate: "1900-01-01", endDate: "1900-06-01" }],
  ["run_backtest", "window longer than 10 years", { strategyId: "3f0c1e7a-2b44-4f5e-9a10-6a1b2c3d4e5f", startDate: "2001-01-01", endDate: "2020-01-01" }],

  ["search_symbols", "unknown extra param (limit)", { query: "AAPL", limit: 5 }],
  ["search_symbols", "whitespace-only query", { query: "   " }],
  ["list_strategies", "unknown extra param on a no-arg tool", { page: 1 }],
  ["list_research", "unknown extra param on a no-arg tool", { limit: 10 }],

  ["get_strategy", "bad uuid (a name, not an id)", { strategyId: "rsi-mean-reversion" }],
  ["get_strategy", "bad uuid (truncated)", { strategyId: "3f0c1e7a-2b44" }],
  ["get_strategy", "unknown extra param", { strategyId: UUID, verbose: true }],
  ["get_research", "bad id", { analysisId: "latest" }],
  ["get_research", "bare analysis_ prefix", { analysisId: "analysis_" }],

  ["run_backtest", "bad date format (dd/mm/yyyy)", { strategyId: UUID, startDate: "01/02/2024" }],
  ["run_backtest", "bad date format (unpadded)", { strategyId: UUID, startDate: "2024-1-5" }],
  ["run_backtest", "bad date format (timestamp)", { strategyId: UUID, startDate: "2024-01-05T00:00:00Z" }],
  ["run_backtest", "date that is not a real day (2025-02-30)", { strategyId: UUID, startDate: "2025-02-30" }],
  ["run_backtest", "month 13", { strategyId: UUID, startDate: "2024-13-01" }],
  ["run_backtest", "future startDate", { strategyId: UUID, startDate: TOMORROW }],
  ["run_backtest", "future endDate", { strategyId: UUID, startDate: iso(-30), endDate: TOMORROW }],
  ["run_backtest", "endDate before startDate", { strategyId: UUID, startDate: iso(-30), endDate: iso(-90) }],
  ["run_backtest", "endDate equal to startDate", { strategyId: UUID, startDate: iso(-30), endDate: iso(-30) }],
  ["run_backtest", "window shorter than 7 days", { strategyId: UUID, startDate: iso(-5), endDate: TODAY }],
  ["run_backtest", 'timeframe "1D"', { strategyId: UUID, timeframe: "1D" }],
  ["run_backtest", 'timeframe "daily"', { strategyId: UUID, timeframe: "daily" }],
  ["run_backtest", 'timeframe "1w"', { strategyId: UUID, timeframe: "1w" }],
  ["run_backtest", 'timeframe "30m"', { strategyId: UUID, timeframe: "30m" }],
  ["run_backtest", "negative initialCapital", { strategyId: UUID, initialCapital: -1000 }],
  ["run_backtest", "zero initialCapital", { strategyId: UUID, initialCapital: 0 }],
  ["run_backtest", "initialCapital below the 100 floor", { strategyId: UUID, initialCapital: 50 }],
  ["run_backtest", "initialCapital above the 100m ceiling", { strategyId: UUID, initialCapital: 1e9 }],
  ["run_backtest", "initialCapital as a string", { strategyId: UUID, initialCapital: "50000" }],
  ["run_backtest", "misspelled param (timeFrame)", { strategyId: UUID, timeFrame: "1d" }],
  ["run_backtest", "snake_case param (start_date)", { strategyId: UUID, start_date: iso(-30) }],

  ["create_strategy", "3-char description", { description: "RSI" }],
  ["create_strategy", "whitespace-padded short description", { description: "   buy    " }],
  ["create_strategy", "bad analysisId", { description: "Buy AAPL when RSI(14) drops below 30", analysisId: "none" }],
  ["edit_strategy", "3-char instruction", { strategyId: UUID, instruction: "fix" }],
  ["diagnose_strategy", "3-char question", { strategyId: UUID, question: "why" }],
  ["create_research", "3-char prompt", { prompt: "NVD" }],

  ["optimize_strategy", "steps 2 (below the floor)", { ...sweep(), steps: 2 }],
  ["optimize_strategy", "steps 11 (above the ceiling)", { ...sweep(), steps: 11 }],
  ["optimize_strategy", "fractional steps", { ...sweep(), steps: 5.5 }],
  ["optimize_strategy", "xMin equal to xMax", { ...sweep(), xMin: 20, xMax: 20 }],
  ["optimize_strategy", "xMax below xMin", { ...sweep(), xMin: 40, xMax: 20 }],
  ["optimize_strategy", "yMin equal to yMax", { ...sweep(), yMin: 50, yMax: 50 }],
  ["optimize_strategy", "yMax below yMin", { ...sweep(), yMin: 70, yMax: 50 }],
  [
    "optimize_strategy",
    "same node id AND field on both axes",
    { ...sweep(), xNodeId: "node_1", xField: "period", yNodeId: "node_1", yField: "period" },
  ],
  ["optimize_strategy", "empty xNodeId", { ...sweep(), xNodeId: "" }],
  ["optimize_strategy", "non-finite xMax", { ...sweep(), xMax: Infinity }],
  ["optimize_strategy", "unknown extra param", { ...sweep(), zNodeId: "node_3" }],

  ["get_job_status", "empty jobId", { jobId: "  " }],
  ["get_capabilities", 'section "everything"', { section: "everything" }],
  ["get_capabilities", "unknown extra param", { section: "all", verbose: true }],
];

// [tool, label, input, extraCheck?] - each MUST parse.
const GOOD_INPUTS = [
  // Adversary regression: an old endDate with no startDate anchors the default
  // window to that endDate instead of blaming a startDate the caller never sent
  ["run_backtest", "past endDate alone is a valid window", { strategyId: "3f0c1e7a-2b44-4f5e-9a10-6a1b2c3d4e5f", endDate: "2025-07-04" }],
  // Same node id on both axes is legal when the FIELD genuinely differs
  ["optimize_strategy", "same node, different fields", { strategyId: "3f0c1e7a-2b44-4f5e-9a10-6a1b2c3d4e5f", xNodeId: "node_1", xField: "period", xMin: 10, xMax: 30, yNodeId: "node_1", yField: "threshold", yMin: 20, yMax: 40 }],

  ["search_symbols", "ticker query", { query: "AAPL" }],
  ["search_symbols", "name fragment query", { query: "bitcoin" }],
  ["list_strategies", "empty object", {}],
  ["list_research", "empty object", {}],
  ["get_strategy", "valid uuid", { strategyId: UUID }],
  ["get_research", "valid uuid", { analysisId: UUID }],
  // The platform's REAL id format - a uuid-only validator broke get_research in production
  ["get_research", "valid pyon analysis id", { analysisId: "analysis_7f342df3dd6d4a4" }],

  ["run_backtest", "strategyId only (all defaults)", { strategyId: UUID }, (v) => v.initialCapital === 50_000],
  [
    "run_backtest",
    "explicit one-year window on 1d bars",
    { strategyId: UUID, startDate: iso(-365), endDate: TODAY, timeframe: "1d", initialCapital: 100_000 },
  ],
  ["run_backtest", "intraday timeframe", { strategyId: UUID, startDate: iso(-30), endDate: TODAY, timeframe: "5m" }],
  ["run_backtest", "exactly the 7-day minimum window", { strategyId: UUID, startDate: iso(-7), endDate: TODAY }],
  ["run_backtest", "endDate today", { strategyId: UUID, startDate: iso(-400), endDate: TODAY }],
  ["run_backtest", "initialCapital at the floor", { strategyId: UUID, initialCapital: 100 }],

  [
    "create_strategy",
    "detailed description",
    { description: "RSI mean reversion on AAPL: buy when RSI(14) crosses below 30, sell above 55, 25% of cash" },
  ],
  [
    "create_strategy",
    "description grounded in research",
    { description: "Build the NVDA thesis from this research into a trend strategy", analysisId: UUID },
  ],
  [
    "edit_strategy",
    "specific instruction",
    { strategyId: UUID, instruction: "Loosen the RSI entry from 30 to 35 and add a 5% trailing stop" },
  ],
  ["diagnose_strategy", "no question (general health check)", { strategyId: UUID }],
  ["diagnose_strategy", "specific question", { strategyId: UUID, question: "why did this take zero trades in 2025?" }],
  ["create_research", "research prompt", { prompt: "deep dive on NVDA: AI capex cycle, risks, and valuation" }],

  ["optimize_strategy", "minimal sweep (steps default)", sweep(), (v) => v.steps === 5],
  ["optimize_strategy", "same node, different fields", { ...sweep(), yNodeId: "node_1", yField: "threshold" }],
  ["optimize_strategy", "steps at both bounds", { ...sweep(), steps: 3 }],
  ["optimize_strategy", "steps at the ceiling", { ...sweep(), steps: 10 }],
  ["optimize_strategy", "with a timeframe override", { ...sweep(), timeframe: "1h" }],
  ["optimize_strategy", "negative axis bounds", { ...sweep(), yMin: -90, yMax: -60 }],

  ["get_job_status", "job id from a timeout message", { jobId: UUID2 }],
  ["get_capabilities", "no section (defaults to all)", {}, (v) => v.section === "all"],
  ["get_capabilities", "indicators section", { section: "indicators" }],
  ["get_capabilities", "tickers section", { section: "tickers" }],
];

function sweep() {
  return {
    strategyId: UUID,
    xNodeId: "node_1",
    xField: "period",
    xMin: 10,
    xMax: 30,
    yNodeId: "node_2",
    yField: "threshold",
    yMin: 20,
    yMax: 40,
  };
}

console.log(`  ${BAD_INPUTS.length} bad inputs must be rejected:`);
for (const [tool, label, input] of BAD_INPUTS) {
  const schema = TOOL_INPUT_SCHEMAS[tool];
  if (!schema) {
    bad(`${tool}: ${label}`, "no schema exported for this tool");
    continue;
  }
  const result = schema.safeParse(input);
  if (result.success) {
    bad(`${tool} rejects ${label}`, `accepted ${JSON.stringify(input)}`);
    continue;
  }
  // A rejection is only useful if it tells the agent what IS allowed.
  const message = result.error.issues.map((i) => i.message).join(" ");
  if (message.trim().length < 20) {
    bad(`${tool} rejects ${label}`, `message too terse to act on: "${message}"`);
    continue;
  }
  ok(`${tool} rejects ${label}`);
}

console.log(`  ${GOOD_INPUTS.length} good inputs must parse:`);
for (const [tool, label, input, extraCheck] of GOOD_INPUTS) {
  const schema = TOOL_INPUT_SCHEMAS[tool];
  if (!schema) {
    bad(`${tool}: ${label}`, "no schema exported for this tool");
    continue;
  }
  const result = schema.safeParse(input);
  if (!result.success) {
    bad(`${tool} accepts ${label}`, result.error.issues.map((i) => i.message).join(" | "));
    continue;
  }
  if (extraCheck && !extraCheck(result.data)) {
    bad(`${tool} accepts ${label}`, `parsed value failed its default check: ${JSON.stringify(result.data)}`);
    continue;
  }
  ok(`${tool} accepts ${label}`);
}

/* ------------------------------------------------------------------ */
/* Block 4: capability catalog fallback (still keyless and offline)    */
/* ------------------------------------------------------------------ */

console.log("\n[4] capability catalog");

const capCall = await client.callTool({ name: "get_capabilities", arguments: { section: "indicators" } });
assert(capCall.isError !== true, "get_capabilities works without an API key", capCall.content?.[0]?.text);

// Omitted arguments object (legal JSON-RPC for all-optional tools) must reach
// the handler instead of dying in validation. Without an API key the handler
// then fails with key guidance - which proves validation passed.
for (const name of ["list_strategies", "list_research"]) {
  const res = await client.callTool({ name });
  const text = res.content?.[0]?.text ?? "";
  assert(
    !text.includes("Input validation error") && !text.includes("Required"),
    `${name} accepts an omitted arguments object`,
    text.slice(0, 120)
  );
}
{
  const res = await client.callTool({ name: "get_capabilities" });
  assert(res.isError !== true, "get_capabilities accepts an omitted arguments object", res.content?.[0]?.text);
  const res2 = await client.callTool({ name: "get_capabilities", arguments: { section: "operators", bogusKey: 1 } });
  const text2 = res2.content?.[0]?.text ?? "";
  assert(
    res2.isError === true && text2.includes("Input validation error"),
    "get_capabilities still rejects unknown keys via manual validation",
    text2.slice(0, 120)
  );
}
const capPayload = JSON.parse(capCall.content[0].text);
assert(capPayload.source === "bundled", "get_capabilities falls back to the bundled catalog when the API is unreachable");
assert(
  typeof capPayload.sourceNote === "string" && capPayload.sourceNote.length > 20,
  "get_capabilities says which source it used"
);
assert(
  Array.isArray(capPayload.marketIndicators) && capPayload.marketIndicators.length >= 50,
  "bundled catalog carries the full market indicator list",
  `got ${capPayload.marketIndicators?.length}`
);
const rsi = capPayload.marketIndicators.find((i) => i.name === "RSI");
assert(rsi?.valueRange === "0-100", "RSI publishes its bounded 0-100 range");

const allCall = await client.callTool({ name: "get_capabilities", arguments: {} });
const allPayload = JSON.parse(allCall.content[0].text);
for (const key of [
  "marketIndicators", "portfolioIndicators", "operators", "triggerTypes",
  "actionTypes", "timeframes", "quantityTypes", "optionStrategyTypes", "tickers",
]) {
  assert(Array.isArray(allPayload[key]) && allPayload[key].length > 0, `section "all" includes ${key}`);
}
assert(
  allPayload.timeframes.map((t) => t.value).join(",") === "1m,5m,15m,1h,1d",
  "catalog timeframes match the engine's supported set"
);

const capResource = await client.readResource({ uri: "pyon://capabilities" });
const markdown = capResource.contents[0].text;
assert(markdown.includes("# Pyon strategy capability catalog"), "pyon://capabilities renders markdown");
assert(markdown.includes("`RSI`") && markdown.includes("`X:BTCUSD`"), "capability markdown lists indicators and tickers");

const gettingStarted = await client.readResource({ uri: "pyon://getting-started" });
assert(
  gettingStarted.contents[0].text.includes("pyon://capabilities"),
  "pyon://getting-started references the capabilities resource"
);

// An unknown parameter must be a loud error end to end, not a silent no-op.
const strictCall = await client.callTool({ name: "get_capabilities", arguments: { section: "all", verbose: true } });
assert(strictCall.isError === true, "unknown parameters are rejected over the wire, not ignored");

/* ------------------------------------------------------------------ */
/* Block 5: cross-field rules over the wire                            */
/* ------------------------------------------------------------------ */

// The registered schema is the plain strict object (so tools/list renders every
// parameter); the cross-field rules run inside the handler. Prove they still
// fire on a real call, before any network access happens.
console.log("\n[5] cross-field rules over the wire");

const WIRE_CASES = [
  ["run_backtest", "endDate before startDate", { strategyId: UUID, startDate: iso(-30), endDate: iso(-90) }, "must be strictly AFTER"],
  ["run_backtest", "window under 7 days", { strategyId: UUID, startDate: iso(-3), endDate: TODAY }, "at least 7 days"],
  ["run_backtest", 'timeframe "1D"', { strategyId: UUID, timeframe: "1D" }, "1m, 5m, 15m, 1h, 1d"],
  ["optimize_strategy", "xMin equal to xMax", { ...sweep(), xMin: 5, xMax: 5 }, "strictly greater than xMin"],
  [
    "optimize_strategy",
    "same node and field on both axes",
    { ...sweep(), yNodeId: "node_1", yField: "period" },
    "same parameter",
  ],
  ["create_strategy", "3-char description", { description: "RSI" }, "at least 10 characters"],
];

for (const [tool, label, args, expectedFragment] of WIRE_CASES) {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  assert(
    res.isError === true && text.includes(expectedFragment),
    `${tool} rejects ${label} on a real call`,
    `isError=${res.isError} text="${text.slice(0, 160)}"`
  );
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

await client.close();

console.log(`\n${"-".repeat(60)}`);
console.log(`SMOKE SUMMARY: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log(`\nSMOKE FAILED`);
  process.exit(1);
}
console.log(`SMOKE OK: ${EXPECTED_TOOL_COUNT} tools + 2 resources, strict schemas, no API key required.`);
process.exit(0);
