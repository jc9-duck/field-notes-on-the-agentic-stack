// Dev tool: run the labeled cases in ../fixtures/judge-cases.json straight through a running
// NeMo Guardrails server's POST /v1/checks (no gateway) and report accuracy + latency.
//   NEMO_URL=http://localhost:18000 BEDROCK_RAILS_MODEL=qwen.qwen3-coder-next node calibrate.mjs
// NeMo's self-check rails only BLOCK (they cannot redact a span), so for scoring purposes a case
// the Ollama judge would reject or mask counts as correct when NeMo BLOCKS it, and a case that
// should pass must come back `passed`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');
const url = process.env.NEMO_URL || 'http://localhost:18000';
const model = process.env.BEDROCK_RAILS_MODEL || 'qwen.qwen3-coder-next';
const cases = JSON.parse(readFileSync(join(fixtures, 'judge-cases.json'), 'utf8'));

let ok = 0;
const times = [];
console.log(`model: ${model}   server: ${url}`);
for (const c of cases) {
  const text = c.text ?? readFileSync(join(fixtures, c.text_file), 'utf8');
  const response = c.direction === 'response';
  const body = {
    model,
    messages: [{ role: response ? 'assistant' : 'user', content: text }],
    guardrails: { config_id: 'gateway', rail_types: [response ? 'output' : 'input'] },
  };
  const t0 = Date.now();
  let status = 'error', rail = '';
  try {
    const r = await fetch(`${url}/v1/checks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const j = await r.json();
    status = j.status ?? `http-${r.status}`; rail = j.rail ?? '';
  } catch (e) { status = `error: ${e.message}`; }
  const ms = Date.now() - t0;
  times.push(ms);
  const want = c.expect === 'pass' ? 'passed' : 'blocked';
  const pass = status === want;
  if (pass) ok++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.id.padEnd(30)} ${String(ms).padStart(5)}ms  want ${want.padEnd(7)} got ${status}${rail ? ` (${rail})` : ''}`);
}
times.sort((a, b) => a - b);
console.log(`\n${ok}/${cases.length} correct   median ${times[Math.floor(times.length / 2)]}ms   max ${times[times.length - 1]}ms`);
