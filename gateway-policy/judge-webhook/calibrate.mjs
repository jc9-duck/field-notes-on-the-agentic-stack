// Dev tool: run the labeled cases in ../fixtures/judge-cases.json straight through the
// judge (no gateway) and report accuracy + latency per model. Use it to pick a model and
// tune the prompts in judge.mjs.   node calibrate.mjs      (needs Ollama)
//   JUDGE_MODEL=qwen2.5:14b OLLAMA_URL=http://localhost:11434 node calibrate.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeOllamaJudge, applySpans } from './judge.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');
const model = process.env.JUDGE_MODEL || 'llama3.1:8b';
const judge = makeOllamaJudge({
  url: process.env.OLLAMA_URL || 'http://localhost:11434',
  model,
  timeoutMs: Number(process.env.JUDGE_TIMEOUT_MS || 60000),
});

const cases = JSON.parse(readFileSync(join(fixtures, 'judge-cases.json'), 'utf8'));
let ok = 0;
const times = [];
console.log(`model: ${model}`);
for (const c of cases) {
  const text = c.text ?? readFileSync(join(fixtures, c.text_file), 'utf8');
  const t0 = Date.now();
  let verdict, err;
  try { verdict = await judge(c.direction, text); } catch (e) { err = e.message; }
  const ms = Date.now() - t0;
  times.push(ms);
  let pass = false, why = '';
  if (err) { why = `error: ${err}`; }
  else {
    const r = applySpans(text, verdict.sensitive);
    if (c.expect === 'reject') { pass = verdict.prompt_injection; why = `injection=${verdict.prompt_injection}`; }
    else if (c.expect === 'pass') { pass = !verdict.prompt_injection && r.applied.length === 0; why = `injection=${verdict.prompt_injection} masked=${r.applied.join(',') || '-'}`; }
    else {
      const left = (c.must_redact || []).filter((s) => r.text.includes(s));
      pass = !verdict.prompt_injection && left.length === 0;
      why = `injection=${verdict.prompt_injection} masked=${r.applied.join(',') || '-'}${left.length ? ` STILL-VISIBLE=${JSON.stringify(left)}` : ''}`;
    }
  }
  if (pass) ok++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.id.padEnd(22)} ${String(ms).padStart(6)}ms  ${c.expect.padEnd(6)}  ${why}`);
}
times.sort((a, b) => a - b);
console.log(`\n${ok}/${cases.length} correct   median ${times[Math.floor(times.length / 2)]}ms   max ${times[times.length - 1]}ms`);
