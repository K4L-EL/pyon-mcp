// Behaviour test for the Pyon Wealth tools, run offline against a local fake of the Pyon API.
// It proves each tool sends the request the API expects, returns what an adviser needs, and refuses what it must.
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const CLIENT = "3f0c1e7a-2b44-4d19-9f5e-8a1c2d3e4f50";
const SOURCE = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const REPORT = "11111111-2222-4333-8444-555555555555";
const MISSING_CLIENT = "00000000-0000-4000-8000-000000000000";
const ORG = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const BUILD = "8f14e45f-ceea-467a-9a36-b1a2c3d4e5f6";
const RUNNING = "a87ff679-a2f3-471d-8d1a-1b2c3d4e5f60";
const MISSING_BUILD = "e4da3b7f-bbce-4234-9d10-2a3b4c5d6e7f";
const BUILDS = `/api/wealth/organisations/${ORG}/branding/builds`;
const requests = [];
let issueStatus = 200;
let buildBusy = false;
const finishedBuild = { id: BUILD, website: "https://www.example.com/", status: "Succeeded", createdAt: "2026-09-17T16:00:00Z", example: "fernmoor",
  steps: ["Reading https://www.example.com/", "Finished with render-1"], pageCount: 2, failure: null,
  result: { summary: "Brackenholt's navy on the Fernmoor layout.", decisions: [{ topic: "Primary colour", choice: "#16324f", evidence: "The site's theme colour." }],
    warnings: ["No typeface could be embedded."], theme: { name: "Brackenholt Wealth", colours: { primary: "#16324f" }, logoId: "logo-1" } } };

const routes = {
  "GET /api/wealth/clients": () => [{ id: CLIENT, fullName: "Alex Example", isSimulated: true, isArchived: false }],
  [`GET /api/wealth/clients/${CLIENT}/performance-history`]: () => [{ id: SOURCE, name: "Platform history", currency: "GBP",
    benchmark: "Illustrative balanced benchmark", firstDate: "2021-06-30", lastDate: "2026-06-30" }],
  [`GET /api/wealth/clients/${CLIENT}/performance-history/${SOURCE}/performance`]: () => ({ currency: "GBP", isSimulated: true,
    returnPct: { value: "4.43" }, benchmarkPct: { value: null, missing: "NotSupplied" },
    points: [{ valuation: { value: "741747.48" } }, { valuation: { value: "774639.94" } }] }),
  [`POST /api/wealth/clients/${CLIENT}/review-reports/preview`]: () => ({
    artifact: { id: REPORT, brandName: "Fernmoor Private Wealth", createdAt: "2026-09-17T10:00:00Z" }, pages: ["cGFnZTE=", "cGFnZTI="] }),
  [`POST /api/wealth/clients/${CLIENT}/review-reports/${REPORT}/issue`]: () => issueStatus === 200
    ? { id: REPORT, issuedAt: "2026-09-17T10:05:00Z", issuedThrough: "AccessToken" }
    : [issueStatus, { message: "This access token cannot issue client reports. Create a token that is allowed to issue them under Agent access." }],
  [`GET /api/wealth/clients/${CLIENT}/review-reports`]: () => [{ id: REPORT, brandName: "Fernmoor Private Wealth", issuedAt: "2026-09-17T10:05:00Z", issuedThrough: "AccessToken" }],
  [`GET /api/wealth/clients/${MISSING_CLIENT}/review-reports`]: () => [404, { message: "Client not found." }],
  "GET /api/wealth/layout-examples": () => [{ key: "fernmoor", title: "Fernmoor Private Wealth", summary: "Portrait.", orientation: "Portrait",
    highlights: ["Figure tiles"], definition: { name: "Fernmoor Private Wealth", pages: [] } }],
  "GET /api/wealth/organisations": () => [{ id: ORG, name: "Brackenholt Wealth", role: "Admin", status: "Active", canManageBranding: true, canManageMembers: true }],
  [`POST ${BUILDS}`]: () => buildBusy
    ? [409, { message: "A brand build is already running for this organisation. Wait for it to finish." }]
    : [202, { id: RUNNING, website: "https://www.example.com/", status: "Queued", createdAt: "2026-09-17T16:05:00Z", steps: [], example: null, result: null, pageCount: 0, failure: null }],
  [`GET ${BUILDS}`]: () => [finishedBuild],
  [`GET ${BUILDS}/${BUILD}`]: () => finishedBuild,
  [`GET ${BUILDS}/${BUILD}/pages`]: () => ({ pages: ["cGFnZTE=", "cGFnZTI="] }),
  [`GET ${BUILDS}/${RUNNING}`]: () => ({ id: RUNNING, website: "https://www.example.com/", status: "Running", steps: ["Reading https://www.example.com/"], pageCount: 0, result: null, failure: null }),
  [`GET ${BUILDS}/${MISSING_BUILD}`]: () => [404, { message: "That brand build does not exist for this organisation." }],
};

const api = createHttpServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : undefined, auth: req.headers.authorization });
    const handler = routes[`${req.method} ${url.pathname}`];
    const result = handler ? handler() : [404, { message: "Not found." }];
    const [status, payload] = Array.isArray(result) && typeof result[0] === "number" ? result : [200, result];
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
  });
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
process.env.PYON_API_KEY = "pyk_wealth-smoke";
process.env.PYON_API_URL = `http://127.0.0.1:${api.address().port}`;

const { createServer } = await import("../dist/server.js");
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "pyon-mcp-wealth-smoke", version: "0.0.0" });
await Promise.all([createServer().connect(serverTransport), client.connect(clientTransport)]);

let passed = 0; const failures = [];
function assert(condition, label, detail) {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`); }
}
const call = (name, args) => client.callTool({ name, arguments: args });
const json = (result) => JSON.parse(result.content[0].text);
const last = () => requests[requests.length - 1];
const period = { clientId: CLIENT, sourceId: SOURCE, start: "2026-03-31", end: "2026-06-30" };
const content = { portfolioName: "Balanced Growth", adviserName: "Sam Example", objective: "Grow steadily.", commentary: "Markets were steadier.", importantInformation: "Simulated data." };

const clients = json(await call("list_wealth_clients", { search: "Alex" }));
assert(last().query.search === "Alex" && last().auth === "Bearer pyk_wealth-smoke", "list_wealth_clients sends the search with the token");
assert(clients.clients[0].clientId === CLIENT && clients.clients[0].simulated === true, "list_wealth_clients maps ids and simulated status");

const sources = json(await call("list_performance_sources", { clientId: CLIENT }));
assert(sources.sources[0].sourceId === SOURCE && sources.sources[0].lastDate === "2026-06-30", "list_performance_sources maps each source and its dates");

const performance = json(await call("get_performance", period));
assert(last().query.start === "2026-03-31" && last().query.end === "2026-06-30", "get_performance sends the period");
assert(performance.returnPct.value === "4.43" && performance.closingValue.value === "774639.94", "get_performance returns the return and closing value");
assert(performance.benchmarkPct.value === null && performance.benchmarkPct.missing === "NotSupplied", "a missing benchmark keeps its reason instead of becoming zero");
const backwards = await call("get_performance", { ...period, start: "2026-06-30", end: "2026-03-31" });
assert(backwards.isError === true && /end must be after start/.test(backwards.content[0].text), "a period that ends before it starts is refused before any request");

const before = requests.length;
const tooLong = await call("preview_review_report", { ...period, ...content, commentary: "x".repeat(2401) });
assert(tooLong.isError === true && requests.length === before, "commentary over 2400 characters is refused without calling the API");
const preview = await call("preview_review_report", { ...period, ...content });
const previewBody = last().body;
assert(previewBody.streamId === SOURCE && previewBody.commentary === content.commentary && !("sourceId" in previewBody), "preview_review_report maps sourceId to the API's streamId");
const images = preview.content.filter((item) => item.type === "image");
assert(images.length === 2 && images[0].mimeType === "image/png" && images[0].data === "cGFnZTE=", "preview_review_report returns every page as a PNG image");
const summary = json(preview);
assert(summary.reportId === REPORT && summary.approvalExpiresAt === "2026-09-17T10:30:00.000Z", "the preview names its report and when approval expires");
const partial = await call("preview_review_report", { ...period, ...content, maxPages: 1 });
assert(partial.content.filter((item) => item.type === "image").length === 1 && /Only 1 of 2 pages/.test(json(partial).nextStep), "a partial preview says the adviser must still review every page");

const unconfirmed = await call("issue_review_report", { clientId: CLIENT, reportId: REPORT, adviserReviewedEveryPage: false });
assert(unconfirmed.isError === true && /exactly true/.test(unconfirmed.content[0].text), "issuing without the adviser's review confirmation is refused");
const issued = json(await call("issue_review_report", { clientId: CLIENT, reportId: REPORT, adviserReviewedEveryPage: true }));
assert(last().body.reviewed === true && issued.issuedThrough === "AccessToken", "issue_review_report confirms review to the API and reports the agent channel");
issueStatus = 403;
const refused = await call("issue_review_report", { clientId: CLIENT, reportId: REPORT, adviserReviewedEveryPage: true });
assert(refused.isError === true && /cannot issue client reports/.test(refused.content[0].text), "a token without the issue permission gets Pyon's explanation");

const reports = json(await call("list_review_reports", { clientId: CLIENT }));
assert(reports.reports[0].issuedThrough === "AccessToken", "list_review_reports shows how each report was issued");
const missing = await call("list_review_reports", { clientId: MISSING_CLIENT });
assert(missing.isError === true && /list_wealth_clients/.test(missing.content[0].text), "an unknown client points the agent to list_wealth_clients");
const examples = json(await call("list_layout_examples", {}));
assert(examples.examples[0].key === "fernmoor" && !("definition" in examples.examples[0]), "list_layout_examples lists examples without their full definitions");

const organisations = json(await call("list_organisations", {}));
assert(organisations.organisations[0].organisationId === ORG && organisations.organisations[0].canManageBranding === true, "list_organisations maps ids and branding permission");
const started = json(await call("start_brand_build", { organisationId: ORG, website: "https://www.example.com/", rightsConfirmed: true }));
assert(last().method === "POST" && last().body.website === "https://www.example.com/" && last().body.rightsConfirmed === true, "start_brand_build sends the website and the rights confirmation");
assert(started.buildId === RUNNING && started.status === "Queued" && /get_brand_build/.test(started.nextStep), "start_brand_build returns the build and how to follow it");
buildBusy = true;
const busy = await call("start_brand_build", { organisationId: ORG, website: "https://www.example.com/", rightsConfirmed: true });
assert(busy.isError === true && /already running/.test(busy.content[0].text), "a second build while one runs gets Pyon's explanation");
const listed = json(await call("list_brand_builds", { organisationId: ORG }));
assert(listed.builds[0].buildId === BUILD && listed.builds[0].example === "fernmoor", "list_brand_builds maps each build");
const beforeRunning = requests.length;
const running = await call("get_brand_build", { organisationId: ORG, buildId: RUNNING });
assert(running.content.every((item) => item.type === "text") && requests.length === beforeRunning + 1 && json(running).steps.length === 1,
  "a running build returns its steps without asking for pages");
const finished = await call("get_brand_build", { organisationId: ORG, buildId: BUILD });
const finishedSummary = json(finished);
assert(finished.content.filter((item) => item.type === "image").length === 2 && finishedSummary.pagesShown === 2, "a finished build returns every proposed page as an image");
assert(finishedSummary.decisions[0].evidence === "The site's theme colour." && finishedSummary.colours.primary === "#16324f" && /layout editor/.test(finishedSummary.nextStep),
  "a finished build returns its decisions, colours and how an admin uses it");
const onePage = await call("get_brand_build", { organisationId: ORG, buildId: BUILD, maxPages: 1 });
assert(onePage.content.filter((item) => item.type === "image").length === 1, "maxPages limits the proposed pages returned");
const beforeNoPages = requests.length;
await call("get_brand_build", { organisationId: ORG, buildId: BUILD, maxPages: 0 });
assert(requests.length === beforeNoPages + 1, "maxPages 0 does not fetch the pages");
const missingBuild = await call("get_brand_build", { organisationId: ORG, buildId: MISSING_BUILD });
assert(missingBuild.isError === true && /list_brand_builds/.test(missingBuild.content[0].text), "an unknown build points the agent to list_brand_builds");

api.close();
console.log(`\nWEALTH SMOKE SUMMARY: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log("WEALTH SMOKE FAILED"); process.exit(1); }
console.log("WEALTH SMOKE OK");
process.exit(0);
