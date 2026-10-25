/**
 * Shared helpers: defensive property access (backend casing may vary),
 * typed coercion off the wire, config flattening, truncation, and MCP tool
 * result shaping.
 */

import type { ConfigPrimitive } from "./types.js";

export type Primitive = ConfigPrimitive;

/**
 * Case-insensitive property lookup. The Pyon backend sometimes serializes
 * PascalCase (Nodes/Data/Config) and sometimes camelCase; handle both.
 *
 * Returns `unknown` on purpose: every call site has to narrow through one of
 * the typed readers below, so a shape change on the wire cannot slip into a
 * tool result untyped.
 */
export function getProp(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const record = obj as Record<string, unknown>;
  if (key in record) return record[key];
  const cap = key.charAt(0).toUpperCase() + key.slice(1);
  if (cap in record) return record[cap];
  const lower = key.toLowerCase();
  for (const k of Object.keys(record)) {
    if (k.toLowerCase() === lower) return record[k];
  }
  return undefined;
}

/** First defined value among several case-insensitive keys. */
export function getAny(obj: unknown, ...keys: string[]): unknown {
  for (const key of keys) {
    const v = getProp(obj, key);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/** Coerce a wire value to string. Numbers/booleans are stringified; objects are not. */
export function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

/** Coerce a wire value to a finite number. Numeric strings are accepted. */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function getString(obj: unknown, ...keys: string[]): string | undefined {
  return asString(getAny(obj, ...keys));
}

export function getNumber(obj: unknown, ...keys: string[]): number | undefined {
  return asNumber(getAny(obj, ...keys));
}

/** Always returns an array; a non-array (or missing) value becomes []. */
export function getArray(obj: unknown, ...keys: string[]): unknown[] {
  const v = getAny(obj, ...keys);
  return Array.isArray(v) ? v : [];
}

/** Returns the value only when it is a plain object, else undefined. */
export function getObject(obj: unknown, ...keys: string[]): unknown {
  const v = getAny(obj, ...keys);
  return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}

/** Lowercased status string with an explicit "unknown" default. */
export function getStatus(obj: unknown): string {
  return (getString(obj, "status") ?? "").toLowerCase() || "unknown";
}

/** Truncate a string (or the JSON of a value) to max chars with an explicit marker. */
export function truncate(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) return undefined;
  if (s.length <= max) return s;
  return s.slice(0, max) + ` ...[truncated, ${s.length - max} more chars]`;
}

/**
 * Flatten a node config object into dotted-path primitive entries
 * (numbers, strings, booleans). Arrays and deep nesting are skipped
 * beyond depth 3 to keep output compact.
 */
export function flattenConfig(
  config: unknown,
  prefix = "",
  depth = 0,
  out: Record<string, Primitive> = {}
): Record<string, Primitive> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return out;
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) continue;
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
      out[path] = v;
    } else if (typeof v === "object" && !Array.isArray(v) && depth < 3) {
      flattenConfig(v, path, depth + 1, out);
    }
  }
  return out;
}

export function round2(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

/** round2 that yields undefined rather than null, for optional result fields. */
export function round2opt(n: unknown): number | undefined {
  const r = round2(n);
  return r === null ? undefined : r;
}

export function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export class WithImages {
  constructor(readonly payload: unknown, readonly pngs: string[]) {}
}

export interface ToolResult {
  [key: string]: unknown;
  content: ToolContent[];
  isError?: boolean;
}

export function ok(payload: unknown): ToolResult {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return { content: [{ type: "text", text }] };
}

export function toolError(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: msg }] };
}

/** Wrap a tool body: return its payload as compact JSON, or a clean isError result. */
export async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await fn();
    if (value instanceof WithImages) {
      return { content: [...ok(value.payload).content, ...value.pngs.map((data): ToolContent => ({ type: "image", data, mimeType: "image/png" }))] };
    }
    return ok(value);
  } catch (err) {
    return toolError(err);
  }
}
