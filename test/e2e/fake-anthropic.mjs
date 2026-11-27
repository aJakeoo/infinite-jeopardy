// A stand-in for the Anthropic Messages API, so the AI path can be tested without a key.
// Records each request to test/e2e/out/ai-requests.json and answers with a valid (or first-time-broken) board.
import http from 'node:http';
import fs from 'node:fs';
import { demoBoard } from '../../src/boards.js';
const log = [];
let n = 0;
const DELAY = Number(process.env.FAKE_DELAY || 0); // ms, to watch the progress bar
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    n++;
    log.push({ path: req.url, headers: { auth: req.headers['x-api-key'] || req.headers.authorization, 'anthropic-version': req.headers['anthropic-version'] }, body: j });
    fs.writeFileSync('test/e2e/out/ai-requests.json', JSON.stringify(log, null, 2));
    if (/Replace these clues/.test(JSON.stringify(j.messages))) {
      const fixes = { fixes: [{ id: 0, clue: 'This eight-armed sea animal squirts ink to escape.', response: 'What is an octopus?' }] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `msg_${n}`, type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: JSON.stringify(fixes) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 400, output_tokens: 60 } }));
      return;
    }
    const size = /Categories: 4/.test(JSON.stringify(j.messages)) ? '4x4' : '6x5';
    const b = demoBoard('ocean', size);
    const out = { title: 'Fake AI Ocean', categories: b.categories, final: b.final };
    // The first request ever gets a leaked answer so the retry-with-feedback path runs.
    if (n === 1) out.categories[0].clues[0].clue = 'An octopus has eight arms and can squirt ink.';
    setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `msg_${n}`, type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: JSON.stringify(out) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 900, output_tokens: 2500 } }));
    }, DELAY);
  });
}).listen(8799, '127.0.0.1', () => console.log('fake anthropic on 8799'));
