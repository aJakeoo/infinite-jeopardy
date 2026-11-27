// AI-path QA: runs against a dev server started with a fake Anthropic API (test/e2e/fake-anthropic.mjs).
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const results = [];
const ok = (name, cond, detail = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? `  (${detail})` : ''}`); };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const tv = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
const errors = [];
tv.on('pageerror', (e) => errors.push(e.message));

const health = await (await fetch(BASE + '/api/health')).json();
ok('server reports the AI as configured', health.ai === true);
await tv.goto(BASE + '/');
await tv.click('#start');
await tv.waitForSelector('#s-setup.on');
ok('demo note is hidden when a key is set', await tv.locator('#demo-note[hidden]').count() === 1);

async function generate(topic) {
  await tv.fill('#topic', topic);
  await tv.click('#make');
  await tv.waitForFunction(() => ['s-board', 's-setup'].includes(document.querySelector('.screen.on')?.id) && !document.querySelector('#s-generating.on'), null, { timeout: 30000 });
  await tv.waitForTimeout(400);
  return tv.evaluate(() => document.querySelector('.screen.on').id);
}
async function backToSetup() {
  await tv.click('[data-overlay="menu"]', { force: true });
  await tv.click('[data-overlay="confirm-new"]');
  await tv.click('#ov [data-act="new-game"]');
  await tv.waitForSelector('#s-setup.on');
}

ok('board 1 generates (after one automatic retry)', await generate('the ocean') === 's-board');
ok('the AI board title shows on the TV', /Fake AI Ocean/.test(await tv.locator('#bar-topic').innerText()));
ok('AI boards are not labelled as demo', !/Demo board/.test(await tv.locator('#bar-topic').innerText()));
const reqs = JSON.parse(fs.readFileSync('test/e2e/out/ai-requests.json', 'utf8'));
const first = reqs[0].body;
ok('request uses claude-haiku-5-5', first.model === 'claude-haiku-5-5', first.model);
ok('request asks for structured JSON output', first.output_config && first.output_config.format && first.output_config.format.type === 'json_schema', JSON.stringify(first.output_config).slice(0, 120));
ok('request sets low effort for speed', first.output_config.effort === 'low');
ok('request sends the API key and version header', /test-key/.test(reqs[0].headers.auth || '') && !!reqs[0].headers['anthropic-version']);
ok('the retry tells the model what was wrong', reqs.length >= 2 && /gives away the answer/.test(JSON.stringify(reqs[1].body.messages)));
ok('topic and age reach the prompt', /the ocean/.test(JSON.stringify(first.messages)));

await backToSetup();
await tv.click('#size-seg [data-size="4x4"]');
await tv.fill('#age', '8-10');
ok('board 2 (quick 4x4) generates', await generate('space') === 's-board');
ok('quick AI board has 16 tiles', await tv.locator('#grid .tile').count() === 16);
const last = JSON.parse(fs.readFileSync('test/e2e/out/ai-requests.json', 'utf8')).at(-1).body;
ok('quick board asks for 4 categories of 4', /Categories: 4/.test(JSON.stringify(last.messages)) && /Clues per category: 4/.test(JSON.stringify(last.messages)));
ok('age range reaches the prompt', /8-10/.test(JSON.stringify(last.messages)));
const m2 = JSON.stringify(last.messages);
ok('ages 8-10 use the kids band and its clue length', /Kids\\" band/.test(m2) && /under 110 characters/.test(m2), m2.slice(0, 300));
ok('kids band asks for its default styles only', /- Describe it:/.test(m2) && /- Extra hints:/.test(m2) && !/- Before & After:/.test(m2));

await backToSetup();
await tv.fill('#age', 'adults');
await tv.waitForTimeout(800);
await tv.click('#tune summary');
ok('typing adults re-ticks the boxes for adults', await tv.locator('#style-checks input[data-style="beforeafter"]').isChecked() && !(await tv.locator('#style-checks input[data-style="hints"]').isChecked()));
await tv.click('#style-checks input[data-style="rhyme"]');
await tv.click('#style-checks input[data-style="hints"]');
await tv.click('#level-seg [data-level="1"]');
await tv.waitForTimeout(500);
ok('fine tune summary updates', /Adults, harder/.test(await tv.locator('#tune-sum').innerText()), await tv.locator('#tune-sum').innerText());
await tv.fill('#age', 'adults 25+');
await tv.waitForTimeout(800);
ok('editing the age within the same band keeps the fine tuning', await tv.locator('#style-checks input[data-style="hints"]').isChecked() && !(await tv.locator('#style-checks input[data-style="rhyme"]').isChecked()));
await tv.reload();
await tv.click('#resume');
await tv.waitForSelector('#s-setup.on');
await tv.waitForTimeout(500);
ok('fine tuning survives a TV reload', await tv.locator('#style-checks input[data-style="hints"]').isChecked() && await tv.locator('#level-seg [data-level="1"][aria-checked="true"]').count() === 1);
ok('board 3 generates', await generate('castles') === 's-board');
const m3 = JSON.stringify(JSON.parse(fs.readFileSync('test/e2e/out/ai-requests.json', 'utf8')).at(-1).body.messages);
ok('the ticked boxes and difficulty reach the prompt', /notch harder/.test(m3) && /- Extra hints:/.test(m3) && !/- Rhyme time:/.test(m3) && /Adults\\" band/.test(m3), m3.slice(0, 400));
await backToSetup();
await generate('one too many');
const err = await tv.locator('#setup-err').innerText();
ok('the daily limit stops board 4 with a friendly message', /boards for today/.test(err), err);
ok('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} AI checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
