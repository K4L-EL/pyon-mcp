// Local container probe uses the configured public Host so the MCP DNS-rebinding guard remains enabled.
try {
  const host = new URL(process.env.PYON_MCP_PUBLIC_URL).host;
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || "3000"}/healthz`, {
    headers: { Host: host }, signal: AbortSignal.timeout(4000),
  });
  const body = await response.json();
  process.exit(response.ok && body.status === "ok" && body.product === (process.env.PYON_MCP_PRODUCT || "quant") ? 0 : 1);
} catch {
  process.exit(1);
}
