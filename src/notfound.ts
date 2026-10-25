/**
 * One phrasing for "that id does not exist here".
 *
 * A bare `Pyon API error 404: Not Found` tells an agent nothing it can act on -
 * it cannot see whether the id was mistyped, belongs to another account, or was
 * deleted earlier in the same session. delete_strategy already answered that
 * properly; every other tool taking an id did not, so the quality of the message
 * depended on which tool you happened to call.
 */

import { PyonApiError } from "./client.js";

export type ResourceKind = "strategy" | "research report" | "client" | "performance source" | "review report" | "brand build";

const LIST_TOOL: Record<ResourceKind, string> = {
  strategy: "list_strategies",
  "research report": "list_research",
  client: "list_wealth_clients",
  "performance source": "list_performance_sources",
  "review report": "list_review_reports",
  "brand build": "list_brand_builds",
};

export function notFoundMessage(kind: ResourceKind, id: string, action?: string): string {
  return (
    `No ${kind} with id ${id} exists on this account${action ? `, so ${action}` : ""}. Call ${LIST_TOOL[kind]} to see ` +
    `the ids that do exist - and note that an id which worked earlier in this session may since have been deleted, or ` +
    `may belong to a different account than this API key.`
  );
}

/**
 * Run a call, turning a 404 into a message the agent can act on. Every other
 * status passes through untouched: only 404 is unambiguously "wrong id".
 */
export async function mapNotFound<T>(kind: ResourceKind, id: string, fn: () => Promise<T>, action?: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PyonApiError && err.status === 404) {
      throw new Error(notFoundMessage(kind, id, action));
    }
    throw err;
  }
}
