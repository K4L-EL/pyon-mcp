# pyon-mcp

MCP (Model Context Protocol) server for the [Pyon](https://app.pyon.io) trading platform.
It lets AI agents - Claude Code, Claude Desktop, Codex, or any MCP client - drive Pyon end to end:
search markets, generate research, build and edit node-graph strategies with AI, run backtests,
diagnose problems, and optimize parameters with 2-D sweeps.

Runs over stdio, talks to `api.pyon.io`, and needs only Node 18+. It can also run as a hosted
connector over Streamable HTTP, where people add it by URL and sign in with their Pyon account instead
of pasting a key (see [Hosted connector](#hosted-connector)).

## Getting an API key

1. Sign in at [app.pyon.io](https://app.pyon.io).
2. Open **Account > API Access**.
3. Create a personal access token. It looks like `pyk_...`.

Set it as the `PYON_API_KEY` environment variable wherever the server runs.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PYON_API_KEY` | yes | - | Personal access token (`pyk_...`) |
| `PYON_API_URL` | no | `https://api.pyon.io` | API base URL override |

## Setup

### Claude Code

```bash
claude mcp add pyon -e PYON_API_KEY=pyk_... -- npx -y pyon-mcp
```

Or, from a local checkout:

```bash
npm install && npm run build
claude mcp add pyon -e PYON_API_KEY=pyk_... -- node /path/to/pyon-mcp/dist/index.js
```

### Claude Desktop

Add to `claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "pyon": {
      "command": "npx",
      "args": ["-y", "pyon-mcp"],
      "env": {
        "PYON_API_KEY": "pyk_..."
      }
    }
  }
}
```

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.pyon]
command = "npx"
args = ["-y", "pyon-mcp"]
env = { PYON_API_KEY = "pyk_..." }
```

## Hosted connector

`pyon-mcp --http` (or `PYON_MCP_TRANSPORT=http`) serves the same tools at a public URL such as
`https://mcp.pyon.io/mcp`. In claude.ai and Claude Desktop you add that URL as a custom connector, and in
Claude Code you run `claude mcp add --transport http pyon https://mcp.pyon.io/mcp`. Claude then opens a
Pyon page in the browser, you sign in and approve the connection, and the tools appear. No key is pasted
anywhere, and you can disconnect the app at any time under **Account > API Access**.

The server follows the MCP authorization specification. It answers an unauthenticated request with 401
and a `WWW-Authenticate` header pointing at its protected resource metadata
(`/.well-known/oauth-protected-resource/mcp`), which names Pyon's authorization server. That server
registers the app, asks the signed-in user to consent, and issues short-lived access tokens with
rotating refresh tokens. The MCP server never forwards those tokens to the Pyon API: it exchanges each
one (RFC 8693) for a separate API token, so a token held by an app is only good at this endpoint.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PYON_MCP_PUBLIC_URL` | yes | - | The MCP endpoint exactly as users add it, which is also the OAuth resource |
| `PYON_MCP_CLIENT_ID` | yes | - | This server's resource server id at Pyon's authorization server |
| `PYON_MCP_CLIENT_SECRET` | yes | - | Its secret; Pyon stores only the SHA-256 digest |
| `PYON_API_URL` | no | `https://api.pyon.io` | API base URL |
| `PYON_AUTH_ISSUER` | no | `PYON_API_URL` | Issuer of Pyon's authorization server |
| `PYON_API_RESOURCE` | no | `PYON_API_URL` | Resource the exchanged API tokens are issued for |
| `HOST` / `PORT` | no | `127.0.0.1` / `3000` | Listen address; use `0.0.0.0` in a container |
| `PYON_MCP_ALLOWED_HOSTS` | no | the public URL's host | Host headers accepted, as protection against DNS rebinding |
| `PYON_MCP_ALLOWED_ORIGINS` | no | `https://claude.ai,https://claude.com` | Browser origins accepted; requests with no Origin are always accepted |

The server is stateless, so any number of copies can run behind a load balancer, and `GET /healthz`
answers for health checks.

## Start here: `get_capabilities`

Pyon turns a strategy description into a node graph literally. An indicator name the engine does not
know, or a threshold outside an indicator's range, produces a strategy that backtests to zero trades
and looks broken for no visible reason - an `RSI > 120` entry can never fire, because RSI is bounded
0-100.

So call **`get_capabilities`** before writing any strategy description, edit instruction, or sweep
bound. It returns the real catalog: 61 market indicators with their value ranges and `indicatorParams`,
9 portfolio indicators, 8 operators, 8 trigger types, 13 action types, the 5 supported timeframes, the
3 `quantityType` modes, 7 option `strategyType` values, and the 47 tradable tickers.

The catalog is fetched from `GET /api/capabilities` and falls back to a copy bundled with this server
if that endpoint is unavailable. Every response names which source it used. The same catalog is
readable as markdown in the `pyon://capabilities` resource.

## Tools

Every input schema is **strict**: an unknown or misspelled parameter (`timeFrame`, `start_date`,
`limit`) is rejected with an explicit error rather than silently ignored. Every rejection message
states what IS allowed.

| Tool | Parameter | Type | Allowed values | Default |
| --- | --- | --- | --- | --- |
| `get_capabilities` | `section` | enum, optional | `indicators`, `portfolio_indicators`, `operators`, `triggers`, `actions`, `timeframes`, `tickers`, `all` | `all` |
| `search_symbols` | `query` | string, required | 1-100 chars; ticker or name fragment | - |
| `list_strategies` | - | - | no parameters | - |
| `get_strategy` | `strategyId` | string, required | UUID from `list_strategies` or `create_strategy` | - |
| `create_strategy` | `description` | string, required | at least 10 chars after trimming, max 8000 | - |
| | `analysisId` | string, optional | UUID from `create_research` or `list_research` | none |
| `edit_strategy` | `strategyId` | string, required | UUID | - |
| | `instruction` | string, required | at least 10 chars after trimming, max 8000 | - |
| `run_backtest` | `strategyId` | string, required | UUID | - |
| | `startDate` | string, optional | `YYYY-MM-DD`, real calendar date, not in the future | 365 days ago |
| | `endDate` | string, optional | `YYYY-MM-DD`, not in the future, after `startDate`, at least 7 days from it | today |
| | `timeframe` | enum, optional | `1m`, `5m`, `15m`, `1h`, `1d` (lowercase) | the strategy's native timeframe |
| | `initialCapital` | number, optional | 100 to 100000000 | `50000` |
| `diagnose_strategy` | `strategyId` | string, required | UUID | - |
| | `question` | string, optional | at least 10 chars when given, max 2000 | general health check |
| `optimize_strategy` | `strategyId` | string, required | UUID | - |
| | `xNodeId` | string, required | a node id from `get_strategy` | - |
| | `xField` | string, required | a numeric config key on that node | - |
| | `xMin` / `xMax` | number, required | finite; `xMax` strictly greater than `xMin` | - |
| | `yNodeId` | string, required | a node id from `get_strategy`; may equal `xNodeId` | - |
| | `yField` | string, required | a numeric config key; the two axes must not be the same node **and** field | - |
| | `yMin` / `yMax` | number, required | finite; `yMax` strictly greater than `yMin` | - |
| | `steps` | integer, optional | 3 to 10 (runs `steps` x `steps` backtests) | `5` |
| | `timeframe` | enum, optional | `1m`, `5m`, `15m`, `1h`, `1d` | server's choice |
| `create_research` | `prompt` | string, required | at least 10 chars after trimming, max 8000 | - |
| `get_research` | `analysisId` | string, required | UUID from `create_research` or `list_research` | - |
| `list_research` | - | - | no parameters | - |
| `get_job_status` | `jobId` | string, required | non-empty; a job id or a backtest id from a timeout message | - |

### What each tool does

| Tool | Summary | Wait |
| --- | --- | --- |
| `get_capabilities` | The indicator / operator / action / ticker catalog, with API fetch and bundled fallback | none |
| `search_symbols` | Resolve tickers and names against Pyon's market database | none |
| `list_strategies` | Saved strategies with id, name, nodeCount, updatedAt | none |
| `get_strategy` | Per-node id, type, label, and flattened config (feeds `optimize_strategy`) | none |
| `create_strategy` | AI-build a new strategy, optionally grounded in research | up to 300s |
| `edit_strategy` | AI-edit a strategy; returns a before/after verification verdict | up to 300s |
| `run_backtest` | Metrics plus verbatim diagnostics; flags 0-trade causes and short daily windows | up to 180s |
| `diagnose_strategy` | AI debugger with sample-backtest evidence; message, issues, suggested fix | up to 300s |
| `optimize_strategy` | 2-D parameter sweep; best cell, current cell, sharpe grid | up to 600s |
| `create_research` | Generate a saved research report; returns analysisId plus executive summary | up to 300s |
| `get_research` | Fetch a saved report: score, view, truncated narratives | none |
| `list_research` | List saved research reports | none |
| `get_job_status` | Escape hatch when a wait timed out; also accepts backtest ids | none |

## Validation rules worth knowing

- **Ids are UUIDs.** A strategy name will be rejected; the message points at `list_strategies`.
- **Dates are `YYYY-MM-DD`** real calendar dates, never in the future. `2025-02-30`, `2024-1-5`,
  `01/02/2024` and full timestamps are all rejected.
- **Backtest windows** need `endDate` after `startDate` and at least 7 days between them. A 1d
  strategy tested over fewer than 300 days still runs, but the result carries a `warning` explaining
  that the window, not the strategy, may be what the metrics are measuring.
- **Timeframes** are exactly `1m`, `5m`, `15m`, `1h`, `1d`. `1D`, `daily`, `1w` and `30m` are rejected -
  these are the five bar sizes the engine resolves.
- **Sweep axes** must describe a real range (`xMax > xMin`, `yMax > yMin`) and must not point at the
  same node id **and** config field, which would test one dimension twice.
- **Prompts** for `create_strategy`, `edit_strategy`, `create_research` and the optional
  `diagnose_strategy` question need at least 10 characters, because a vague prompt produces a vague
  strategy.

## Resources

| URI | Contents |
| --- | --- |
| `pyon://getting-started` | Auth setup, the typical agent workflow, enforced input rules, plan limits |
| `pyon://capabilities` | The full capability catalog as readable markdown |

## Errors you may see

- **401** - invalid or revoked API key. Create a new one in Account > API Access at app.pyon.io.
- **402** - a plan limit was hit; the message explains which. Upgrade at
  app.pyon.io/app/account/billing.
- **Timeouts** - long AI jobs keep running server-side; the timeout message includes the job id
  to check with `get_job_status`.
- **Invalid arguments** - the message names the parameter and the allowed values. Fix and retry;
  these never reach the API.

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm run smoke   # offline, keyless: tools/list, JSON Schema completeness, and the validation tables
npm run smoke:http  # offline: the hosted server against a fake Pyon authorization server and API
npm run check   # build + smoke + smoke:http, the gate CI runs on Node 20 and 22
```

The compiler runs at the strictest settings the code satisfies: `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`, `noImplicitOverride`,
`noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`,
`allowUnreachableCode: false` and `allowUnusedLabels: false`. `noPropertyAccessFromIndexSignature` is
deliberately left off: it only forces `process.env["PYON_API_KEY"]` bracket syntax and catches nothing
here. Wire payloads are read through the case-insensitive helpers in `src/format.ts`, which return
`unknown`, so every tool has to narrow a value before putting it in one of the interfaces in
`src/types.ts` - a backend field rename surfaces as a compile error rather than a missing JSON key.

`scripts/smoke.mjs` runs entirely offline. It asserts the 13 tools and 2 resources are registered,
that every published JSON Schema names its parameters and sets `additionalProperties: false`, and it
drives every tool's zod schema with a table of bad inputs that must be rejected and good inputs that
must parse. It exits non-zero on any failure.

`scripts/http-smoke.mjs` starts a fake Pyon that plays the authorization server and the API, then
drives the hosted server with the SDK's own client. It checks the discovery documents and the 401
challenge, the Host and Origin checks, that two users calling at once each reach the API as
themselves and never with the token their app holds, that a disconnected user is sent back to sign
in, and that `node dist/index.js` without a flag still serves stdio.
