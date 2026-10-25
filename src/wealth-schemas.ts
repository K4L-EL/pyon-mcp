/**
 * Input schemas for the Pyon Wealth client review tools. Every rule mirrors the
 * API's own validation, so an agent learns what is wrong before a request is sent.
 */

import { z } from "zod";
import { ISO_DATE_RE, NonEmptyString, parseIsoDateUtc } from "./schemas.js";

// The shared layout contract in the Pyon repository declares these limits; the API refuses longer text either way.
export const REVIEW_CONTENT_LIMITS = { portfolioName: 48, adviserName: 80, objective: 1200, commentary: 2400, importantInformation: 2400 } as const;
export const MAX_PREVIEW_PAGES = 12;

function wealthId(field: string, listTool: string) {
  return z
    .string({ required_error: `${field} is required. Call ${listTool} to find it.`, invalid_type_error: `${field} must be a string UUID.` })
    .trim()
    .uuid({ message: `${field} must be a UUID like '3f0c1e7a-2b44-4d19-9f5e-8a1c2d3e4f50'. Names are not accepted; call ${listTool} to look it up.` });
}

function reviewDate(field: string) {
  return z
    .string({ required_error: `${field} is required as YYYY-MM-DD.`, invalid_type_error: `${field} must be a YYYY-MM-DD string.` })
    .trim()
    .regex(ISO_DATE_RE, { message: `${field} must be a YYYY-MM-DD date with zero padding, e.g. '2026-06-30'.` })
    .refine((value) => parseIsoDateUtc(value) !== undefined, { message: `${field} must be a real calendar date.` });
}

const ClientId = wealthId("clientId", "list_wealth_clients");
const SourceId = wealthId("sourceId", "list_performance_sources");

export const ListWealthClientsInput = z
  .object({
    search: NonEmptyString("search", { max: 100, allowed: "Give part of a client's name." })
      .optional()
      .describe("Part of a client's name to filter by. Omit to list every current client."),
    includeArchived: z.boolean().optional().describe("Include archived clients. Default false."),
  })
  .strict();

export const ListPerformanceSourcesInput = z.object({ clientId: ClientId.describe("The client's id, from list_wealth_clients.") }).strict();

const PeriodObject = {
  clientId: ClientId.describe("The client's id, from list_wealth_clients."),
  sourceId: SourceId.describe("The performance history source's id, from list_performance_sources."),
  start: reviewDate("start").describe("First day of the review period, YYYY-MM-DD, on or after the source's firstDate."),
  end: reviewDate("end").describe("Last day of the review period, YYYY-MM-DD, after start and on or before the source's lastDate."),
};
const endAfterStart = (value: { start: string; end: string }) => value.end > value.start;
const endAfterStartMessage = { message: "end must be after start.", path: ["end"] };

export const GetPerformanceObject = z.object(PeriodObject).strict();
export const GetPerformanceInput = GetPerformanceObject.refine(endAfterStart, endAfterStartMessage);

const limited = (field: keyof typeof REVIEW_CONTENT_LIMITS, allowed: string) =>
  NonEmptyString(field, { max: REVIEW_CONTENT_LIMITS[field], allowed });

export const PreviewReviewReportObject = z
  .object({
    ...PeriodObject,
    portfolioName: limited("portfolioName", "Give the portfolio's name as the client knows it.").describe(
      `Portfolio name printed in the report, at most ${REVIEW_CONTENT_LIMITS.portfolioName} characters.`),
    adviserName: limited("adviserName", "Give the adviser's name as it should appear.").describe(
      `Adviser name printed in the report, at most ${REVIEW_CONTENT_LIMITS.adviserName} characters.`),
    objective: limited("objective", "Describe the portfolio's agreed objective.").describe(
      `The portfolio objective, at most ${REVIEW_CONTENT_LIMITS.objective} characters.`),
    commentary: limited("commentary", "Write the adviser's commentary on the period.").describe(
      `The adviser's commentary on the review period, at most ${REVIEW_CONTENT_LIMITS.commentary} characters. The adviser must approve it.`),
    importantInformation: limited("importantInformation", "Use the firm's approved important information wording.").describe(
      `The firm's approved important information, at most ${REVIEW_CONTENT_LIMITS.importantInformation} characters.`),
    maxPages: z.number().int().min(0).max(MAX_PREVIEW_PAGES).optional().describe(
      `How many rendered pages to return as images for the adviser to review, 0 to ${MAX_PREVIEW_PAGES}. Default ${MAX_PREVIEW_PAGES}.`),
  })
  .strict();
export const PreviewReviewReportInput = PreviewReviewReportObject.refine(endAfterStart, endAfterStartMessage);

export const IssueReviewReportInput = z
  .object({
    clientId: ClientId.describe("The client's id, from list_wealth_clients."),
    reportId: wealthId("reportId", "preview_review_report").describe("The preview's reportId, from preview_review_report."),
    adviserReviewedEveryPage: z
      .literal(true, { errorMap: () => ({ message: "adviserReviewedEveryPage must be exactly true, and only after the adviser has reviewed every preview page and approved the report." }) })
      .describe("Must be exactly true, confirming the adviser reviewed every preview page, its figures, commentary and branding, and approved issuing it."),
  })
  .strict();

export const ListReviewReportsInput = z.object({ clientId: ClientId.describe("The client's id, from list_wealth_clients.") }).strict();
export const ListLayoutExamplesInput = z.object({}).strict();

// The API's own limits for a brand build; it refuses anything else either way.
export const BRAND_BUILD_WEBSITE_MAX = 2048;
const OrganisationId = wealthId("organisationId", "list_organisations");
const OrganisationField = OrganisationId.describe("The organisation's id, from list_organisations. Brand builds need an admin of it.");

export const ListOrganisationsInput = z.object({}).strict();
export const StartBrandBuildInput = z
  .object({
    organisationId: OrganisationField,
    website: NonEmptyString("website", { max: BRAND_BUILD_WEBSITE_MAX, allowed: "Give the firm's public website address, such as https://www.example.co.uk." })
      .describe(`The firm's public website address, such as https://www.example.co.uk, at most ${BRAND_BUILD_WEBSITE_MAX} characters. Private and internal addresses are refused.`),
    rightsConfirmed: z
      .literal(true, { errorMap: () => ({ message: "rightsConfirmed must be exactly true, and only when the firm owns the website's name, logo and colours or may use them in its client reports." }) })
      .describe("Must be exactly true, confirming the firm owns the website's name, logo and colours or may use them in its client reports."),
  })
  .strict();
export const ListBrandBuildsInput = z.object({ organisationId: OrganisationField }).strict();
export const GetBrandBuildInput = z
  .object({
    organisationId: OrganisationField,
    buildId: wealthId("buildId", "list_brand_builds").describe("The build's id, from start_brand_build or list_brand_builds."),
    maxPages: z.number().int().min(0).max(MAX_PREVIEW_PAGES).optional().describe(
      `How many proposed pages of a finished build to return as images, 0 to ${MAX_PREVIEW_PAGES}. Default ${MAX_PREVIEW_PAGES}.`),
  })
  .strict();

export const WEALTH_TOOL_INPUT_SCHEMAS = {
  list_wealth_clients: ListWealthClientsInput,
  list_performance_sources: ListPerformanceSourcesInput,
  get_performance: GetPerformanceInput,
  preview_review_report: PreviewReviewReportInput,
  issue_review_report: IssueReviewReportInput,
  list_review_reports: ListReviewReportsInput,
  list_layout_examples: ListLayoutExamplesInput,
  list_organisations: ListOrganisationsInput,
  start_brand_build: StartBrandBuildInput,
  list_brand_builds: ListBrandBuildsInput,
  get_brand_build: GetBrandBuildInput,
} as const;
