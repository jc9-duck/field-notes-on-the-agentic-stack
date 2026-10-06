// Maps agentgateway's guardrail webhook onto NeMo Guardrails' POST /v1/checks, with the NeMo
// call injected so this can be unit-tested without NeMo or Bedrock.
//
//   gateway POST /request   {"body":{"messages":[{role,content}]}}
//   gateway POST /response  {"body":{"choices":[{"message":{role,content}}]}}
//   NeMo status: passed -> pass | modified -> mask (use NeMo's rewritten content) | blocked -> reject
//
// NeMo's self-check rails can only BLOCK; they cannot redact a span the way the Ollama judge does.
// So a message that contains, say, a street address is rejected whole (HTTP 451), not masked.
export const REJECT_STATUS = 451; // same as the Ollama judge; regex rejects are 403

// Same scoping as the judge: only the user's own turns are checked on the way in. `system` is
// the client's trusted instructions, and assistant turns were already checked as responses.
const reviewable = (m) => m?.role === 'user' && typeof m?.content === 'string' && m.content.trim() !== '';

const reject = (rail, direction) => ({
  action: {
    body: `Blocked by NeMo Guardrails (${rail || 'rail'}).`,
    status_code: REJECT_STATUS,
    reason: `nemo ${direction}: ${rail || 'blocked'}`,
  },
  summary: { action: 'reject', rail: rail || '' },
});

export async function reviewRequest(messages, check) {
  const out = [];
  let modified = false;
  for (const m of messages) {
    if (!reviewable(m)) { out.push(m); continue; }
    const r = await check('request', m.content);
    if (r.status === 'blocked') return reject(r.rail, 'request');
    if (r.status === 'modified') { modified = true; out.push({ ...m, content: r.content }); } else out.push(m);
  }
  if (modified) return { action: { body: { messages: out }, reason: 'nemo: modified' }, summary: { action: 'mask', rail: '' } };
  return { action: { reason: 'nemo: passed' }, summary: { action: 'pass', rail: '' } };
}

export async function reviewResponse(choices, check) {
  const out = [];
  let modified = false;
  for (const c of choices) {
    const content = c?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') { out.push(c); continue; }
    const r = await check('response', content);
    if (r.status === 'blocked') return reject(r.rail, 'response');
    if (r.status === 'modified') { modified = true; out.push({ ...c, message: { ...c.message, content: r.content } }); } else out.push(c);
  }
  if (modified) return { action: { body: { choices: out }, reason: 'nemo: modified' }, summary: { action: 'mask', rail: '' } };
  return { action: { reason: 'nemo: passed' }, summary: { action: 'pass', rail: '' } };
}

// What NeMo READS. Placeholders left by earlier guards are swapped for a spaced "[removed] "
// marker. Seen in the end-to-end test: the built-in phone regex turned "build 2026.10.04-117" into
// "<PHONE_NUMBER>", and NeMo's output rail then blocked the garbled sentence even though the
// original passes. The forwarded text is not changed by this. (Same fix as the Ollama judge.)
export const checkView = (text) => text.replace(/<[A-Z_]+(?::[A-Z_]+)?>/g, '[removed] ');

// The real check: one POST to NeMo. NeMo uses the request's `model` over the config's, so the
// Bedrock model id has to be sent on every call (a placeholder id is rejected by Bedrock).
export function makeNemoCheck({ url, model, configId }) {
  return async function check(direction, text, budgetMs = 9000) {
    const response = direction === 'response';
    const res = await fetch(`${url}/v1/checks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(Math.max(1, budgetMs)),
      body: JSON.stringify({
        model,
        messages: [{ role: response ? 'assistant' : 'user', content: checkView(text) }],
        guardrails: { config_id: configId, rail_types: [response ? 'output' : 'input'] },
      }),
    });
    if (!res.ok) throw new Error(`nemo ${res.status}`);
    const j = await res.json();
    if (!['passed', 'modified', 'blocked'].includes(j.status)) throw new Error(`nemo status ${j.status}`);
    return { status: j.status, content: j.content ?? text, rail: j.rail ?? '' };
  };
}
