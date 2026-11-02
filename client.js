#!/usr/bin/env node
/**
 * abf-mcp-client — a minimal, zero-dependency MCP client for Agent Bounty Feed.
 *
 * Speaks JSON-RPC 2.0 over the MCP "Streamable HTTP" transport:
 *   POST https://agent-bounty-feed.dailydollar.workers.dev/mcp
 *   Content-Type: application/json
 *   Accept: application/json, text/event-stream
 *
 * Requires Node.js 18+ (uses the built-in global fetch). No npm install, no API keys.
 *
 * Usage:
 *   node client.js list [--limit N] [--exclude kyc,stake,bond] [--min-usd 5]
 *   node client.js stats
 *   node client.js get <bounty-id>
 *   node client.js tools
 *   node client.js selftest
 *
 * MIT License. Not affiliated with Agent Bounty Feed.
 */
'use strict';

const DEFAULT_URL = 'https://agent-bounty-feed.dailydollar.workers.dev/mcp';
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'abf-mcp-client', version: '1.0.0' };
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 3;

class RpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/* ------------------------------------------------------------------ */
/* Transport: POST JSON-RPC, parse either application/json or SSE      */
/* ------------------------------------------------------------------ */

/** Parse a text/event-stream body into an array of JSON messages. */
function parseSse(text) {
  const out = [];
  let data = [];
  const flush = () => {
    if (!data.length) return;
    const payload = data.join('\n');
    data = [];
    try {
      out.push(JSON.parse(payload));
    } catch {
      /* ignore non-JSON events (e.g. keep-alive payloads) */
    }
  };
  for (const line of String(text).split(/\r?\n/)) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue; // SSE comment / heartbeat
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
  }
  flush();
  return out;
}

function parseBody(bodyText, contentType) {
  const text = String(bodyText || '').trim();
  if (!text) return [];
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('text/event-stream')) return parseSse(text);
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Some proxies relabel an SSE stream as JSON; try SSE as a fallback.
    const sse = parseSse(text);
    if (sse.length) return sse;
    throw new RpcError(`Server returned a body that is neither JSON nor SSE: ${text.slice(0, 200)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

class McpClient {
  constructor({ url = DEFAULT_URL, timeoutMs = DEFAULT_TIMEOUT_MS, verbose = false } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.verbose = verbose;
    this.sessionId = null;
    this.nextId = 1;
    this.serverInfo = null;
    this.protocolVersion = null;
    this.instructions = null;
  }

  headers() {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  async send(payload) {
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const sessionHeader = res.headers.get('mcp-session-id');
        if (sessionHeader) this.sessionId = sessionHeader;

        const bodyText = await res.text();
        if (!res.ok) {
          if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
            lastErr = new RpcError(`HTTP ${res.status} from MCP server: ${bodyText.slice(0, 200)}`);
            await sleep(500 * attempt);
            continue;
          }
          throw new RpcError(`HTTP ${res.status} from MCP server: ${bodyText.slice(0, 300)}`, res.status);
        }
        return parseBody(bodyText, res.headers.get('content-type'));
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof RpcError && !RETRYABLE.has(err.code)) throw err;
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(500 * attempt);
          continue;
        }
      }
    }
    const reason = lastErr && lastErr.name === 'AbortError' ? `timed out after ${this.timeoutMs} ms` : String(lastErr && lastErr.message);
    throw new RpcError(`Cannot reach ${this.url}: ${reason}`);
  }

  async request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;
    const messages = await this.send(payload);
    const reply = messages.find((m) => m && m.id === id) || messages[messages.length - 1];
    if (!reply) throw new RpcError(`No JSON-RPC response for "${method}" (server sent ${messages.length} message(s))`);
    if (reply.error) {
      throw new RpcError(`${method}: ${reply.error.message || 'JSON-RPC error'}`, reply.error.code, reply.error.data);
    }
    return reply.result;
  }

  async notify(method, params) {
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) payload.params = params;
    await this.send(payload);
  }

  /** initialize -> notifications/initialized. Required before any tools call. */
  async connect() {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    this.protocolVersion = result && result.protocolVersion;
    this.serverInfo = (result && result.serverInfo) || null;
    this.instructions = (result && result.instructions) || null;
    await this.notify('notifications/initialized');
    return result;
  }

  async listTools() {
    const result = await this.request('tools/list', {});
    return (result && result.tools) || [];
  }

  /**
   * Call a tool. Returns the decoded payload.
   * MCP tool results carry a `content` array whose text is itself JSON for this server,
   * so the text is parsed when possible and returned as `data`.
   */
  async callTool(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    const text = (result && Array.isArray(result.content) ? result.content : [])
      .filter((part) => part && part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    if (result && result.isError) throw new RpcError(`${name} failed: ${text.slice(0, 300)}`);
    let data = null;
    if (result && result.structuredContent) {
      data = result.structuredContent;
    } else if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { data, text, raw: result };
  }

  /** Best-effort session teardown; servers without sessions simply ignore it. */
  async close() {
    if (!this.sessionId) return;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      await fetch(this.url, { method: 'DELETE', headers: this.headers(), signal: controller.signal });
      clearTimeout(timer);
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

function usd(value) {
  if (value === null || value === undefined || value === '') return '-';
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  const fixed = Number.isInteger(n) ? String(n) : n.toFixed(2);
  const [whole, frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '$' + (frac ? `${grouped}.${frac}` : grouped);
}

function deadline(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const iso = d.toISOString(); // 2026-11-03T18:30:00.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}

function cut(text, width) {
  const s = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim();
  if (s.length <= width) return s;
  return s.slice(0, Math.max(0, width - 3)) + '...';
}

function pad(text, width, align = 'left') {
  const s = String(text);
  if (s.length >= width) return s;
  const fill = ' '.repeat(width - s.length);
  return align === 'right' ? fill + s : s + fill;
}

function table(headers, rows, aligns = []) {
  const widths = headers.map((h, i) =>
    Math.max(3, String(h).length, ...rows.map((r) => String(r[i] === undefined ? '' : r[i]).length))
  );
  const line = (cells) => cells.map((c, i) => pad(c, widths[i], aligns[i])).join('  ').replace(/\s+$/, '');
  const out = [line(headers), line(widths.map((w) => '-'.repeat(w)))];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

const HELP = `abf-mcp-client — minimal zero-dependency MCP client for Agent Bounty Feed

Usage:
  node client.js list [options]      List open paid bounties
  node client.js stats               Feed statistics (counts, USD by source)
  node client.js get <bounty-id>     One bounty by id, e.g. algora:owner/repo#123
  node client.js tools               Tools advertised by the MCP server
  node client.js selftest            Handshake + one live tool call, prints PASS/FAIL

Options for "list":
  --limit N              Max rows (1-100, default 10)
  --exclude a,b,c        Drop bounties requiring these: kyc,stake,bond,github,x_account,
                         public_post,purchase,human_only,agent_account,wallet_evm,wallet_solana
  --min-usd N            Minimum USD-equivalent reward
  --source a,b           Boards: algora,taskmarket,frantic,superteam,hondo,cantina,...,direct
  --q "text"             Case-insensitive search in title and eligibility
  --sort reward|first_seen
  --json                 Print the raw JSON payload instead of a table

Global options:
  --url <endpoint>       Override MCP endpoint (default: ${DEFAULT_URL})
  --timeout <ms>         Per-request timeout (default ${DEFAULT_TIMEOUT_MS})
  -h, --help             Show this help

Environment: ABF_MCP_URL overrides the endpoint.
`;

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { command: null, limit: 10, exclude: null, minUsd: null, source: null, q: null, sort: null, json: false, url: process.env.ABF_MCP_URL || DEFAULT_URL, timeoutMs: DEFAULT_TIMEOUT_MS, positional: [] };
  const takesValue = new Set(['--limit', '--exclude', '--exclude-requires', '--min-usd', '--source', '--q', '--sort', '--url', '--timeout']);
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline = null;
    if (arg.startsWith('--') && arg.includes('=')) {
      const at = arg.indexOf('=');
      inline = arg.slice(at + 1);
      arg = arg.slice(0, at);
    }
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }
    if (takesValue.has(arg)) {
      const value = inline !== null ? inline : argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      switch (arg) {
        case '--limit': opts.limit = Number(value); break;
        case '--exclude':
        case '--exclude-requires': opts.exclude = value; break;
        case '--min-usd': opts.minUsd = Number(value); break;
        case '--source': opts.source = value; break;
        case '--q': opts.q = value; break;
        case '--sort': opts.sort = value; break;
        case '--url': opts.url = value; break;
        case '--timeout': opts.timeoutMs = Number(value); break;
      }
      continue;
    }
    if (arg === '--json') {
      opts.json = true;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    if (!opts.command) opts.command = arg;
    else opts.positional.push(arg);
  }
  if (!opts.command) opts.command = 'list';
  if (!Number.isFinite(opts.limit) || opts.limit < 1) throw new Error('--limit must be a positive number');
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1000) throw new Error('--timeout must be >= 1000 ms');
  return opts;
}

function printBounties(payload, opts) {
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const items = (payload && payload.items) || [];
  if (!items.length) {
    console.log('No bounties matched. Try: node client.js list --limit 20');
    return;
  }
  const filters = [];
  if (opts.exclude) filters.push(`exclude_requires=${opts.exclude}`);
  if (opts.minUsd !== null) filters.push(`min_usd=${opts.minUsd}`);
  if (opts.source) filters.push(`source=${opts.source}`);
  if (opts.q) filters.push(`q="${opts.q}"`);

  console.log(`Agent Bounty Feed — ${payload.total_matching ?? items.length} matching bounties (feed generated ${payload.generated_at || 'unknown'})`);
  console.log(`showing ${items.length}, sort=${payload.sort || opts.sort || 'reward'}${filters.length ? ', ' + filters.join(', ') : ''}`);
  console.log('');

  const rows = items.map((b, i) => [
    String(i + 1),
    cut(b.source, 12),
    usd(b.est_usd !== undefined ? b.est_usd : b.reward),
    deadline(b.deadline),
    cut((b.requires || []).join(',') || '-', 18),
    cut(b.title, 52),
  ]);
  console.log(table(['#', 'SOURCE', 'USD', 'DEADLINE', 'REQUIRES', 'TITLE'], rows, ['right', 'left', 'right', 'left', 'left', 'left']));
  console.log('');
  console.log('Links');
  items.forEach((b, i) => console.log(`${pad(String(i + 1), 2, 'right')}  ${b.url}`));
  if (payload.has_more) {
    console.log('');
    console.log('More bounties available: raise --limit (max 100).');
  }
}

function printStats(payload) {
  const stats = (payload && payload.stats) || {};
  console.log(`Agent Bounty Feed — feed stats (generated ${payload.generated_at || 'unknown'})`);
  console.log('');
  console.log(`  bounties listed          ${stats.items ?? '-'}`);
  console.log(`  total estimated value    ${usd(stats.total_usd)}`);
  console.log(`  new in the last 24 h     ${stats.new_last_24h ?? '-'}`);
  console.log(`  no KYC / stake / bond    ${stats.no_bond_no_stake_no_kyc ?? '-'}`);
  console.log(`  audit contests           ${stats.audit_contests ?? '-'} (prize pools ${usd(stats.audit_contest_prize_pools_usd)})`);
  console.log('');

  const bySource = Object.entries(stats.by_source || {})
    .map(([name, v]) => [name, v.items ?? 0, v.usd ?? 0, v.ok === false ? 'ERROR' : 'ok'])
    .sort((a, b) => b[2] - a[2]);
  if (bySource.length) {
    console.log('By source');
    console.log(table(['SOURCE', 'ITEMS', 'USD', 'STATUS'], bySource.map((r) => [r[0], String(r[1]), usd(r[2]), r[3]]), ['left', 'right', 'right', 'left']));
    console.log('');
  }

  const reqs = Object.entries(stats.requires_counts || {}).sort((a, b) => b[1] - a[1]);
  if (reqs.length) {
    console.log('Requirements (bounties asking for each)');
    console.log('  ' + reqs.map(([k, v]) => `${k} ${v}`).join(' · '));
    console.log('');
  }

  const dropped = Object.entries(stats.dropped_this_refresh || {}).sort((a, b) => b[1] - a[1]);
  if (dropped.length) {
    console.log('Filtered out at the last refresh');
    for (const [reason, n] of dropped) console.log(`  ${String(n).padStart(3, ' ')}  ${reason}`);
  }
}

function printBounty(item) {
  const b = (item && (item.item || item.bounty)) || item || {};
  console.log(`${b.title || '(no title)'}`);
  console.log('');
  console.log(`  id          ${b.id}`);
  console.log(`  source      ${b.source} (${b.kind || 'bounty'})`);
  console.log(`  reward      ${usd(b.est_usd !== undefined ? b.est_usd : b.reward)}${b.currency ? ' ' + b.currency : ''}`);
  console.log(`  network     ${b.network || '-'}`);
  console.log(`  deadline    ${deadline(b.deadline)}`);
  console.log(`  requires    ${(b.requires || []).join(', ') || '-'}`);
  console.log(`  slots left  ${b.slots_left === null || b.slots_left === undefined ? '-' : b.slots_left}`);
  console.log(`  first seen  ${b.first_seen || '-'}`);
  console.log(`  url         ${b.url || '-'}`);
  if (b.eligibility) {
    console.log('');
    console.log('Eligibility / how to claim');
    console.log('  ' + String(b.eligibility).replace(/\s+/g, ' ').trim());
  }
  if (b.verified && b.verified.checked_at) console.log(`\nVerified at ${b.verified.checked_at}`);
}

async function runSelftest(client) {
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  };

  const init = await client.connect();
  check('initialize', Boolean(init && init.serverInfo), `${init.serverInfo?.name || '?'} v${init.serverInfo?.version || '?'}, protocol ${init.protocolVersion || '?'}`);
  check('session id', true, client.sessionId ? `Mcp-Session-Id present (${client.sessionId.slice(0, 8)}...)` : 'no Mcp-Session-Id header (stateless server, fine)');

  const tools = await client.listTools();
  const names = tools.map((t) => t.name);
  const wanted = ['list_bounties', 'get_new_bounties', 'get_bounty', 'get_feed_stats'];
  check('tools/list', wanted.every((n) => names.includes(n)), names.join(', '));

  const stats = await client.callTool('get_feed_stats', {});
  check('tools/call get_feed_stats', Boolean(stats.data && stats.data.stats), `${stats.data?.stats?.items ?? '?'} bounties, ${usd(stats.data?.stats?.total_usd)}`);

  const list = await client.callTool('list_bounties', { limit: 1 });
  const first = list.data && list.data.items && list.data.items[0];
  check('tools/call list_bounties', Boolean(first), first ? `${first.id} ${usd(first.est_usd)}` : 'no items');

  const failed = checks.filter((c) => !c.ok).length;
  console.log('');
  console.log(failed === 0 ? `OK — ${checks.length}/${checks.length} checks passed.` : `FAILED — ${failed} of ${checks.length} checks failed.`);
  return failed === 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const client = new McpClient({ url: opts.url, timeoutMs: opts.timeoutMs });
  try {
    await client.connect();

    switch (opts.command) {
      case 'list': {
        const args = { limit: opts.limit };
        if (opts.exclude) args.exclude_requires = opts.exclude;
        if (opts.minUsd !== null) args.min_usd = opts.minUsd;
        if (opts.source) args.source = opts.source;
        if (opts.q) args.q = opts.q;
        if (opts.sort) args.sort = opts.sort;
        const res = await client.callTool('list_bounties', args);
        if (!res.data) {
          console.log(res.text);
          return 0;
        }
        printBounties(res.data, opts);
        return 0;
      }
      case 'stats': {
        const res = await client.callTool('get_feed_stats', {});
        if (opts.json || !res.data) {
          console.log(res.data ? JSON.stringify(res.data, null, 2) : res.text);
          return 0;
        }
        printStats(res.data);
        return 0;
      }
      case 'get': {
        const id = opts.positional[0];
        if (!id) {
          console.error('Usage: node client.js get <bounty-id>');
          return 2;
        }
        const res = await client.callTool('get_bounty', { id });
        if (opts.json) {
          console.log(JSON.stringify(res.data || res.raw, null, 2));
          return 0;
        }
        if (!res.data) {
          console.log(res.text);
          return 0;
        }
        printBounty(res.data);
        return 0;
      }
      case 'tools': {
        const tools = await client.listTools();
        console.log(`Server: ${client.serverInfo?.name} v${client.serverInfo?.version} (protocol ${client.protocolVersion})`);
        console.log('');
        for (const t of tools) {
          console.log(`${t.name}`);
          console.log(`  ${cut(t.description || t.title || '', 160)}`);
          const props = Object.keys((t.inputSchema && t.inputSchema.properties) || {});
          if (props.length) console.log(`  args: ${props.join(', ')}`);
          console.log('');
        }
        return 0;
      }
      case 'selftest': {
        const ok = await runSelftest(client);
        return ok ? 0 : 1;
      }
      default:
        console.error(`Unknown command "${opts.command}".\n`);
        console.log(HELP);
        return 2;
    }
  } finally {
    await client.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Error: ${err && err.message ? err.message : err}`);
    if (process.env.ABF_DEBUG) console.error(err);
    process.exit(1);
  });
