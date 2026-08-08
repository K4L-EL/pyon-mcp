import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pyonFetch } from "../client.js";
import { getArray, getString, run, truncate } from "../format.js";
import { SearchSymbolsInput } from "../schemas.js";
import type { SearchResult, SearchResultSet } from "../types.js";

const MAX_RESULTS = 20;

export function registerMarketTools(server: McpServer): void {
  server.registerTool(
    "search_symbols",
    {
      title: "Search symbols",
      description:
        "Search Pyon's market database for tradable instruments by ticker or company name fragment. " +
        "Use this first whenever you need an exact symbol to mention in a research prompt or strategy description, " +
        "for example resolving 'Apple' to AAPL or checking whether Pyon covers a given asset. " +
        "Parameters: query (string, 1-100 characters, required) - a ticker or name fragment. " +
        `Returns up to ${MAX_RESULTS} matches as compact JSON with symbol, name, exchange, and assetClass. ` +
        "Note that Pyon only trades a fixed universe: call get_capabilities(section='tickers') for the definitive tradable list.",
      inputSchema: SearchSymbolsInput,
    },
    async ({ query }) =>
      run(async () => {
        const res = await pyonFetch<unknown>("/api/market/search", { query: { q: query } });
        const raw = Array.isArray(res) ? res : getArray(res, "results", "items");

        const results: SearchResult[] = raw.slice(0, MAX_RESULTS).map((item) => {
          const symbol = getString(item, "symbol", "ticker", "code");
          const entry: SearchResult = {
            symbol,
            name: getString(item, "name", "companyName", "description"),
            exchange: getString(item, "exchange", "primaryExchange", "market"),
            assetClass: getString(item, "assetClass", "type", "class"),
          };
          // Never silently drop a result we could not map onto the known fields.
          if (symbol === undefined) {
            const rawText = truncate(item, 300);
            if (rawText !== undefined) entry.raw = rawText;
          }
          return entry;
        });

        const out: SearchResultSet = { query, count: raw.length, results };
        if (raw.length > MAX_RESULTS) {
          out.note = `Showing first ${MAX_RESULTS} of ${raw.length} results.`;
        }
        return out;
      })
  );
}
