// Starts the hosted server: reads its configuration, checks Pyon's authorization server can serve it, then listens.
import type { Server } from "node:http";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { useRequestCredentials } from "../client.js";
import { readHostedConfig, type HostedConfig } from "./config.js";
import { createHostedApp } from "./app.js";
import { TOKEN_EXCHANGE_GRANT, TokenExchangeVerifier } from "./token-exchange.js";

const METADATA_ATTEMPTS = 10;
const METADATA_RETRY_MS = 3_000;

/** Fetches the issuer's RFC 8414 metadata and refuses one that could not complete the flow this server depends on. */
export async function loadAuthorizationServer(config: HostedConfig, fetchFn: typeof fetch = fetch): Promise<OAuthMetadata> {
  const url = `${config.issuer}/.well-known/oauth-authorization-server`;
  let lastError = "";
  for (let attempt = 1; attempt <= METADATA_ATTEMPTS; attempt++) {
    try {
      const res = await fetchFn(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (res.ok) return checkMetadata(config, (await res.json()) as OAuthMetadata);
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      if (err instanceof MetadataError) throw err;
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < METADATA_ATTEMPTS) await new Promise((r) => setTimeout(r, METADATA_RETRY_MS));
  }
  throw new MetadataError(`could not read ${url} (${lastError})`);
}

export class MetadataError extends Error {}

function checkMetadata(config: HostedConfig, metadata: OAuthMetadata): OAuthMetadata {
  const problems = [
    metadata.issuer !== config.issuer && `its issuer is ${metadata.issuer}, not ${config.issuer}`,
    !metadata.code_challenge_methods_supported?.includes("S256") && "it does not support PKCE with S256",
    !metadata.grant_types_supported?.includes(TOKEN_EXCHANGE_GRANT) && "it does not support token exchange",
    !metadata.scopes_supported?.includes(config.requiredScope) && `it does not offer the ${config.requiredScope} scope`,
  ].filter((p): p is string => typeof p === "string");
  if (problems.length > 0) throw new MetadataError(`Pyon's authorization server cannot serve this connector: ${problems.join("; ")}`);
  return metadata;
}

export async function startHostedServer(env: NodeJS.ProcessEnv = process.env): Promise<Server> {
  const config = readHostedConfig(env);
  useRequestCredentials();
  const authorizationServer = await loadAuthorizationServer(config);
  const verifier = new TokenExchangeVerifier(config, authorizationServer.token_endpoint);
  const app = createHostedApp({ config, authorizationServer, verifier });
  const server = app.listen(config.port, config.host, () => {
    console.error(`pyon-mcp: hosted server listening on ${config.host}:${config.port} for ${config.publicUrl.href}`);
  });
  // Long tool calls hold their responses open, so give them a moment and then leave anyway.
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return server;
}
