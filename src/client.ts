/**
 * Thin fetch wrapper for the Pyon API.
 * Adds Bearer auth from PYON_API_KEY, JSON handling, and error normalization.
 */

const DEFAULT_API_URL = "https://api.pyon.io";

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
  const key = process.env.PYON_API_KEY;
  if (!key) {
    throw new PyonApiError(
      "PYON_API_KEY is not set. Create a personal access token (pyk_...) in Account > API Access at app.pyon.io and set PYON_API_KEY in this MCP server's environment."
    );
  }

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
    throw new PyonApiError(
      "Invalid or revoked Pyon API key - create one in Account > API Access at app.pyon.io",
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
