import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pyonFetch } from "../client.js";
import { pollJob, requireJobId } from "../jobs.js";
import { getAny, getArray, getNumber, getObject, getString, run, truncate } from "../format.js";
import { CreateResearchInput, GetResearchInput, ListResearchInput, MIN_PROMPT_CHARS } from "../schemas.js";
import type {
  AnalysisConfig,
  AnalysisListItem,
  AnalysisListResult,
  CreateResearchResult,
  ResearchReport,
} from "../types.js";

const MAX_REPORTS = 25;

function extractAnalysisId(result: unknown): string | undefined {
  return (
    getString(result, "analysisId", "id") ??
    getString(getObject(result, "analysis"), "analysisId", "id") ??
    getString(getObject(result, "result"), "analysisId")
  );
}

function summarizeAnalysis(detail: unknown, fallbackId?: string): AnalysisConfig {
  const entity = getObject(detail, "entity");
  const summary = getObject(detail, "summary");
  const narratives = getObject(detail, "narratives");
  return {
    analysisId: getString(detail, "analysisId") ?? fallbackId,
    title: getString(detail, "title"),
    symbol: getString(entity, "symbol"),
    name: getString(entity, "name"),
    overallScore: getNumber(summary, "overallScore"),
    overallView: getString(summary, "overallView"),
    executiveSummary: truncate(getAny(narratives, "executiveSummary"), 1200),
    narratives,
  };
}

export function registerResearchTools(server: McpServer): void {
  server.registerTool(
    "create_research",
    {
      title: "Create research report",
      description:
        "Generate a saved AI research report (thesis, risks, catalysts, scored overall view) for a company or asset " +
        "from a natural-language prompt, waiting up to 300s. Use this when the user wants fundamental or thematic " +
        "research, or as the first step before building a research-grounded strategy. " +
        `Parameters: prompt (string, ${MIN_PROMPT_CHARS} to 8000 characters, required) - what to research and from which ` +
        "angle, e.g. 'deep dive on NVDA: AI capex cycle, risks, and valuation'. Resolve tickers with search_symbols first. " +
        "Returns analysisId, title, symbol, overallScore, overallView, and a truncated executive summary. Pass the " +
        "returned analysisId to create_strategy to build a strategy grounded in this research. If the wait times out, " +
        "the error includes a jobId to check with get_job_status.",
      inputSchema: CreateResearchInput,
    },
    async ({ prompt }) =>
      run(async () => {
        const res = await pyonFetch<unknown>("/api/analysis/generate-async", {
          method: "POST",
          body: { prompt },
        });
        const result = await pollJob(requireJobId(res), { timeoutMs: 300_000 });
        const analysisId = extractAnalysisId(result);

        if (!analysisId) {
          const out: CreateResearchResult = {
            warning: "Research job completed but no analysisId was found in the result; raw result below.",
          };
          const raw = truncate(result, 2000);
          if (raw !== undefined) out.raw = raw;
          return out;
        }

        let detail: unknown;
        try {
          detail = await pyonFetch<unknown>(`/api/analysis/${encodeURIComponent(analysisId)}`);
        } catch {
          detail = undefined;
        }

        const s = detail !== undefined ? summarizeAnalysis(detail, analysisId) : undefined;
        const out: CreateResearchResult = {
          analysisId,
          title: s?.title ?? getString(result, "title"),
          symbol: s?.symbol,
          overallScore: s?.overallScore,
          overallView: s?.overallView,
          executiveSummary: s?.executiveSummary,
          hint: "Pass this analysisId to create_strategy to build a strategy grounded in this research.",
        };
        return out;
      })
  );

  server.registerTool(
    "get_research",
    {
      title: "Get research report",
      description:
        "Fetch a saved research report by analysisId. Use this to re-read research created earlier (find ids with " +
        "list_research) before building or editing strategies based on it. " +
        "Parameters: analysisId (UUID, required; from create_research or list_research). " +
        "Returns title, symbol, overall score and view, and truncated narrative sections: executive summary, thesis, " +
        "risks, catalysts, and conclusion. Full layouts and raw data are never dumped.",
      inputSchema: GetResearchInput,
    },
    async ({ analysisId }) =>
      run(async () => {
        const detail = await pyonFetch<unknown>(`/api/analysis/${encodeURIComponent(analysisId)}`);
        const s = summarizeAnalysis(detail, analysisId);
        const out: ResearchReport = {
          analysisId: s.analysisId,
          title: s.title,
          symbol: s.symbol,
          name: s.name,
          overallScore: s.overallScore,
          overallView: s.overallView,
          executiveSummary: s.executiveSummary,
          thesis: truncate(getAny(s.narratives, "thesis"), 800),
          risks: truncate(getAny(s.narratives, "risks"), 800),
          catalysts: truncate(getAny(s.narratives, "catalysts"), 800),
          conclusion: truncate(getAny(s.narratives, "conclusion"), 800),
        };
        return out;
      })
  );

  server.registerTool(
    "list_research",
    {
      title: "List research reports",
      description:
        "List the user's saved research reports. Use this to find an analysisId for get_research or to check whether " +
        "relevant research already exists before generating a new report with create_research. " +
        "Parameters: none - the arguments object may be empty or omitted entirely. " +
        `Returns a compact list of up to ${MAX_REPORTS} reports with analysisId, title, symbol, and timestamps where available.`,
      inputSchema: ListResearchInput,
    },
    async () =>
      run(async () => {
        const res = await pyonFetch<unknown>("/api/analysis/list");
        const items = Array.isArray(res) ? res : getArray(res, "items", "analyses", "results");

        const reports: AnalysisListItem[] = items.slice(0, MAX_REPORTS).map((item) => ({
          analysisId: getString(item, "analysisId", "id"),
          title: getString(item, "title"),
          symbol:
            getString(getObject(item, "entity"), "symbol") ?? getString(item, "entitySymbol", "symbol"),
          createdAt: getString(item, "createdAt"),
          updatedAt: getString(item, "updatedAt"),
        }));

        const out: AnalysisListResult = { count: items.length, reports };
        if (items.length > MAX_REPORTS) {
          out.note = `Showing first ${MAX_REPORTS} of ${items.length} reports.`;
        }
        return out;
      })
  );
}
