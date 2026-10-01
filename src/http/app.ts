// The hosted MCP endpoint: OAuth discovery documents, bearer authentication, and a stateless Streamable
// HTTP transport that serves each request with a fresh server acting as the signed-in user.
import type { Express, NextFunction, Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import type { OAuthMetadata, OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createServer } from "../server.js";
import { withRequestCredential } from "../client.js";
import type { HostedConfig } from "./config.js";
import type { TokenExchangeVerifier } from "./token-exchange.js";

export interface HostedAppOptions {
  config: HostedConfig;
  authorizationServer: OAuthMetadata;
  verifier: Pick<TokenExchangeVerifier, "verifyAccessToken" | "forget">;
}

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

export function createHostedApp({ config, authorizationServer, verifier }: HostedAppOptions): Express {
  const app = createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts });
  app.disable("x-powered-by");

  // Streamable HTTP requires a present but unexpected Origin to be refused; servers calling us send none.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) return jsonRpcError(res, 403, `Origin ${origin} is not allowed`);
    next();
  });

  // Only the base scope is advertised, so a client that asks for every advertised scope still asks for the least.
  const resourceMetadata: OAuthProtectedResourceMetadata = {
    resource: config.publicUrl.href,
    authorization_servers: [authorizationServer.issuer],
    scopes_supported: [config.requiredScope],
    resource_name: "Pyon",
  };
  // The SDK router serves the path-specific document RFC 9728 names first; the root copy serves clients that try it.
  app.use(mcpAuthMetadataRouter({
    oauthMetadata: authorizationServer,
    resourceServerUrl: config.publicUrl,
    scopesSupported: [config.requiredScope],
    resourceName: "Pyon",
  }));
  const rootMetadata = metadataHandler(resourceMetadata);
  app.use("/.well-known/oauth-protected-resource", (req, res, next) => (req.path === "/" ? rootMetadata(req, res, next) : next()));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  const mcpPath = config.publicUrl.pathname;
  app.all(mcpPath, requireBearerAuth({
    verifier,
    requiredScopes: [config.requiredScope],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.publicUrl),
  }));

  app.post(mcpPath, async (req: Request, res: Response) => {
    const auth = req.auth;
    const apiToken = auth?.extra?.apiToken;
    if (!auth || typeof apiToken !== "string") return jsonRpcError(res, 500, "The request was authenticated without a Pyon API token");
    const server = createServer();
    // No sessionIdGenerator: stateless, a fresh transport per request.
    const transport = new StreamableHTTPServerTransport({});
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    res.setHeader("X-Accel-Buffering", "no");
    try {
      // The SDK's own optional members trip exactOptionalPropertyTypes; it is the SDK's Transport all the same.
      await server.connect(transport as Transport);
      await withRequestCredential({ token: apiToken, onRejected: () => verifier.forget(auth.token) },
        () => transport.handleRequest(req, res, req.body));
    } catch (err) {
      console.error("pyon-mcp: request failed", err instanceof Error ? err.message : err);
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
    }
  });

  // Stateless: no standalone event stream to open and no session to end.
  app.all(mcpPath, (_req, res) => {
    res.setHeader("Allow", "POST");
    jsonRpcError(res, 405, "Method not allowed: this server is stateless, so send each message as its own POST.");
  });

  return app;
}
