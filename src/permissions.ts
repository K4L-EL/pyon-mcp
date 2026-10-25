/** The API's OAuth permission names. Stdio keeps its existing personal-token permissions. */
export const OAUTH_SCOPES = {
  quant: "agent",
  wealthRead: "wealth:read",
  issueReports: "reports:issue",
  branding: "wealth:branding",
} as const;

export type Toolset = "all" | "quant" | "wealth";

export interface ServerOptions {
  toolset?: Toolset;
  /** Undefined is stdio. Hosted requests always supply their granted scopes. */
  scopes?: ReadonlySet<string>;
}
