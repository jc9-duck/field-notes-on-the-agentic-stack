// Mock OpenAI-compatible upstream for guardrail tests (dependency-free).
//   POST /v1/chat/completions  records the body it received, replies with a canned
//                              assistant message. If the last user message contains
//                              "RESPOND_WITH:<text>" (or "RESPOND_B64:<base64>"), the
//                              assistant replies with that text (lets tests exercise
//                              response-side guards).
//   GET  /last                 returns the last body received -- i.e. exactly what the
//                              gateway forwarded after its request guards ran.
import http from 'node:http';

let last = null;

const read = (req) => new Promise((resolve) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => resolve(body));
});

// POST /next {text}: the NEXT chat completion replies with that text, once. The reply lives
// in the mock, not in the request, so a request-side guard that reads the prompt never sees
// (or reacts to) a trigger string, and response-side tests need no special prompt at all.
let nextReply = null;

http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET' && req.url === '/last') {
    res.end(JSON.stringify(last));
    return;
  }
  if (req.method === 'POST' && req.url === '/next') {
    nextReply = JSON.parse((await read(req)) || '{}').text ?? null;
    res.end('{"ok":true}');
    return;
  }
  const raw = await read(req);
  last = JSON.parse(raw || '{}');
  const lastUser = [...(last.messages || [])].reverse().find((m) => m.role === 'user');
  const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const m = text.match(/RESPOND_WITH:(.*)$/s);
  // RESPOND_B64:<base64> lets a test make the reply contain PII without putting that
  // PII in the request (which the request-side guards would reject first).
  const b = text.match(/RESPOND_B64:([A-Za-z0-9+/=]+)/);
  let reply = b ? Buffer.from(b[1], 'base64').toString('utf8') : m ? m[1] : 'ok';
  if (nextReply !== null) { reply = nextReply; nextReply = null; }
  res.end(JSON.stringify({
    id: 'mock-1', object: 'chat.completion', created: 0, model: last.model || 'mock',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: reply } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
}).listen(9001);
