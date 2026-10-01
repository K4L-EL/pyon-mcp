/**
 * Thin fetch wrapper for the Pyon API: Bearer auth, JSON handling, and error normalization.
 * The credential is PYON_API_KEY on stdio, or the signed-in user's token on the hosted server.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const DEFAULT_API_URL = "https://api.pyon.io";

/** Where API calls get their credential: this process's PYON_API_KEY, or the user behind the current request. */
export type CredentialSource = "environment" | "request";

/** One hosted request's Pyon API token, and what to do when the API stops accepting it. */
export interface RequestCredential {
  token: string;
  onRejected?: () => void;
}

let credentialSource: CredentialSource = "environment";
const requestCredential = new AsyncLocalStorage<RequestCredential>();

/** Switches the process to per-request credentials for good, so a hosted user can never act with another's key. */
export function useRequestCredentials(): void {
  credentialSource = "request";
}

export function withRequestCredential<T>(credential: RequestCredential, run: () => T): T {
  return requestCredential.run(credential, run);
}

function currentCredential(): RequestCredential | undefined {
  if (credentialSource === "request") return requestCredential.getStore();
  const key = process.env.PYON_API_KEY;
  return key ? { token: key } : undefined;
}

/** A credential for fetches whose result every user shares; the hosted server never lends a user's token to one. */
export function sharedFetchCredential(): string | undefined {
  return credentialSource === "environment" ? process.env.PYON_API_KEY : undefined;
}

export class PyonApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "PyonApiError";
    this.status = status;
  }
}

export function apiBaseUrl(): string {
  const raw = process.env.PYON_API_URL || DEFAULT_API_URL;
  return raw.replace(/\/+$/, "");
}

function extractBodyMessage(json: unknown, rawText: string): string {
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    for (const key of ["message", "error", "detail", "title", "Message", "Error", "Detail", "Title"]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim().length > 0) return v;
    }
  }
  const text = rawText.trim();
  return text.length > 500 ? text.slice(0, 500) : text;
}

export interface FetchOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

export async function pyonFetch<T = unknown>(path: string, options: FetchOptions = {}): Promise<T> {
  const credential = currentCredential();
  if (!credential) {
    throw new PyonApiError(
      credentialSource === "request"
        ? "This request reached the Pyon tools without a signed-in user. Reconnect Pyon in your app."
        : "PYON_API_KEY is not set. Create a personal access token (pyk_...) in Account > API Access at app.pyon.io and set PYON_API_KEY in this MCP server's environment."
    );
  }
  const key = credential.token;

  let url = apiBaseUrl() + path;
  if (options.query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PyonApiError(`Could not reach the Pyon API at ${apiBaseUrl()}: ${msg}`);
  }

  const rawText = await res.text();
  let json: unknown;
  try {
    json = rawText ? JSON.parse(rawText) : undefined;
  } catch {
    json = undefined;
  }

  if (res.ok) return json as T;

  const bodyMessage = extractBodyMessage(json, rawText);

  if (res.status === 401) {
    credential.onRejected?.();
    throw new PyonApiError(
      credentialSource === "request"
        ? "Pyon no longer accepts this connection, perhaps because it was disconnected. Reconnect Pyon in your app and sign in again."
        : "Invalid or revoked Pyon API key - create one in Account > API Access at app.pyon.io",
      401
    );
  }
  if (res.status === 402) {
    const detail = bodyMessage || "Your current plan does not allow this operation.";
    throw new PyonApiError(
      `${detail} You can upgrade your plan at app.pyon.io/app/billing.`,
      402
    );
  }
  throw new PyonApiError(
    `Pyon API error ${res.status}${bodyMessage ? `: ${bodyMessage}` : `: ${res.statusText}`}`,
    res.status
  );
}
