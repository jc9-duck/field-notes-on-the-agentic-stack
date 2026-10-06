// Webhook logic, with the judge injected so it can be unit-tested without Ollama.
// Wire format (agentgateway v1.5.0, verified against its source and a live probe):
//   POST /request   {"body":{"messages":[{role,content}]}}
//   POST /response  {"body":{"choices":[{"message":{role,content}}]}}
//   reply  pass   {"action":{"reason"}}
//          mask   {"action":{"body":<same shape as the input body>,"reason"}}
//          reject {"action":{"body":"<text>","status_code":N,"reason"}}
import { applySpans } from './judge.mjs';

// Only the user's own turns are judged on the way in. `system` is the client's trusted
// instructions (and pi's is huge), `assistant` turns were already judged as responses,
// and tool results are not delivered to webhooks by v1.5.0 at all.
const REVIEW_ROLES = new Set(['user']);
export const REJECT_STATUS = 451; // regex guards reject with 403, so a test can tell who caught it

const reviewable = (m) => REVIEW_ROLES.has(m?.role) && typeof m?.content === 'string' && m.content.trim() !== '';

export async function reviewRequest(messages, judge) {
  const out = [];
  const kinds = [];
  let skipped = 0;
  for (const m of messages) {
    if (!reviewable(m)) { out.push(m); continue; }
    const v = await judge('request', m.content);
    if (v.prompt_injection) {
      return {
        action: {
          body: 'Blocked by the LLM judge guardrail: possible prompt injection.',
          status_code: REJECT_STATUS,
          reason: v.reason || 'prompt injection',
        },
        summary: { action: 'reject', injection: true, kinds: [], skipped },
      };
    }
    const r = applySpans(m.content, v.sensitive);
    kinds.push(...r.applied);
    skipped += r.skipped;
    out.push({ ...m, content: r.text });
  }
  if (kinds.length) {
    return {
      action: { body: { messages: out }, reason: `masked: ${[...new Set(kinds)].join(', ')}` },
      summary: { action: 'mask', injection: false, kinds, skipped },
    };
  }
  return { action: { reason: 'judge: clean' }, summary: { action: 'pass', injection: false, kinds: [], skipped } };
}

export async function reviewResponse(choices, judge) {
  const out = [];
  const kinds = [];
  let skipped = 0;
  for (const c of choices) {
    const content = c?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') { out.push(c); continue; }
    const v = await judge('response', content);
    const r = applySpans(content, v.sensitive);
    kinds.push(...r.applied);
    skipped += r.skipped;
    out.push({ ...c, message: { ...c.message, content: r.text } });
  }
  if (kinds.length) {
    return {
      action: { body: { choices: out }, reason: `masked: ${[...new Set(kinds)].join(', ')}` },
      summary: { action: 'mask', injection: false, kinds, skipped },
    };
  }
  return { action: { reason: 'judge: clean' }, summary: { action: 'pass', injection: false, kinds: [], skipped } };
}
