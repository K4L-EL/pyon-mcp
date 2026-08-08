import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMarketTools } from "./tools/market.js";
import { registerStrategyTools } from "./tools/strategies.js";
import { registerAiTools } from "./tools/ai.js";
import { registerBacktestTools } from "./tools/backtests.js";
import { registerOptimizeTools } from "./tools/optimize.js";
import { registerResearchTools } from "./tools/research.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerCapabilityTools } from "./tools/capabilities.js";
import { loadCapabilities, renderCapabilitiesMarkdown } from "./capabilities.js";
import { GETTING_STARTED } from "./resources.js";

export const SERVER_NAME = "pyon-mcp";
export const SERVER_VERSION = "0.2.1";

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // JSON-RPC allows omitting params.arguments entirely, and real agent clients
  // do it for tools whose parameters are all optional - but the SDK feeds the
  // raw undefined to zod, which rejects every object schema with "Required".
  // Defaulting to {} here keeps strict per-tool validation (a tool with
  // required parameters still fails loudly, naming the missing field) while
  // making an omitted arguments object legal. Guarded: if a future SDK renames
  // the hook, the shim silently no-ops and behavior reverts to SDK default.
  const proto = Object.getPrototypeOf(server) as {
    validateToolInput?: (tool: unknown, args: unknown, name: string) => Promise<unknown>;
  };
  if (typeof proto.validateToolInput === "function" && !(proto as { __pyonArgsShim?: boolean }).__pyonArgsShim) {
    const original = proto.validateToolInput;
    proto.validateToolInput = function (tool: unknown, args: unknown, name: string) {
      return original.call(this, tool, args ?? {}, name);
    };
    (proto as { __pyonArgsShim?: boolean }).__pyonArgsShim = true;
  }

  registerCapabilityTools(server);
  registerMarketTools(server);
  registerStrategyTools(server);
  registerAiTools(server);
  registerBacktestTools(server);
  registerOptimizeTools(server);
  registerResearchTools(server);
  registerJobTools(server);

  server.registerResource(
    "getting-started",
    "pyon://getting-started",
    {
      title: "Pyon getting started",
      description:
        "Typical agent workflow (capabilities -> research -> strategy -> backtest -> diagnose -> edit -> optimize), " +
        "auth setup, enforced input rules, and plan limits",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: GETTING_STARTED }],
    })
  );

  server.registerResource(
    "capabilities",
    "pyon://capabilities",
    {
      title: "Pyon strategy capability catalog",
      description:
        "Every market and portfolio indicator (with value ranges and params), operator, trigger type, action type, " +
        "backtest timeframe, quantityType, option strategyType and tradable ticker the Pyon engine accepts - read this " +
        "before writing any strategy description or sweep bound",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const bundle = await loadCapabilities();
      return {
        contents: [
          { uri: uri.href, mimeType: "text/markdown", text: renderCapabilitiesMarkdown(bundle) },
        ],
      };
    }
  );

  return server;
}
