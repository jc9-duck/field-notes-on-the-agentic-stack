// agentgateway guardrail webhook backed by a local Ollama judge. Dependency-free.
//   POST /request   POST /response   (see handlers.mjs for the wire format)
//   GET  /health    always 200       GET /ready   200 once the model is warm, else 503
// Env: PORT=9100  OLLAMA_URL=http://host.docker.internal:11434  JUDGE_MODEL=llama3.1:8b
//      JUDGE_DEADLINE_MS=9000 (the gateway gives a webhook a fixed 10s)  LOG_DIR=(optional)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeOllamaJudge } from './judge.mjs';
import { reviewRequest, reviewResponse } from './handlers.mjs';

const PORT = Number(process.env.PORT || 9100);
const MODEL = process.env.JUDGE_MODEL || 'llama3.1:8b';
const DEADLINE_MS = Number(process.env.JUDGE_DEADLINE_MS || 9000);
const LOG_DIR = process.env.LOG_DIR || '';
const LOG_MAX_BYTES = 1024 * 1024;

const ollama = makeOllamaJudge({
  url: process.env.OLLAMA_URL || 'http://host.docker.internal:11434',
  model: MODEL,
  timeoutMs: DEADLINE_MS,
});

// Clients resend the whole conversation every turn; verdicts are keyed by content hash so a
// message is judged once. Bounded, oldest evicted first.
const cache = new Map();
const CACHE_MAX = 500;
const keyOf = (direction, text) => direction + ':' + crypto.createHash('sha256').update(text).digest('hex');

function judgeWithin(deadline, stats) {
  return async (direction, text) => {
    const k = keyOf(direction, text);
    if (cache.has(k)) { stats.hits++; return cache.get(k); }
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('judge deadline exceeded');
    const verdict = await ollama(direction, text, left);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(k, verdict);
    stats.calls++;
    return verdict;
  };
}

// Verdict log: JSONL, one line per call. Never the text or the spans (the spans ARE the
// PII): only the decision, category names, counts and timing.
const logFile = LOG_DIR ? path.join(LOG_DIR, 'judge-verdicts.jsonl') : '';
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

let ready = false;
async function warmUp() {
  while (!ready) {
    try { await ollama('request', 'hello', 120000); ready = true; console.log(`judge warm: ${MODEL}`); }
    catch (e) { console.error(`warm-up failed (${e.message}), retrying in 3s`); await new Promise((r) => setTimeout(r, 3000)); }
  }
}

const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, model: MODEL });
  if (req.method === 'GET' && req.url === '/ready') return send(res, ready ? 200 : 503, { ready });
  const dir = req.url === '/request' ? 'request' : req.url === '/response' ? 'response' : null;
  if (req.method !== 'POST' || !dir) return send(res, 404, { error: 'not found' });

  let payload;
  try { payload = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }

  const t0 = Date.now();
  const stats = { hits: 0, calls: 0 };
  const judge = judgeWithin(t0 + DEADLINE_MS, stats);
  try {
    const out = dir === 'request'
      ? await reviewRequest(payload?.body?.messages ?? [], judge)
      : await reviewResponse(payload?.body?.choices ?? [], judge);
    logVerdict({ dir, ...out.summary, judged: stats.calls, cached: stats.hits, ms: Date.now() - t0 });
    return send(res, 200, { action: out.action });
  } catch (e) {
    // A non-2xx makes the gateway apply the configured failureMode (failClosed by default).
    logVerdict({ dir, action: 'error', error: e.message, judged: stats.calls, cached: stats.hits, ms: Date.now() - t0 });
    return send(res, 502, { error: 'judge unavailable' });
  }
}).listen(PORT, () => { console.log(`judge-webhook on :${PORT}, model ${MODEL}`); warmUp(); });
