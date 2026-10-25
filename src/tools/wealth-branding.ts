/**
 * Pyon Wealth brand building tools. An organisation admin's agent starts a build
 * from the firm's website, follows it, and shows the proposed pages; nothing is
 * saved until an admin uses the result in Pyon Wealth's layout editor.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pyonFetch } from "../client.js";
import { getProp, getString, run, WithImages } from "../format.js";
import { mapNotFound } from "../notfound.js";
import { parseInput } from "../schemas.js";
import {
  GetBrandBuildInput, ListBrandBuildsInput, ListOrganisationsInput, MAX_PREVIEW_PAGES, StartBrandBuildInput,
} from "../wealth-schemas.js";

const builds = (organisationId: string) => `/api/wealth/organisations/${encodeURIComponent(organisationId)}/branding/builds`;
const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const FOLLOW = "The build runs in the background for a few minutes. Call get_brand_build with this buildId about every 30 seconds until its status is Succeeded or Failed.";
const USE = "Show the adviser every page with the summary, decisions and warnings. To use the brand, an organisation admin opens Build a brand from your website in Pyon Wealth's layout editor, uses this build, and saves a draft for review before publishing.";

/** The fields every build answer shares, so a list and a single build read the same way. */
function build(row: unknown) {
  return { buildId: getString(row, "id"), website: getString(row, "website"), status: getString(row, "status"),
    createdAt: getString(row, "createdAt") ?? null, example: getString(row, "example") ?? null, failure: getString(row, "failure") ?? null };
}

export function registerWealthBrandingTools(server: McpServer, permissions = { buildBrand: true }): void {
  server.registerTool(
    "list_organisations",
    {
      title: "List Pyon Wealth organisations",
      description:
        "List the Pyon Wealth organisations the adviser belongs to. Takes no parameters. Returns organisationId, name, role (Admin or Member) " +
        "and canManageBranding for each. Brand builds need an organisation where canManageBranding is true.",
      inputSchema: ListOrganisationsInput,
      annotations: { title: "List Pyon Wealth organisations", readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        parseInput("list_organisations", ListOrganisationsInput, args);
        const found = rows(await pyonFetch<unknown>("/api/wealth/organisations"));
        return { organisations: found.map((row) => ({ organisationId: getString(row, "id"), name: getString(row, "name"),
          role: getString(row, "role"), canManageBranding: getProp(row, "canManageBranding") === true })) };
      })
  );

  if (permissions.buildBrand) server.registerTool(
    "start_brand_build",
    {
      title: "Start building a report brand from a website",
      description:
        "Start building a proposed client report brand from the firm's public website. Pyon's builder reads the site, chooses an example layout, " +
        "restyles it with the firm's name, colours and logo, and checks the rendered pages. The proposal is stored for review; the live brand is not changed or published. Parameters: " +
        "organisationId (UUID, required, from list_organisations, where you are an admin); website (required, the public address, at most 2048 " +
        "characters); rightsConfirmed (must be exactly true, only when the firm owns or may use the website's name, logo and colours). One build " +
        "runs at a time and ten can start in a day. Returns buildId and status; then follow it with get_brand_build.",
      inputSchema: StartBrandBuildInput,
      annotations: { title: "Start building a report brand from a website", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const { organisationId, website } = parseInput("start_brand_build", StartBrandBuildInput, args);
        const started = await pyonFetch<unknown>(builds(organisationId), { method: "POST", body: { website, rightsConfirmed: true } });
        return { ...build(started), nextStep: FOLLOW };
      })
  );

  server.registerTool(
    "list_brand_builds",
    {
      title: "List report brand builds",
      description:
        "List an organisation's ten most recent brand builds, newest first. Parameters: organisationId (UUID, required, from list_organisations). " +
        "Returns buildId, website, status (Queued, Running, Succeeded or Failed), createdAt, the example it was built on, and any failure reason.",
      inputSchema: ListBrandBuildsInput,
      annotations: { title: "List report brand builds", readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const { organisationId } = parseInput("list_brand_builds", ListBrandBuildsInput, args);
        return { builds: rows(await pyonFetch<unknown>(builds(organisationId))).map(build) };
      })
  );

  server.registerTool(
    "get_brand_build",
    {
      title: "Get a report brand build",
      description:
        "Get one brand build's progress or result. Parameters: organisationId (UUID, required); buildId (UUID, required, from start_brand_build " +
        "or list_brand_builds); maxPages (0 to 12, default 12). Returns status, the builder's steps, and when it succeeded the example, summary, " +
        "decisions with their website evidence, warnings and chosen colours, followed by the proposed pages as images; when it failed, the reason.",
      inputSchema: GetBrandBuildInput,
      annotations: { title: "Get a report brand build", readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const { organisationId, buildId, maxPages } = parseInput("get_brand_build", GetBrandBuildInput, args);
        const path = `${builds(organisationId)}/${encodeURIComponent(buildId)}`;
        const found = await mapNotFound("brand build", buildId, () => pyonFetch<unknown>(path));
        const status = getString(found, "status");
        const result = getProp(found, "result");
        const summary = { ...build(found), steps: rows(getProp(found, "steps")), pageCount: getProp(found, "pageCount") ?? 0,
          summary: getString(result, "summary") ?? null, decisions: rows(getProp(result, "decisions")), warnings: rows(getProp(result, "warnings")),
          colours: getProp(getProp(result, "theme"), "colours") ?? null };
        if (status !== "Succeeded") return { ...summary, nextStep: status === "Failed" ? "Tell the adviser why it failed; they can start another build." : FOLLOW };
        const limit = maxPages ?? MAX_PREVIEW_PAGES;
        const pages = limit === 0 ? [] : rows(getProp(await pyonFetch<unknown>(`${path}/pages`), "pages")).filter((page): page is string => typeof page === "string");
        return new WithImages({ ...summary, pagesShown: Math.min(limit, pages.length), nextStep: USE }, pages.slice(0, limit));
      })
  );
}
