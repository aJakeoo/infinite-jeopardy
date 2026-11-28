// A player becomes the host from the phone menu: straight away when no host phone is connected,
// and only with the host's yes when one is.
// Usage: node test/e2e/handoff.mjs [baseUrl]   (needs `npm run dev` running)
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const results = [], errors = [];
const ok = (name, cond, detail = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? `  (${detail})` : ''}`); };
fs.mkdirSync('test/e2e/out', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const page = async (opts) => { const p = await (await browser.newContext(opts)).newPage(); p.on('pageerror', (e) => errors.push(e.message)); return p; };
const menu = async (p, item) => { await p.click('#menu-btn'); await p.click(`[data-m="${item}"]`); };

const tv = await page({ viewport: { width: 1600, height: 900 } });
await tv.goto(BASE + '/'); await tv.click('#start'); await tv.waitForSelector('#s-setup.on');
const { code } = await tv.evaluate(() => JSON.parse(localStorage.getItem('ij-tv')));
const join = async (name) => {
  const p = await page(PHONE);
  await p.goto(`${BASE}/play?room=${code}`);
  await p.fill('#name', name); await p.click('#join-btn');
  await p.waitForSelector('#v-game:not([hidden])');
  return p;
};
const ava = await join('Ava');
const johnny = await join('Johnny');

// 1. No host phone yet: Ava takes it straight away
await menu(ava, 'host-ask');
await ava.waitForSelector('[data-m="host-claim"]');
ok('the menu explains that the new host stops playing', /stop playing/.test(await ava.locator('#sheet-card').innerText()));
await ava.screenshot({ path: 'test/e2e/out/handoff-1-confirm.png' });
await ava.click('[data-m="host-claim"]');
await ava.waitForURL(/role=host/, { timeout: 8000 }).catch(() => {});
await ava.waitForSelector('#hs-form', { timeout: 8000 }).catch(() => {});
ok('with no host connected, the player becomes the host right away', await ava.locator('#hs-form').count() === 1 && /role=host/.test(ava.url()));
await tv.waitForTimeout(800);
ok('the new host leaves the player list', !/Ava/.test(await tv.locator('#s-setup').innerText()));

// 2. Ava is hosting now: Johnny has to ask, and Ava can say no
await menu(johnny, 'host-ask');
await johnny.click('[data-m="host-claim"]');
await ava.waitForSelector('[data-m="host-yes"]', { timeout: 8000 }).catch(() => {});
ok('the host is asked when someone else wants to host', /Johnny wants to host/.test(await ava.locator('#sheet-card').innerText().catch(() => '')));
await ava.screenshot({ path: 'test/e2e/out/handoff-2-host-asked.png' });
await ava.click('[data-m="host-no"]');
await johnny.waitForSelector('.toast-p:has-text("said no")', { timeout: 8000 }).catch(() => {});
ok('a no is shown to the player, who stays a player', await johnny.locator('.toast-p:has-text("said no")').count() > 0 && !/role=host/.test(johnny.url()));

// 3. Johnny asks again and Ava hands it over
await menu(johnny, 'host-ask');
await johnny.click('[data-m="host-claim"]');
await ava.waitForSelector('[data-m="host-yes"]', { timeout: 8000 });
await ava.click('[data-m="host-yes"]');
await johnny.waitForSelector('#hs-form', { timeout: 8000 }).catch(() => {});
ok('after a yes the player becomes the host', await johnny.locator('#hs-form').count() === 1 && /role=host/.test(johnny.url()));
await ava.waitForURL(/handed=1/, { timeout: 8000 }).catch(() => {});
ok('the old host is sent to the join screen to play', /handed=1/.test(ava.url()) && /handed the game over/.test(await ava.locator('body').innerText()));
await ava.screenshot({ path: 'test/e2e/out/handoff-3-old-host.png' });

// 4. a player cannot answer a host request
const r = await tv.evaluate(async (c) => {
  const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/api/rooms/${c}/ws?role=player&pid=intruder12345`);
  await new Promise((res) => (ws.onopen = res));
  const got = new Promise((res) => (ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'ack') res(m); }));
  ws.send(JSON.stringify({ t: 'host-answer', pid: 'x', yes: true, rid: 1 }));
  const m = await got; ws.close(); return m;
}, code);
ok('only the host can answer a host request', r.ok === false && !r.key);
ok('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} handoff checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
