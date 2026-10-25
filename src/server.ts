import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMarketTools } from "./tools/market.js";
import { registerStrategyTools } from "./tools/strategies.js";
import { registerAiTools } from "./tools/ai.js";
import { registerBacktestTools } from "./tools/backtests.js";
import { registerOptimizeTools } from "./tools/optimize.js";
import { registerResearchTools } from "./tools/research.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerCapabilityTools } from "./tools/capabilities.js";
import { registerWealthTools } from "./tools/wealth.js";
import { registerWealthBrandingTools } from "./tools/wealth-branding.js";
import { loadCapabilities, renderCapabilitiesMarkdown } from "./capabilities.js";
import { GETTING_STARTED, QUANT_GETTING_STARTED, WEALTH_GETTING_STARTED } from "./resources.js";
import { OAUTH_SCOPES, type ServerOptions } from "./permissions.js";

export const SERVER_NAME = "pyon-mcp";
export const SERVER_VERSION = "0.3.0";

export function createServer(options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const toolset = options.toolset ?? "quant";
  const permitted = (scope: string): boolean => options.scopes === undefined || options.scopes.has(scope);

  // JSON-RPC allows omitting params.arguments entirely, and real agent clients
  // do it for tools whose parameters are all optional - but the SDK feeds the
  // raw undefined to zod, which rejects every object schema with "Required".
  // Defaulting to {} here keeps strict per-tool validation (a tool with
  // required parameters still fails loudly, naming the missing field) while
  // making an omitted arguments object legal. The shim is an own property of
  // this instance rather than a patch on McpServer.prototype: the SDK invokes it
  // as `this.validateToolInput(...)`, so the own property shadows the inherited
  // method for this server only, and any other McpServer sharing the process
  // keeps stock behavior. Guarded: if a future SDK renames the hook, the shim
  // silently no-ops and behavior reverts to the SDK default - scripts/smoke.mjs
  // calls the all-optional tools with no arguments object, so that regression
  // fails the smoke suite rather than shipping.
  type ValidateToolInput = (tool: unknown, args: unknown, name: string) => Promise<unknown>;
  const target = server as unknown as { validateToolInput?: ValidateToolInput };
  const inherited = target.validateToolInput;
  if (typeof inherited === "function") {
    target.validateToolInput = (tool, args, name) => inherited.call(server, tool, args ?? {}, name);
  }

  if (toolset !== "wealth" && permitted(OAUTH_SCOPES.quant)) {
    registerCapabilityTools(server);
    registerMarketTools(server);
    registerStrategyTools(server);
    registerAiTools(server);
    registerBacktestTools(server);
    registerOptimizeTools(server);
    registerResearchTools(server);
    registerJobTools(server);
  }
  if (toolset !== "quant" && permitted(OAUTH_SCOPES.wealthRead)) {
    registerWealthTools(server, { issueReports: permitted(OAUTH_SCOPES.issueReports) });
    registerWealthBrandingTools(server, { buildBrand: permitted(OAUTH_SCOPES.branding) });
  }

  server.registerResource(
    "getting-started",
    "pyon://getting-started",
    {
      title: "Pyon getting started",
      description: toolset === "wealth"
        ? "Wealth client reviews, report previews, explicit issue permissions and report branding"
        :
        "Typical agent workflow (capabilities -> research -> strategy -> backtest -> diagnose -> edit -> optimize), " +
        "auth setup, enforced input rules, and plan limits",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: toolset === "wealth" ? WEALTH_GETTING_STARTED : toolset === "quant" ? QUANT_GETTING_STARTED : GETTING_STARTED }],
    })
  );

  if (toolset !== "wealth" && permitted(OAUTH_SCOPES.quant)) server.registerResource(
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
