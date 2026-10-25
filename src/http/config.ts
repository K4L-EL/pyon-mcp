// Configuration for the hosted (Streamable HTTP) server, read from the environment.
// The stdio server reads none of it.
import { OAUTH_SCOPES, type Toolset } from "../permissions.js";

const DEFAULT_API_URL = "https://api.pyon.io";
const DEFAULT_ALLOWED_ORIGINS = ["https://claude.ai", "https://claude.com"];
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export interface HostedConfig {
  /** The MCP endpoint exactly as users add it in Claude; it is also the OAuth resource tokens are issued for. */
  publicUrl: URL;
  apiUrl: string;
  /** The Pyon authorization server's issuer, whose metadata names the token endpoint. */
  issuer: string;
  /** The resource the server exchanges each user's token for, so the user's own token never reaches the API. */
  apiResource: string;
  clientId: string;
  clientSecret: string;
  host: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  requiredScope: string;
  toolset: Exclude<Toolset, "all">;
  supportedScopes: string[];
}

export class HostedConfigError extends Error {
  constructor(problems: string[]) {
    super(`pyon-mcp cannot start the hosted server:\n  - ${problems.join("\n  - ")}`);
    this.name = "HostedConfigError";
  }
}

function list(value: string | undefined): string[] | undefined {
  const items = value?.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
  return items && items.length > 0 ? items : undefined;
}

function httpUrl(value: string | undefined): URL | undefined {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function readHostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig {
  const problems: string[] = [];
  const toolset = env.PYON_MCP_PRODUCT ?? "quant";
  if (toolset !== "quant" && toolset !== "wealth") problems.push("PYON_MCP_PRODUCT must be quant or wealth");
  const publicUrl = httpUrl(env.PYON_MCP_PUBLIC_URL);
  if (!publicUrl) problems.push("PYON_MCP_PUBLIC_URL must be the public URL of the MCP endpoint, for example https://mcp.pyon.io/mcp");
  else if (publicUrl.hash || publicUrl.search) problems.push("PYON_MCP_PUBLIC_URL must have no query or fragment");
  else if (publicUrl.protocol !== "https:" && !LOOPBACK_HOSTS.includes(publicUrl.hostname))
    problems.push("PYON_MCP_PUBLIC_URL must use https unless it is on localhost");

  const apiUrl = (env.PYON_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  const clientId = env.PYON_MCP_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.PYON_MCP_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret)
    problems.push("PYON_MCP_CLIENT_ID and PYON_MCP_CLIENT_SECRET must hold this server's resource server credentials at Pyon");

  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) problems.push("PORT must be a TCP port number");

  if (problems.length > 0 || !publicUrl || (toolset !== "quant" && toolset !== "wealth")) throw new HostedConfigError(problems);

  const host = env.HOST?.trim() || "127.0.0.1";
  const loopback = LOOPBACK_HOSTS.includes(host) || host === "::1";
  return {
    publicUrl,
    apiUrl,
    issuer: (env.PYON_AUTH_ISSUER || apiUrl).replace(/\/+$/, ""),
    apiResource: env.PYON_API_RESOURCE || apiUrl,
    clientId,
    clientSecret,
    host,
    port,
    allowedHosts: list(env.PYON_MCP_ALLOWED_HOSTS) ?? [publicUrl.hostname, ...(loopback ? LOOPBACK_HOSTS : [])],
    allowedOrigins: list(env.PYON_MCP_ALLOWED_ORIGINS) ?? DEFAULT_ALLOWED_ORIGINS,
    toolset,
    requiredScope: toolset === "wealth" ? OAUTH_SCOPES.wealthRead : OAUTH_SCOPES.quant,
    supportedScopes: toolset === "wealth"
      ? [OAUTH_SCOPES.wealthRead, OAUTH_SCOPES.issueReports, OAUTH_SCOPES.branding] : [OAUTH_SCOPES.quant],
  };
}
