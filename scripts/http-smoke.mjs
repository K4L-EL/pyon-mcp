// Smoke test for the hosted (Streamable HTTP) server, offline and keyless.
// A fake Pyon plays the authorization server and the API; the SDK's own client drives the MCP endpoint.
import http from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let passed = 0;
const failures = [];
function assert(condition, label, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(`${label}${detail ? ` - ${detail}` : ""}`);
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

/* ------------------------------------------------------------------ */
/* The fake Pyon: authorization server and API on one port            */
/* ------------------------------------------------------------------ */

const CLIENT_ID = "pyon-mcp";
const CLIENT_SECRET = "resource-server-secret";
const users = { "app-token-alice": "alice", "app-token-bob": "bob" };
const rejectedApiTokens = new Set();
const exchanges = [];
const apiCalls = [];

const pyon = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let body = "";
  for await (const chunk of req) body += chunk;
  const json = (status, value) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return json(200, {
      issuer: pyonUrl,
      authorization_endpoint: `${pyonUrl}/oauth/authorize`,
      token_endpoint: `${pyonUrl}/oauth/token`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:token-exchange"],
      scopes_supported: ["agent", "reports:issue"],
    });
  }
  if (url.pathname === "/oauth/token") {
    const form = new URLSearchParams(body);
    const basic = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
    exchanges.push({ subject: form.get("subject_token"), resource: form.get("resource"), basic });
    if (basic !== `${CLIENT_ID}:${CLIENT_SECRET}`) return json(401, { error: "invalid_client" });
    const user = users[form.get("subject_token")];
    if (!user) return json(400, { error: "invalid_request", error_description: "not a valid subject token" });
    return json(200, { access_token: `api-token-${user}`, issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "Bearer", expires_in: 3600, scope: "agent" });
  }
  if (url.pathname.startsWith("/api/")) {
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    apiCalls.push({ path: url.pathname, bearer });
    if (url.pathname === "/api/capabilities") return json(404, {});
    if (rejectedApiTokens.has(bearer)) return json(401, { error: "Invalid or revoked token" });
    if (url.pathname === "/api/market/search") {
      await new Promise((r) => setTimeout(r, Number(url.searchParams.get("q")?.length ?? 1) * 20));
      return json(200, [{ symbol: url.searchParams.get("q"), name: `seen by ${bearer}`, exchange: "NASDAQ", assetClass: "stock" }]);
    }
    return json(200, []);
  }
  json(404, { error: "not found" });
});
const pyonPort = await listen(pyon);
const pyonUrl = `http://127.0.0.1:${pyonPort}`;
process.env.PYON_API_URL = pyonUrl;

/* ------------------------------------------------------------------ */
/* The hosted server under test                                       */
/* ------------------------------------------------------------------ */

const { readHostedConfig, HostedConfigError } = await import("../dist/http/config.js");
const { loadAuthorizationServer, MetadataError } = await import("../dist/http/start.js");
const { createHostedApp } = await import("../dist/http/app.js");
const { TokenExchangeVerifier } = await import("../dist/http/token-exchange.js");
const { useRequestCredentials } = await import("../dist/client.js");

const mcp = http.createServer();
const mcpPort = await listen(mcp);
const publicUrl = `http://127.0.0.1:${mcpPort}/mcp`;
const config = readHostedConfig({
  PYON_MCP_PUBLIC_URL: publicUrl, PYON_API_URL: pyonUrl, PYON_MCP_CLIENT_ID: CLIENT_ID, PYON_MCP_CLIENT_SECRET: CLIENT_SECRET,
});
useRequestCredentials();
const authorizationServer = await loadAuthorizationServer(config);
const verifier = new TokenExchangeVerifier(config, authorizationServer.token_endpoint);
mcp.on("request", createHostedApp({ config, authorizationServer, verifier }));

async function post(headers, body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) {
  return fetch(publicUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

console.log("\n[1] discovery documents");
{
  const prmUrl = `http://127.0.0.1:${mcpPort}/.well-known/oauth-protected-resource/mcp`;
  const prm = await (await fetch(prmUrl)).json();
  assert(prm.resource === publicUrl, "the resource is the MCP URL exactly as users add it", prm.resource);
  assert(JSON.stringify(prm.authorization_servers) === JSON.stringify([pyonUrl]), "the authorization server is Pyon's issuer");
  assert(JSON.stringify(prm.scopes_supported) === '["agent"]', "only the base scope is advertised", JSON.stringify(prm.scopes_supported));
  const root = await (await fetch(`http://127.0.0.1:${mcpPort}/.well-known/oauth-protected-resource`)).json();
  assert(JSON.stringify(root) === JSON.stringify(prm), "the root copy of the document is identical");
}

console.log("\n[2] the 401 that starts sign-in");
{
  const res = await post({});
  const challenge = res.headers.get("www-authenticate") ?? "";
  assert(res.status === 401, "a request without a token is answered 401", String(res.status));
  assert(challenge.includes(`resource_metadata="http://127.0.0.1:${mcpPort}/.well-known/oauth-protected-resource/mcp"`),
    "the challenge points at the protected resource document", challenge);
  assert(challenge.includes('scope="agent"'), "the challenge asks for only the base scope", challenge);
  const bad = await post({ Authorization: "Bearer app-token-unknown" });
  assert(bad.status === 401 && (bad.headers.get("www-authenticate") ?? "").includes('error="invalid_token"'),
    "a token Pyon will not exchange is answered 401 invalid_token", String(bad.status));
  const get = await fetch(publicUrl);
  assert(get.status === 401, "a GET without a token is also answered 401, so discovery works from any first request");
  const authedGet = await fetch(publicUrl, { headers: { Authorization: "Bearer app-token-alice" } });
  assert(authedGet.status === 405 && authedGet.headers.get("allow") === "POST", "the stateless endpoint answers GET with 405");
  const del = await fetch(publicUrl, { method: "DELETE", headers: { Authorization: "Bearer app-token-alice" } });
  assert(del.status === 405, "and DELETE with 405, since there is no session to end");
}

console.log("\n[3] host and origin checks");
{
  const evilHost = await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: mcpPort, path: "/mcp", method: "POST",
      headers: { Host: "evil.example", "Content-Type": "application/json" } }, (res) => resolve(res.statusCode));
    req.end("{}");
  });
  assert(evilHost === 403, "a Host header that is not this server's is refused (DNS rebinding)", String(evilHost));
  const evilOrigin = await post({ Authorization: "Bearer app-token-alice", Origin: "https://evil.example" });
  assert(evilOrigin.status === 403, "an Origin that is not allowed is refused", String(evilOrigin.status));
  const claudeOrigin = await post({ Authorization: "Bearer app-token-alice", Origin: "https://claude.ai" });
  assert(claudeOrigin.status === 200, "Claude's origin is allowed", String(claudeOrigin.status));
}

console.log("\n[4] tools as the signed-in user");
async function connect(token) {
  const client = new Client({ name: "http-smoke", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(publicUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}
{
  const alice = await connect("app-token-alice");
  const bob = await connect("app-token-bob");
  const tools = await alice.listTools();
  assert(tools.tools.length === 13, "tools/list returns the 13 Pyon tools", String(tools.tools.length));

  // Different query lengths finish in a different order, so a leaked credential would show.
  const [a, b] = await Promise.all([
    alice.callTool({ name: "search_symbols", arguments: { query: "AAPLAAPLAAPL" } }),
    bob.callTool({ name: "search_symbols", arguments: { query: "MSFT" } }),
  ]);
  assert(!a.isError && a.content[0].text.includes("seen by api-token-alice"), "alice's call reaches the API as alice", a.content[0]?.text);
  assert(!b.isError && b.content[0].text.includes("seen by api-token-bob"), "bob's concurrent call reaches the API as bob", b.content[0]?.text);
  const catalog = await alice.callTool({ name: "get_capabilities", arguments: { section: "operators" } });
  assert(!catalog.isError, "get_capabilities answers from the bundled catalog when the live one is missing", catalog.content[0]?.text?.slice(0, 120));
  const tokensSent = new Set(apiCalls.map((c) => c.bearer).filter((t) => t.length > 0));
  assert(![...tokensSent].some((t) => t.startsWith("app-token")), "no app token is ever sent to the API", [...tokensSent].join(","));
  const catalogCalls = apiCalls.filter((c) => c.path === "/api/capabilities");
  assert(catalogCalls.length > 0 && catalogCalls.every((c) => c.bearer === ""),
    "the shared capability catalog is fetched without any user's token", JSON.stringify(catalogCalls));
  const aliceExchanges = exchanges.filter((e) => e.subject === "app-token-alice").length;
  assert(aliceExchanges === 1, "one exchange serves many requests until the token nears expiry", String(aliceExchanges));
  assert(exchanges.every((e) => e.resource === pyonUrl), "every exchange asks for the Pyon API as the resource");

  rejectedApiTokens.add("api-token-alice");
  delete users["app-token-alice"];
  const revoked = await alice.callTool({ name: "search_symbols", arguments: { query: "AAPL" } });
  assert(revoked.isError && revoked.content[0].text.includes("Reconnect Pyon"), "a disconnected user's call says to reconnect",
    revoked.content[0]?.text);
  const next = await post({ Authorization: "Bearer app-token-alice" });
  assert(next.status === 401, "after the API refuses a user, their next request is answered 401 to start sign-in", String(next.status));
  await alice.close();
  await bob.close();
}

console.log("\n[5] configuration and authorization server checks");
{
  let error;
  try {
    readHostedConfig({});
  } catch (e) {
    error = e;
  }
  assert(error instanceof HostedConfigError && error.message.includes("PYON_MCP_PUBLIC_URL") && error.message.includes("PYON_MCP_CLIENT_SECRET"),
    "a missing public URL or credential stops startup with what to set", error?.message);
  try {
    readHostedConfig({ PYON_MCP_PUBLIC_URL: "http://mcp.example.com/mcp", PYON_MCP_CLIENT_ID: "a", PYON_MCP_CLIENT_SECRET: "b" });
    error = undefined;
  } catch (e) {
    error = e;
  }
  assert(error instanceof HostedConfigError, "a public URL over plain http is refused outside localhost");
  const noExchange = async () => new Response(JSON.stringify({ issuer: config.issuer, code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code"], scopes_supported: ["agent"] }), { status: 200 });
  try {
    await loadAuthorizationServer(config, noExchange);
    error = undefined;
  } catch (e) {
    error = e;
  }
  assert(error instanceof MetadataError && error.message.includes("token exchange"),
    "an authorization server without token exchange is refused at startup", error?.message);
}

console.log("\n[6] stdio is still the default");
{
  const child = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"],
    env: { PATH: process.env.PATH ?? "", PYON_API_URL: "http://127.0.0.1:1" }, stderr: "pipe" });
  const client = new Client({ name: "stdio-smoke", version: "1.0.0" });
  await client.connect(child);
  const tools = await client.listTools();
  assert(tools.tools.length === 13, "node dist/index.js with no flag serves the same 13 tools on stdio", String(tools.tools.length));
  await client.close();
}

mcp.close();
pyon.close();
mcp.closeAllConnections();
pyon.closeAllConnections();

console.log(`\n${"-".repeat(60)}`);
console.log(`HTTP SMOKE SUMMARY: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
