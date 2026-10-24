// agentgateway guardrail webhook backed by a NeMo Guardrails server. Dependency-free.
//   POST /request   POST /response   (see adapter.mjs)
//   GET  /health    always 200       GET /ready   200 once NeMo answers its health check
// Env: PORT=9200  NEMO_URL=http://nemo:8000  NEMO_CONFIG_ID=gateway
//      NEMO_MODEL=qwen.qwen3-coder-next  JUDGE_DEADLINE_MS=9000 (the gateway gives a webhook 10s)
//      LOG_DIR=(optional)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeNemoCheck, reviewRequest, reviewResponse } from './adapter.mjs';

const PORT = Number(process.env.PORT || 9200);
const NEMO_URL = process.env.NEMO_URL || 'http://nemo:8000';
const MODEL = process.env.NEMO_MODEL || 'qwen.qwen3-coder-next';
const DEADLINE_MS = Number(process.env.JUDGE_DEADLINE_MS || 9000);
const LOG_DIR = process.env.LOG_DIR || '';
const LOG_MAX_BYTES = 1024 * 1024;

const nemo = makeNemoCheck({ url: NEMO_URL, model: MODEL, configId: process.env.NEMO_CONFIG_ID || 'gateway' });

// Clients resend the whole conversation every turn: verdicts are cached by content hash.
const cache = new Map();
const CACHE_MAX = 500;
const keyOf = (direction, text) => direction + ':' + crypto.createHash('sha256').update(text).digest('hex');
function checkWithin(deadline, stats) {
  return async (direction, text) => {
    const k = keyOf(direction, text);
    if (cache.has(k)) { stats.hits++; return cache.get(k); }
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('deadline exceeded');
    const r = await nemo(direction, text, left);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(k, r);
    stats.calls++;
    return r;
  };
}

// Verdict log: JSONL, decision + rail name + timing. Never the text.
const logFile = LOG_DIR ? path.join(LOG_DIR, 'nemo-verdicts.jsonl') : '';
function logVerdict(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), model: MODEL, ...entry });
  console.log(line);
  if (!logFile) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size >= LOG_MAX_BYTES) fs.renameSync(logFile, `${logFile}.1`);
    fs.appendFileSync(logFile, line + '\n');
  } catch (e) { console.error('log write failed:', e.message); }
}

const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, model: MODEL });
  if (req.method === 'GET' && req.url === '/ready') {
    const up = await fetch(`${NEMO_URL}/v1/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
    return send(res, up ? 200 : 503, { ready: up });
  }
  const dir = req.url === '/request' ? 'request' : req.url === '/response' ? 'response' : null;
  if (req.method !== 'POST' || !dir) return send(res, 404, { error: 'not found' });

  let payload;
  try { payload = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }

  const t0 = Date.now();
  const stats = { hits: 0, calls: 0 };
  const check = checkWithin(t0 + DEADLINE_MS, stats);
  try {
    const out = dir === 'request'
      ? await reviewRequest(payload?.body?.messages ?? [], check)
      : await reviewResponse(payload?.body?.choices ?? [], check);
    logVerdict({ dir, ...out.summary, checked: stats.calls, cached: stats.hits, ms: Date.now() - t0 });
    return send(res, 200, { action: out.action });
  } catch (e) {
    // A non-2xx makes the gateway apply the configured failureMode (failClosed by default).
    logVerdict({ dir, action: 'error', error: e.message, checked: stats.calls, cached: stats.hits, ms: Date.now() - t0 });
    return send(res, 502, { error: 'nemo unavailable' });
  }
}).listen(PORT, () => console.log(`nemo-adapter on :${PORT} -> ${NEMO_URL}, model ${MODEL}`));
