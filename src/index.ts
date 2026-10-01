#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// The hosted connector serves Streamable HTTP with Pyon sign-in; without the flag this is the stdio server it always was.
const hosted = process.argv.includes("--http") || process.env.PYON_MCP_TRANSPORT === "http";

async function main(): Promise<void> {
  if (hosted) {
    const { startHostedServer } = await import("./http/start.js");
    await startHostedServer();
    return;
  }

  if (!process.env.PYON_API_KEY) {
    // Warn but keep serving so tools/list works; every tool call will return
    // a clear error explaining how to create and set the key.
    console.error(
      "pyon-mcp: warning - PYON_API_KEY is not set. Create a personal access token (pyk_...) in " +
        "Account > API Access at app.pyon.io and set PYON_API_KEY in this server's environment."
    );
  }

  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error("pyon-mcp: server running on stdio");
}

main().catch((err) => {
  console.error("pyon-mcp: fatal error", err);
  process.exit(1);
});
