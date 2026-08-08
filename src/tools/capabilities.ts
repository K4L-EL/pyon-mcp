import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CAPABILITY_NOTES, loadCapabilities, sliceCapabilities } from "../capabilities.js";
import { run } from "../format.js";
import { GetCapabilitiesInput, TIMEFRAME_LIST } from "../schemas.js";
import { CAPABILITY_SECTIONS } from "../types.js";

export function registerCapabilityTools(server: McpServer): void {
  server.registerTool(
    "get_capabilities",
    {
      title: "Get strategy capability catalog",
      description:
        "Return the catalog of everything Pyon's strategy engine understands: market indicators (with their value " +
        "ranges and indicatorParams), portfolio indicators, comparison operators, trigger types, action types, " +
        "backtest timeframes, order sizing modes, option strategy types, and the tradable ticker universe. " +
        "CALL THIS BEFORE writing a create_strategy description, an edit_strategy instruction, or choosing " +
        "optimize_strategy sweep bounds. Strategy text is turned into a node graph literally, so an indicator name the " +
        "engine does not know, or a threshold outside an indicator's range, silently produces a strategy that backtests " +
        "to zero trades and looks broken for no visible reason - RSI, STOCH_K, STOCH_D, ADX and MFI are bounded 0-100, " +
        "so an RSI threshold above 100 can never fire; WILLR is -100 to 0 (oversold is about -80, not +20); BB is " +
        "%B on a 0-100 scale, not a price. " +
        `Parameters: section (optional, one of: ${CAPABILITY_SECTIONS.join(", ")}; default "all"). ` +
        `Timeframes are always ${TIMEFRAME_LIST}. ` +
        "The catalog is fetched from the Pyon API and falls back to a copy bundled with this server if the endpoint is " +
        "unavailable; the response always names which source was used. Results are cached for the session, so calling " +
        "it repeatedly is cheap.",
      inputSchema: GetCapabilitiesInput,
    },
    async ({ section }) =>
      run(async () => {
        const bundle = await loadCapabilities();
        return {
          section,
          source: bundle.source,
          sourceNote: bundle.sourceNote,
          version: bundle.catalog.version,
          ...sliceCapabilities(bundle.catalog, section),
          ...(section === "all" || section === "indicators" ? { notes: CAPABILITY_NOTES } : {}),
          resource:
            "The same catalog is available as readable markdown in the MCP resource pyon://capabilities.",
        };
      })
  );
}
