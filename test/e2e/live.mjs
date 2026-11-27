// Live QA: buzz line with four phones, the TV following the host, and real Haiku boards for two age bands.
// Usage: node test/e2e/live.mjs https://your-site   (makes 2 real AI boards)
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2];
if (!BASE) { console.log('Usage: node test/e2e/live.mjs <base url>'); process.exit(2); }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const results = [], errors = [];
const ok = (name, cond, detail = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? `  (${detail})` : ''}`); };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = async (opts) => { const p = await (await browser.newContext(opts)).newPage(); p.on('pageerror', (e) => errors.push(e.message)); return p; };

const tv = await page({ viewport: { width: 1600, height: 900 } });
await tv.goto(BASE + '/');
await tv.click('#start');
await tv.waitForSelector('#s-setup.on');
const creds = await tv.evaluate(() => JSON.parse(localStorage.getItem('ij-tv')));
const host = await page(PHONE);
await host.goto(`${BASE}/play?room=${creds.code}&role=host&key=${encodeURIComponent(creds.hostKey)}`);
await host.waitForSelector('#hs-form');
const names = ['Ava', 'Johnny', 'Cy', 'Dee'];
const ps = [];
for (const n of names) {
  const p = await page(PHONE);
  await p.goto(`${BASE}/play?room=${creds.code}`);
  await p.fill('#name', n); await p.click('#join-btn');
  await p.waitForSelector('#v-game:not([hidden])');
  ps.push(p);
}

async function realBoard(label, band, topic) {
  if (band) await host.check(`#hs-ages input[data-band="${band}"]`);
  await host.fill('#hs-topic', topic);
  await host.waitForTimeout(600);
  const t0 = Date.now();
  await host.click('#hs-make');
  await tv.waitForSelector('#s-board.on', { timeout: 120000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  await host.waitForSelector('.hboard');
  const board = await host.evaluate(() => window.__ijState && window.__ijState.board);
  ok(`${label}: real board arrives (${secs} s)`, true);
  return { secs };
}

// expose state for the dump (read-only peek through the host's own view)
await host.evaluate(() => {});
const kid = await realBoard('kids 7-9', 'kids', 'space');
const title = await tv.locator('#bar-topic').innerText();
ok('kids board is not a demo board', !/Demo board/i.test(title), title);
fs.mkdirSync('test/e2e/out', { recursive: true });
await tv.screenshot({ path: 'test/e2e/out/live-board-kids.png' });

// play one clue with the buzz line, entirely from the host while the TV follows
const tile = host.locator('.hboard button[data-pick]:not(.dd):not([disabled])').first();
await tile.click();
await tv.waitForSelector('#s-clue.on', { timeout: 10000 });
ok('TV follows the host into the clue', await tv.locator('#s-clue.on').count() === 1);
const kidClue = await host.locator('.hcard .q').innerText();
const kidAns = await host.locator('.hcard .a').innerText();
await host.click('[data-h="open"]');
await ps[0].waitForSelector('#pad.live', { timeout: 10000 });
for (const p of ps) await p.dispatchEvent('#pad', 'pointerdown');
await tv.waitForSelector('.line .lchip', { timeout: 10000 }).catch(() => {});
const line = await tv.locator('.line .lchip').allInnerTexts();
ok('TV shows the buzz line (top 4)', line.length === 4, line.join(' | '));
const first = (await tv.locator('.buzzer-name').innerText()).trim();
await host.click('[data-h="judge0"]');
await tv.waitForFunction((f) => document.querySelector('.buzzer-name') && document.querySelector('.buzzer-name').innerText.trim() !== f, first, { timeout: 10000 }).catch(() => {});
const second = (await tv.locator('.buzzer-name').innerText()).trim();
ok('a wrong answer passes straight to the next in line', second && second !== first, `${first} -> ${second}`);
const pick = names.find((n) => n !== first && n !== second);
await host.click(`.qrow:has-text("${pick}")`);
await tv.waitForFunction((n) => document.querySelector('.buzzer-name') && document.querySelector('.buzzer-name').innerText.trim() === n, pick, { timeout: 10000 }).catch(() => {});
ok('tapping a name on the host switches who answers on the TV', (await tv.locator('.buzzer-name').innerText()).trim() === pick);
await host.click('[data-h="judge1"]');
await host.waitForSelector('[data-h="continue"]', { timeout: 10000 });
const scores = await host.locator('.adj').innerText();
ok('the tapped player gets the points and the first loses them', new RegExp(`${pick}\\s*\\$\\d`).test(scores) && new RegExp(`${first}\\s*[−-]\\$`).test(scores), scores.replace(/\s+/g, ' '));
await host.click('[data-h="continue"]');
await tv.waitForSelector('#s-board.on');

// adults board for comparison
await host.click('#menu-btn');
await host.click('[data-m="new"]');
await host.waitForSelector('#hs-form');
await host.uncheck('#hs-ages input[data-band="kids"]');
await host.check('#hs-ages input[data-band="adults"]');
await host.waitForTimeout(800);
await realBoard('adults', null, 'space');
await tv.screenshot({ path: 'test/e2e/out/live-board-adults.png' });
const t2 = host.locator('.hboard button[data-pick]:not(.dd):not([disabled])').nth(4);
await t2.click();
await tv.waitForSelector('#s-clue.on', { timeout: 10000 });
const adultClue = await host.locator('.hcard .q').innerText();
const adultAns = await host.locator('.hcard .a').innerText();
console.log(`\nKids $200 clue:   ${kidClue}\n  ${kidAns.replace(/\s+/g, ' ')}\nAdults clue:      ${adultClue}\n  ${adultAns.replace(/\s+/g, ' ')}`);
ok('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} live checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
