// Host phone, clue live: everything fits on one screen (no scrolling) on small and large phones,
// and tapping the highlighted name again unselects it.
// Usage: node test/e2e/hostfit.mjs [baseUrl]   (needs `npm run dev` running)
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const results = [];
const ok = (name, cond, detail = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? `  (${detail})` : ''}`); };
const errors = [];
fs.mkdirSync('test/e2e/out', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = async (opts) => { const p = await (await browser.newContext(opts)).newPage(); p.on('pageerror', (e) => errors.push(e.message)); return p; };
const phone = (width, height) => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

// Is the whole host screen visible with no scrolling, check and X included?
const fits = (host) => host.evaluate(() => {
  const st = document.getElementById('stagep');
  const vh = innerHeight;
  const inView = (sel) => [...document.querySelectorAll(sel)].every((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= vh + 1; });
  return { pageScroll: document.scrollingElement.scrollHeight <= vh + 1, stageScroll: st.scrollHeight <= st.clientHeight + 1, buttons: inView('.hbtns .btn'), names: inView('.qrow') };
});

for (const [w, h, count] of [[320, 568, 6], [375, 667, 4], [375, 667, 8], [390, 844, 8], [430, 932, 12]]) {
  const tv = await page({ viewport: { width: 1600, height: 900 } });
  await tv.goto(BASE + '/');
  await tv.click('#start');
  await tv.waitForSelector('#s-setup.on');
  const creds = await tv.evaluate(() => JSON.parse(localStorage.getItem('ij-tv')));
  const host = await page(phone(w, h));
  await host.goto(`${BASE}/play?room=${creds.code}&role=host&key=${encodeURIComponent(creds.hostKey)}`);
  await host.waitForSelector('#hs-form');
  const players = [];
  for (let i = 0; i < count; i++) {
    const p = await page(phone(390, 844));
    await p.goto(`${BASE}/play?room=${creds.code}`);
    await p.fill('#name', ['Ava', 'Johnny', 'Cy', 'Dee', 'Eli', 'Fran', 'Gus', 'Hana', 'Ivo', 'Jules', 'Kit', 'Lou'][i] + (i > 6 ? ' Longername' : ''));
    await p.click('#join-btn');
    await p.waitForSelector('#v-game:not([hidden])');
    players.push(p);
  }
  await host.fill('#hs-topic', 'the ocean');
  await host.click('#hs-make');
  await tv.waitForSelector('#s-board.on', { timeout: 120000 });
  await host.waitForSelector('[data-pick]');
  // a top-value clue, so the clue text is as long as it gets
  await host.locator('.hboard button[data-pick]:not(.dd):not([disabled])').last().click();
  await host.waitForSelector('[data-h="open"]');
  await host.click('[data-h="open"]');
  await players[0].waitForSelector('#pad.live', { timeout: 5000 });
  await players[0].dispatchEvent('#pad', 'pointerdown');
  await host.waitForSelector('[data-h="judge1"]', { timeout: 5000 });
  await players[2].dispatchEvent('#pad', 'pointerdown');
  await host.waitForTimeout(400);
  const tag = `${w}x${h}, ${count} players`;
  const f = await fits(host);
  ok(`${tag}: no page scroll`, f.pageScroll && f.stageScroll, JSON.stringify(f));
  ok(`${tag}: check, X and reveal are on screen`, f.buttons, JSON.stringify(f));
  ok(`${tag}: every name is on screen`, f.names, JSON.stringify(f));
  await host.screenshot({ path: `test/e2e/out/hostfit-${w}x${h}-${count}.png` });

  if (count === 4 && w === 375) {
    // accidental tap: Johnny was not in line; tap him, then tap him again
    const johnny = host.locator('.qrow', { hasText: 'Johnny' });
    await johnny.click();
    await host.waitForSelector('.qrow.on:has-text("Johnny")', { timeout: 3000 });
    ok('tapping a name highlights them', await host.locator('.qrow.on', { hasText: 'Johnny' }).count() === 1);
    await host.locator('.qrow.on', { hasText: 'Johnny' }).click();
    await host.waitForSelector('.qrow.on:has-text("Ava")', { timeout: 3000 }).catch(() => {});
    ok('tapping them again hands it back to the first in line', await host.locator('.qrow.on', { hasText: 'Ava' }).count() === 1 && await host.locator('.qrow.on', { hasText: 'Johnny' }).count() === 0);
    await tv.waitForFunction(() => /Ava/.test(document.getElementById('s-clue').textContent), null, { timeout: 3000 }).catch(() => {});
    ok('the TV follows the undo', /Ava/.test(await tv.locator('#s-clue').textContent()));
    // unselect everyone in line: buzzers open again
    await host.locator('.qrow.on').click();
    await host.waitForTimeout(300);
    await host.locator('.qrow.on').click();
    await host.waitForSelector('[data-h="reveal"]:has-text("Nobody knows")', { timeout: 3000 }).catch(() => {});
    ok('with nobody left in line the buzzers reopen', await host.locator('[data-h="reveal"]', { hasText: 'Nobody knows' }).count() === 1);
    await players[1].waitForSelector('#pad.live', { timeout: 3000 }).catch(() => {});
    ok('players can buzz again', await players[1].locator('#pad.live').count() === 1);
    await players[1].dispatchEvent('#pad', 'pointerdown');
    await host.waitForSelector('.qrow.on:has-text("Johnny")', { timeout: 3000 }).catch(() => {});
    ok('a new buzz picks the next answerer', await host.locator('.qrow.on', { hasText: 'Johnny' }).count() === 1);
    await host.click('[data-h="judge1"]');
    await host.waitForSelector('[data-h="continue"]', { timeout: 5000 });
    ok('scores come back on the reveal screen', await host.locator('.adj .row').count() === count);
  }
  await Promise.all([tv, host, ...players].map((p) => p.context().close()));
}
ok('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} host-fit checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
