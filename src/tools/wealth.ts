/**
 * Pyon Wealth client review tools. An agent finds a client and its performance
 * history, prepares a review report for the adviser to read page by page, and
 * issues it only after the adviser approves and only with a token allowed to.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pyonFetch } from "../client.js";
import { getProp, getString, run, WithImages } from "../format.js";
import { progressNotifier } from "../jobs.js";
import { mapNotFound } from "../notfound.js";
import { parseInput } from "../schemas.js";
import {
  GetPerformanceInput, GetPerformanceObject, IssueReviewReportInput, ListLayoutExamplesInput, ListPerformanceSourcesInput,
  ListReviewReportsInput, ListWealthClientsInput, MAX_PREVIEW_PAGES, PreviewReviewReportInput, PreviewReviewReportObject,
} from "../wealth-schemas.js";

const APPROVAL_WINDOW_MS = 30 * 60_000;
const client = (id: string) => `/api/wealth/clients/${encodeURIComponent(id)}`;
const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A graph figure keeps its reason when it is missing, so an agent never reports a gap as zero. */
function figure(value: unknown): { value: string | null; missing?: string } {
  const text = getString(value, "value");
  const missing = getString(value, "missing");
  return text !== undefined ? { value: text } : { value: null, ...(missing ? { missing } : {}) };
}

export function registerWealthTools(server: McpServer, permissions = { issueReports: true }): void {
  server.registerTool(
    "list_wealth_clients",
    {
      title: "List Pyon Wealth clients",
      description:
        "List the adviser's Pyon Wealth clients, optionally filtered by part of a name. Use this first to find the clientId every other " +
        "Wealth tool needs. Parameters: search (optional, up to 100 characters) and includeArchived (optional boolean, default false). " +
        "Returns clientId, name, and whether each client is simulated or archived. A simulated client belongs to a training or unverified " +
        "account, and its reports are marked as simulated.",
      inputSchema: ListWealthClientsInput,
      annotations: { title: "List Pyon Wealth clients", readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const input = parseInput("list_wealth_clients", ListWealthClientsInput, args);
        const found = rows(await pyonFetch<unknown>("/api/wealth/clients", { query: { search: input.search, includeArchived: input.includeArchived } }));
        return {
          count: found.length,
          clients: found.slice(0, 200).map((row) => ({ clientId: getString(row, "id"), name: getString(row, "fullName"),
            simulated: getProp(row, "isSimulated") === true, archived: getProp(row, "isArchived") === true })),
        };
      })
  );

  server.registerTool(
    "list_performance_sources",
    {
      title: "List performance history sources",
      description:
        "List a client's performance history sources: the account histories their review reports are calculated from. Parameters: clientId " +
        "(UUID, required, from list_wealth_clients). Returns sourceId, name, currency, benchmark, firstDate and lastDate for each source. " +
        "A review period must fall between a source's firstDate and lastDate.",
      inputSchema: ListPerformanceSourcesInput,
      annotations: { title: "List performance history sources", readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const { clientId } = parseInput("list_performance_sources", ListPerformanceSourcesInput, args);
        const sources = rows(await mapNotFound("client", clientId, () => pyonFetch<unknown>(`${client(clientId)}/performance-history`)));
        return {
          sources: sources.map((row) => ({ sourceId: getString(row, "id"), name: getString(row, "name"), currency: getString(row, "currency"),
            benchmark: getString(row, "benchmark"), firstDate: getString(row, "firstDate") ?? null, lastDate: getString(row, "lastDate") ?? null })),
        };
      })
  );

  server.registerTool(
    "get_performance",
    {
      title: "Get calculated performance",
      description:
        "Calculate a client's performance over a period from the accepted history, exactly as a review report will. Parameters: clientId and " +
        "sourceId (UUIDs, required), start and end (YYYY-MM-DD, required, end after start, within the source's dates). Returns the portfolio and " +
        "benchmark returns and the opening and closing values. A figure that cannot be calculated is null with its missing reason, never zero.",
      inputSchema: GetPerformanceObject,
      annotations: { title: "Get calculated performance", readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const { clientId, sourceId, start, end } = parseInput("get_performance", GetPerformanceInput, args);
        const graph = await mapNotFound("performance source", sourceId, () =>
          pyonFetch<unknown>(`${client(clientId)}/performance-history/${encodeURIComponent(sourceId)}/performance`, { query: { start, end } }));
        const points = rows(getProp(graph, "points"));
        return {
          start, end, currency: getString(graph, "currency"), simulated: getProp(graph, "isSimulated") === true,
          returnPct: figure(getProp(graph, "returnPct")), benchmarkPct: figure(getProp(graph, "benchmarkPct")),
          openingValue: figure(getProp(points[0], "valuation")), closingValue: figure(getProp(points[points.length - 1], "valuation")),
          valuationDates: points.length,
        };
      })
  );

  server.registerTool(
    "preview_review_report",
    {
      title: "Prepare a client review report preview",
      description:
        "Render a client review report preview in the firm's published branding, from the accepted history, and return its pages as images " +
        "for the adviser to review. Nothing is sent to the client. Parameters: clientId and sourceId (UUIDs, required); start and end " +
        "(YYYY-MM-DD, required); portfolioName (at most 48 characters), adviserName (at most 80), objective (at most 1200), commentary " +
        "(at most 2400) and importantInformation (at most 2400), all required and approved by the adviser; maxPages (0 to 12, default 12). " +
        "Rendering can take a minute. Returns reportId, brandName, pageCount and approvalExpiresAt, followed by the page images. Show the adviser " +
        "every page. The preview can be issued within 30 minutes, and only if the history and renderer have not changed since.",
      inputSchema: PreviewReviewReportObject,
      annotations: { title: "Prepare a client review report preview", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args, extra) =>
      run(async () => {
        const input = parseInput("preview_review_report", PreviewReviewReportInput, args);
        const onTick = progressNotifier(extra, "preview_review_report");
        const started = Date.now();
        // The API renders in a single request, so progress is sent on a timer to keep clients with short request timeouts waiting.
        const timer = onTick ? setInterval(() => void onTick(Date.now() - started, "rendering the report"), 5_000) : undefined;
        let preview: unknown;
        try {
          preview = await mapNotFound("client", input.clientId, () => pyonFetch<unknown>(`${client(input.clientId)}/review-reports/preview`, {
            method: "POST",
            body: { streamId: input.sourceId, start: input.start, end: input.end, portfolioName: input.portfolioName, adviserName: input.adviserName,
              objective: input.objective, commentary: input.commentary, importantInformation: input.importantInformation },
          }));
        } finally {
          if (timer) clearInterval(timer);
        }
        const artifact = getProp(preview, "artifact");
        const pages = rows(getProp(preview, "pages")).filter((page): page is string => typeof page === "string");
        const shown = pages.slice(0, input.maxPages ?? MAX_PREVIEW_PAGES);
        const created = Date.parse(getString(artifact, "createdAt") ?? "");
        return new WithImages({
          reportId: getString(artifact, "id"), brandName: getString(artifact, "brandName"), pageCount: pages.length, pagesShown: shown.length,
          approvalExpiresAt: Number.isFinite(created) ? new Date(created + APPROVAL_WINDOW_MS).toISOString() : null,
          nextStep: shown.length < pages.length
            ? `Only ${shown.length} of ${pages.length} pages are shown. The adviser must review every page, in Pyon Wealth if needed, before issue_review_report.`
            : "Show every page to the adviser. Only after they approve it, call issue_review_report with adviserReviewedEveryPage set to true.",
        }, shown);
      })
  );

  if (permissions.issueReports) server.registerTool(
    "issue_review_report",
    {
      title: "Issue a reviewed client report",
      description:
        "Issue a previewed client review report after the adviser has reviewed every page and approved it. Issuing stores the exact reviewed " +
        "PDF as the client's record and cannot be undone. Parameters: clientId (UUID, required); reportId (UUID from preview_review_report, " +
        "required); adviserReviewedEveryPage (must be exactly true, required). The access token must have been created with permission to issue " +
        "client reports, or Pyon refuses. A preview older than 30 minutes, or whose history or renderer changed, is refused as a conflict, so " +
        "prepare a new preview. Repeating the call for an issued report returns it unchanged. The report records that an agent issued it.",
      inputSchema: IssueReviewReportInput,
      annotations: {
        title: "Issue a reviewed client report",
        readOnlyHint: false,
        // This server marks only permanent deletions destructive; issuing adds a record, and the confirmation field and token permission guard it.
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      run(async () => {
        const { clientId, reportId } = parseInput("issue_review_report", IssueReviewReportInput, args);
        const issued = await mapNotFound("review report", reportId, () =>
          pyonFetch<unknown>(`${client(clientId)}/review-reports/${encodeURIComponent(reportId)}/issue`, { method: "POST", body: { reviewed: true } }));
        return { reportId: getString(issued, "id"), issuedAt: getString(issued, "issuedAt") ?? null, issuedThrough: getString(issued, "issuedThrough") ?? null,
          note: "The issued PDF is stored unchanged and is available to the adviser in Pyon Wealth." };
      })
  );

  server.registerTool(
    "list_review_reports",
    {
      title: "List issued client review reports",
      description:
        "List a client's issued review reports, newest first. Parameters: clientId (UUID, required). Returns reportId, brandName, issuedAt, and " +
        "whether each was issued in the web app or by an agent using an access token. Unissued previews are not listed.",
      inputSchema: ListReviewReportsInput,
      annotations: { title: "List issued client review reports", readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const { clientId } = parseInput("list_review_reports", ListReviewReportsInput, args);
        const reports = rows(await mapNotFound("client", clientId, () => pyonFetch<unknown>(`${client(clientId)}/review-reports`)));
        return { reports: reports.map((row) => ({ reportId: getString(row, "id"), brandName: getString(row, "brandName"),
          issuedAt: getString(row, "issuedAt") ?? null, issuedThrough: getString(row, "issuedThrough") ?? null })) };
      })
  );

  server.registerTool(
    "list_layout_examples",
    {
      title: "List example report brands",
      description:
        "List the fictional example brands an organisation can start its report layout from, with what each demonstrates. Takes no parameters. " +
        "Returns key, title, summary, orientation and highlights. Organisation admins start from an example in Pyon Wealth's layout editor.",
      inputSchema: ListLayoutExamplesInput,
      annotations: { title: "List example report brands", readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        parseInput("list_layout_examples", ListLayoutExamplesInput, args);
        const examples = rows(await pyonFetch<unknown>("/api/wealth/layout-examples"));
        return { examples: examples.map((row) => ({ key: getString(row, "key"), title: getString(row, "title"), summary: getString(row, "summary"),
          orientation: getString(row, "orientation"), highlights: rows(getProp(row, "highlights")) })) };
      })
  );
}
