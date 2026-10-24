// Unit tests: no NeMo, no Bedrock, no Docker.   node --test gateway-policy/nemo/adapter/
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewRequest, reviewResponse, checkView, REJECT_STATUS } from './adapter.mjs';

test('checkView spaces out placeholders from earlier guards and leaves other text alone', () => {
  assert.equal(checkView('Build <PHONE_NUMBER>passed all 4829 checks.'), 'Build [removed] passed all 4829 checks.');
  assert.equal(checkView('a <EMAIL_ADDRESS> b <REDACTED:ADDRESS> c'), 'a [removed]  b [removed]  c');
  assert.equal(checkView('version 2.1 <not a placeholder>'), 'version 2.1 <not a placeholder>');
});

const check = (r) => async () => r;
const passed = { status: 'passed', content: '', rail: '' };

test('request: blocked -> reject 451 naming the rail, nothing else is checked', async () => {
  let calls = 0;
  const c = async () => { calls++; return { status: 'blocked', content: 'refused', rail: 'self check input' }; };
  const out = await reviewRequest([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], c);
  assert.equal(out.action.status_code, REJECT_STATUS);
  assert.match(out.action.body, /self check input/);
  assert.equal(out.summary.action, 'reject');
  assert.equal(calls, 1);
});

test('request: modified -> mask with NeMo rewritten content, other messages preserved', async () => {
  const msgs = [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'call 212-555-0101' }];
  const out = await reviewRequest(msgs, check({ status: 'modified', content: 'call [PHONE_NUMBER]', rail: '' }));
  assert.equal(out.summary.action, 'mask');
  assert.equal(out.action.body.messages[0].content, 'be brief');
  assert.equal(out.action.body.messages[1].content, 'call [PHONE_NUMBER]');
});

test('request: passed -> pass', async () => {
  const out = await reviewRequest([{ role: 'user', content: 'hi' }], check(passed));
  assert.equal(out.summary.action, 'pass');
  assert.equal(out.action.body, undefined);
});

test('request: system and assistant messages are never sent to NeMo', async () => {
  const seen = [];
  await reviewRequest([{ role: 'system', content: 'S' }, { role: 'assistant', content: 'A' }, { role: 'user', content: 'U' }],
    async (d, t) => { seen.push(t); return passed; });
  assert.deepEqual(seen, ['U']);
});

test('response: blocked -> reject (webhooks may reject on the response side)', async () => {
  const out = await reviewResponse([{ message: { role: 'assistant', content: 'secret' } }], check({ status: 'blocked', content: 'x', rail: 'self check output' }));
  assert.equal(out.action.status_code, REJECT_STATUS);
  assert.match(out.action.reason, /response/);
});

test('response: modified -> mask the choice, keeping role', async () => {
  const out = await reviewResponse([{ message: { role: 'assistant', content: 'mail a@b.com' } }], check({ status: 'modified', content: 'mail [EMAIL]', rail: '' }));
  assert.equal(out.action.body.choices[0].message.content, 'mail [EMAIL]');
  assert.equal(out.action.body.choices[0].message.role, 'assistant');
});

test('response: passed -> pass', async () => {
  const out = await reviewResponse([{ message: { role: 'assistant', content: 'Paris' } }], check(passed));
  assert.equal(out.summary.action, 'pass');
});

test('a NeMo failure propagates, so the gateway applies its failureMode', async () => {
  await assert.rejects(reviewRequest([{ role: 'user', content: 'x' }], async () => { throw new Error('nemo 500'); }), /nemo 500/);
});
