// Verifies each user's access token by exchanging it (RFC 8693) at Pyon for a separate Pyon API token.
// The exchange is the audience check, and the user's own token never reaches the API.
import { createHash } from "node:crypto";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { HostedConfig } from "./config.js";

export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

const EXCHANGE_TIMEOUT_MS = 10_000;
const EXPIRY_MARGIN_MS = 60_000;
const MAX_CACHED = 10_000;

interface CachedExchange {
  info: AuthInfo;
  staleAt: number;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class TokenExchangeVerifier implements OAuthTokenVerifier {
  private readonly cache = new Map<string, CachedExchange>();

  constructor(
    private readonly config: HostedConfig,
    private readonly tokenEndpoint: string,
    private readonly fetchFn: FetchLike = fetch,
    private readonly now: () => number = Date.now
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const key = cacheKey(token);
    const cached = this.cache.get(key);
    if (cached && cached.staleAt > this.now()) return cached.info;
    this.cache.delete(key);

    const response = await this.exchange(token);
    const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    // Pyon answers an unusable subject token with invalid_request (RFC 8693 section 2.2.2), so the client must sign in again.
    if (response.status === 400 && (body?.error === "invalid_request" || body?.error === "invalid_grant"))
      throw new InvalidTokenError("The access token is not valid for this server. Sign in to Pyon again.");
    const apiToken = body?.access_token;
    const expiresIn = Number(body?.expires_in);
    if (!response.ok || typeof apiToken !== "string" || !Number.isFinite(expiresIn) || expiresIn <= 0)
      throw new ServerError(`Pyon could not verify the access token (HTTP ${response.status}).`);

    const issuedAt = this.now();
    const info: AuthInfo = {
      token,
      clientId: "pyon-connected-app",
      scopes: String(body?.scope ?? "").split(" ").filter((s) => s.length > 0),
      expiresAt: Math.floor(issuedAt / 1000) + Math.floor(expiresIn),
      resource: this.config.publicUrl,
      extra: { apiToken },
    };
    this.remember(key, { info, staleAt: issuedAt + Math.max(0, expiresIn * 1000 - EXPIRY_MARGIN_MS) });
    return info;
  }

  /** Drops a token Pyon has stopped accepting, so the next request is verified afresh and answered 401. */
  forget(token: string): void {
    this.cache.delete(cacheKey(token));
  }

  private exchange(token: string): Promise<Response> {
    const credentials = `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`;
    return this.fetchFn(this.tokenEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(credentials).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: token,
        subject_token_type: ACCESS_TOKEN_TYPE,
        resource: this.config.apiResource,
      }).toString(),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    }).catch((err: unknown) => {
      throw new ServerError(`Pyon could not be reached to verify the token: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private remember(key: string, entry: CachedExchange): void {
    if (this.cache.size >= MAX_CACHED) {
      const now = this.now();
      for (const [k, v] of this.cache) if (v.staleAt <= now) this.cache.delete(k);
      if (this.cache.size >= MAX_CACHED) this.cache.clear();
    }
    this.cache.set(key, entry);
  }
}

// The SHA-256 digest, the same way Pyon itself looks tokens up.
function cacheKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
