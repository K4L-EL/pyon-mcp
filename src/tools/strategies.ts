import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pyonFetch } from "../client.js";
import { flattenConfig, getArray, getNumber, getObject, getProp, getString, run, truncate } from "../format.js";
import { GetStrategyInput, ListStrategiesInput } from "../schemas.js";
import type { GraphNode, StrategyDetail, StrategyListItem, StrategyListResult } from "../types.js";

const MAX_STRATEGIES = 100;

export function registerStrategyTools(server: McpServer): void {
  server.registerTool(
    "list_strategies",
    {
      title: "List strategies",
      description:
        "List the user's saved trading strategies on Pyon. " +
        "Use this to find an existing strategy's id before calling get_strategy, run_backtest, edit_strategy, " +
        "diagnose_strategy, or optimize_strategy, or to check what already exists before building something new with create_strategy. " +
        "Parameters: none - the arguments object may be empty or omitted entirely. " +
        `Returns id (UUID), name, nodeCount, and updatedAt for up to ${MAX_STRATEGIES} strategies; ` +
        "call get_strategy for the native timeframe and node-level detail.",
      inputSchema: ListStrategiesInput,
    },
    async () =>
      run(async () => {
        const res = await pyonFetch<unknown>("/api/strategies");
        const items = Array.isArray(res) ? res : getArray(res, "items");

        const strategies: StrategyListItem[] = items.slice(0, MAX_STRATEGIES).map((item) => ({
          id: getString(item, "id"),
          name: getString(item, "name"),
          nodeCount: getNumber(item, "nodeCount"),
          updatedAt: getString(item, "updatedAt"),
        }));

        const out: StrategyListResult = { count: items.length, strategies };
        if (items.length > MAX_STRATEGIES) {
          out.note = `Showing first ${MAX_STRATEGIES} of ${items.length} strategies.`;
        }
        return out;
      })
  );

  server.registerTool(
    "get_strategy",
    {
      title: "Get strategy detail",
      description:
        "Fetch a single strategy's structure: name, description, native timeframe, and a per-node summary with " +
        "each node's id, type, label, and flattened numeric/string config values. " +
        "Use this before optimize_strategy - the node ids and config field names shown here are exactly what " +
        "optimize_strategy needs as xNodeId/xField and yNodeId/yField - or to understand what a strategy actually " +
        "does before editing it. " +
        "Parameters: strategyId (UUID, required; find it with list_strategies). " +
        "Returns compact JSON; the raw graph is never dumped.",
      inputSchema: GetStrategyInput,
    },
    async ({ strategyId }) =>
      run(async () => {
        const detail = await pyonFetch<unknown>(`/api/strategies/${encodeURIComponent(strategyId)}`);

        const graphRaw = getProp(detail, "graphJson") ?? getProp(detail, "graph");
        let graph: unknown = graphRaw;
        if (typeof graphRaw === "string") {
          try {
            graph = JSON.parse(graphRaw);
          } catch {
            graph = undefined;
          }
        }

        const nodes: GraphNode[] = getArray(graph, "nodes").map((n) => {
          const data = getObject(n, "data");
          return {
            id: getString(n, "id"),
            type: getString(n, "type") ?? getString(data, "type"),
            label: getString(data, "label"),
            config: flattenConfig(getObject(data, "config")),
          };
        });

        const out: StrategyDetail = {
          id: getString(detail, "id") ?? strategyId,
          name: getString(detail, "name"),
          description: truncate(getString(detail, "description"), 800),
          nativeTimeframe: getString(detail, "nativeTimeframe"),
          nodeCount: nodes.length,
          nodes,
          hint:
            "To sweep parameters, pass a node's id as xNodeId/yNodeId and one of its config keys as xField/yField to " +
            "optimize_strategy. The two axes must not point at the same node id AND field.",
        };
        return out;
      })
  );
}
