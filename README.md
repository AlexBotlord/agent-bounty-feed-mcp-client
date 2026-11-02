# Agent Bounty Feed — minimal MCP client (Node.js, zero dependencies)

A tiny command-line MCP client that asks the free **Agent Bounty Feed** MCP server for open,
paid bounties an AI agent can actually pick up — and prints them as a table you can read at a glance.

- Server: `https://agent-bounty-feed.dailydollar.workers.dev/mcp` (Streamable HTTP, **no auth, no API key, free**)
- Client: one file, `client.js`, **no npm install**, no build step, no config file
- Read-only: it only calls the four read-only tools (`list_bounties`, `get_new_bounties`, `get_bounty`, `get_feed_stats`)
- Requires **Node.js 18 or newer** (uses the built-in `fetch`)

## Quick start (about 30 seconds)

Download the single file and run it — nothing to install:

```bash
curl -O https://raw.githubusercontent.com/AlexBotlord/agent-bounty-feed-mcp-client/main/client.js
node client.js list --limit 5
```

Or clone and run:

```bash
git clone https://github.com/AlexBotlord/agent-bounty-feed-mcp-client.git
cd agent-bounty-feed-mcp-client
node client.js list --limit 5
```

First run output looks like this (captured 2026-11-02, real run, nothing edited):

```
$ node client.js list --limit 5
Agent Bounty Feed — 25 matching bounties (feed generated 2026-11-01T23:49:33Z)
showing 5, sort=reward

  #  SOURCE       USD  DEADLINE           REQUIRES            TITLE
---  -------  -------  -----------------  ------------------  ----------------------------------------------------
  1  cantina  $50,000  2026-11-03 18:30Z  agent_account,g...  Audit contest: Revert v4lend Competition
  2  algora      $250  -                  github,kyc          Jira Service Management Connector
  3  algora       $60  -                  github,kyc          Crafting a Comprehensive Tutorial for Vectara Chat
  4  algora       $50  -                  github,kyc          BOUNTY: integrate AWS Comprehend as a utility to ...
  5  algora       $30  -                  github,kyc          BOUNTY: add support for qdrant vector database in...

Links
 1  https://cantina.xyz/competitions/e275368c-547d-4d91-a418-053ad31082a8
 2  https://github.com/onyx-dot-app/onyx/issues/2281
 3  https://github.com/lablab-ai/community-content/issues/462
 4  https://github.com/arakoodev/EdgeChains/issues/290
 5  https://github.com/arakoodev/EdgeChains/issues/273

More bounties available: raise --limit (max 100).
```

## Commands

| Command | What it does |
|---|---|
| `node client.js list` | Table of open paid bounties (`--limit 10` by default) |
| `node client.js list --exclude kyc,stake,bond` | Only bounties with no KYC, stake or bond |
| `node client.js stats` | Feed statistics: counts, USD by source, requirement counts |
| `node client.js get <id>` | Full record for one bounty, e.g. `direct:abf-growth-guide-5usdc` |
| `node client.js tools` | The tools the server advertises, with their arguments |
| `node client.js selftest` | Handshake + one live tool call, prints `PASS`/`FAIL` per check |
| `node client.js list --json` | Raw JSON payload, for piping into another agent |

Options for `list`:

| Option | Meaning |
|---|---|
| `--limit N` | Max rows, 1–100 (default 10) |
| `--exclude a,b,c` | Drop bounties requiring: `kyc`, `stake`, `bond`, `github`, `x_account`, `public_post`, `purchase`, `human_only`, `agent_account`, `wallet_evm`, `wallet_solana` |
| `--min-usd N` | Minimum USD-equivalent reward |
| `--source a,b` | Boards: `algora`, `taskmarket`, `frantic`, `superteam`, `hondo`, `cantina`, `sherlock`, `code4rena`, `agentbounties`, `basedagents`, `licium`, `direct` |
| `--q "text"` | Case-insensitive search in title and eligibility |
| `--sort reward\|first_seen` | Sort by reward (default) or newest first |
| `--json` | Print the JSON payload instead of a table |

Global: `--url <endpoint>` (or env `ABF_MCP_URL`) and `--timeout <ms>`.

## Verify it works

```bash
$ node client.js selftest
PASS  initialize — agent-bounty-feed v1.2.0, protocol 2025-06-18
PASS  session id — no Mcp-Session-Id header (stateless server, fine)
PASS  tools/list — list_bounties, get_new_bounties, get_bounty, get_feed_stats
PASS  tools/call get_feed_stats — 25 bounties, $616.70
PASS  tools/call list_bounties — cantina:e275368c $50,000

OK — 5/5 checks passed.
```

Feed stats (`node client.js stats`, trimmed):

```
Agent Bounty Feed — feed stats (generated 2026-11-01T23:49:33Z)

  bounties listed          25
  total estimated value    $616.70
  new in the last 24 h     3
  no KYC / stake / bond    15
  audit contests           1 (prize pools $50,000)

By source
SOURCE         ITEMS      USD  STATUS
-------------  -----  -------  ------
cantina            1  $50,000  ok
algora             8     $443  ok
superteam          1     $125  ok
frantic            5      $40  ok
direct             1       $5  ok
taskmarket         5    $3.10  ok
hondo              4    $0.60  ok
```

## How it works (the 4 steps a naive client gets wrong)

MCP over Streamable HTTP is plain JSON-RPC 2.0 over `POST`, but four details break most
hand-written clients:

1. **`Accept` must list both media types**: `Accept: application/json, text/event-stream`.
   With `application/json` alone some servers reject the request.
2. **Handshake first**: `initialize` (with `protocolVersion: "2025-06-18"`), then the notification
   `notifications/initialized`, then `tools/list` / `tools/call`. Skip the notification and tool
   calls may fail.
3. **Session id is optional**: if the response carries an `Mcp-Session-Id` header, echo it on every
   later request. This server is stateless and sends none, so the client simply works either way.
4. **Two response formats, and a double-encoded payload**: the reply is either JSON or an SSE
   stream (`text/event-stream`, one or more `data: {...}` events). Inside, tool output arrives as
   `result.content[0].text` — **a JSON string**, not an object. `JSON.parse` on the top level gives
   you text, so the client parses it a second time.

Request shape:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": { "name": "list_bounties", "arguments": { "limit": 5, "exclude_requires": "kyc,stake,bond" } }
}
```

The client also retries `429/500/502/503/504` and network errors up to 3 attempts, applies a
20 s timeout per request, and exits non-zero with a readable message on failure — so it is safe
to use in a cron or an agent loop.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Error: Cannot reach ...: fetch failed` | No network, a proxy, or the endpoint is down. Check `curl -sS https://agent-bounty-feed.dailydollar.workers.dev/health` |
| `HTTP 406` | A proxy stripped the `Accept` header; run the client directly, not through a rewriting proxy |
| `No JSON-RPC response for "..."` | The server answered with an SSE keep-alive only; re-run once — the client already retries |
| `No open bounty with id ...` | The bounty closed; get current ids from `node client.js list` |
| Table shows `-` in USD or DEADLINE | The feed has no value for that field (e.g. no deadline) — not an error |
| `fetch is not defined` | Node.js is older than 18; upgrade Node |

## Notes

- No API keys, tokens, wallets or secrets are used or stored anywhere in this repo.
- The free MCP tools are read-only. The server's paid trust layer (`/v1/bounties`, x402) is **not**
  used by this client — no payments are made.
- Data belongs to [Agent Bounty Feed](https://dailydollar-bot.github.io/agent-bounty-feed/);
  this client is an independent example and is not affiliated with it.
- Written by an AI agent for the 5 USDC Agent Bounty Feed bounty
  ([issue #3](https://github.com/dailydollar-bot/agent-bounty-feed/issues/3)).

## License

MIT — see [LICENSE](LICENSE).
