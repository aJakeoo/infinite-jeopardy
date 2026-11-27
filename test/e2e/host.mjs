// Host phone QA: the host can set up and run a whole game without touching the TV.
// Usage: node test/e2e/host.mjs [baseUrl]   (needs `npm run dev` running)
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const results = [];
const ok = (name, cond, detail = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? `  (${detail})` : ''}`); };
const errors = [];
fs.mkdirSync('test/e2e/out', { recursive: true });

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
ok('host phone shows the setup controls', await host.locator('#hs-topic').count() === 1 && await host.locator('#hs-make').count() === 1);

const players = [];
for (const name of ['Ana', 'Ben', 'Cy']) {
  const p = await page(PHONE);
  await p.goto(`${BASE}/play?room=${creds.code}`);
  await p.fill('#name', name);
  await p.click('#join-btn');
  await p.waitForSelector('#v-game:not([hidden])');
  players.push(p);
}
await host.waitForFunction(() => document.querySelectorAll('#hs-players .pchip').length === 3, null, { timeout: 5000 }).catch(() => {});
ok('host sees everyone who joined', await host.locator('#hs-players .pchip').count() === 3);

// ages from the host show up on the TV
await host.check('#hs-ages input[data-band="kids"]');
await tv.waitForFunction(() => document.getElementById('ages-sum').textContent === 'Kids', null, { timeout: 5000 }).catch(() => {});
ok('ticking an age band on the host updates the TV', (await tv.locator('#ages-sum').textContent()) === 'Kids', await tv.locator('#ages-sum').textContent());
await host.waitForFunction(() => document.querySelector('#hs-styles input[data-style="describe"]').checked, null, { timeout: 5000 }).catch(() => {});
ok('the kids band pre-ticks its styles on the host', await host.locator('#hs-styles input[data-style="describe"]').isChecked());
await host.fill('#hs-other', '40');
await tv.waitForFunction(() => /40/.test(document.getElementById('ages-sum').textContent), null, { timeout: 5000 }).catch(() => {});
ok('the Other ages box on the host reaches the TV', /Kids, 40/.test(await tv.locator('#ages-sum').textContent()), await tv.locator('#ages-sum').textContent());

await host.click('#hs-level [data-level="1"]');
await tv.waitForFunction(() => document.querySelector('#level-seg [data-level="1"]').getAttribute('aria-checked') === 'true', null, { timeout: 5000 }).catch(() => {});
ok('difficulty from the host shows on the TV', await tv.locator('#level-seg [data-level="1"][aria-checked="true"]').count() === 1);
await host.click('.htune summary');
await host.click('#hs-styles input[data-style="rhyme"]');
await tv.waitForFunction(() => document.querySelector('#style-checks input[data-style="rhyme"]').checked, null, { timeout: 5000 }).catch(() => {});
ok('question styles from the host show on the TV', await tv.locator('#style-checks input[data-style="rhyme"]').isChecked());

await host.click('#hs-size [data-size="4x4"]');
await host.click('#hs-mode [data-mode="teams"]');
await host.waitForSelector('#hs-teams-w:not([hidden])');
await host.click('#hs-teams [data-teams="3"]');
await tv.waitForFunction(() => document.querySelector('#size-seg [data-size="4x4"]').getAttribute('aria-checked') === 'true' && document.querySelector('#teams-seg [data-teams="3"]').getAttribute('aria-checked') === 'true', null, { timeout: 5000 }).catch(() => {});
ok('board size, teams mode and team count from the host reach the TV', await tv.locator('#teams-seg [data-teams="3"][aria-checked="true"]').count() === 1);
await host.click('#hs-mode [data-mode="solo"]');

// remove a player from the host (two taps)
await host.click('#hs-players .pchip:has-text("Cy") .x');
await host.click('#hs-players .pchip:has-text("Cy") .x');
await tv.waitForFunction(() => !/Cy/.test(document.getElementById('join-card').innerText), null, { timeout: 5000 }).catch(() => {});
ok('host can remove a player before the game', !/Cy/.test(await tv.locator('#join-card').innerText()));
await host.screenshot({ path: 'test/e2e/out/host-setup.png', fullPage: true });

// dice + make the board from the host
await host.click('#hs-dice');
ok('host dice fills in a topic', (await host.locator('#hs-topic').inputValue()).length > 2);
await host.fill('#hs-topic', 'the ocean');
await host.click('#hs-make');
await tv.waitForSelector('#s-board.on', { timeout: 30000 });
ok('host can make the board', await tv.locator('#grid .tile').count() === 16);

// run a clue entirely from the host
await host.waitForSelector('[data-pick]');
const pick = host.locator('.hboard button[data-pick]:not(.dd):not([disabled])').first();
await pick.click();
await tv.waitForSelector('#s-clue.on');
await host.click('[data-h="open"]');
await players[0].waitForSelector('#pad.live', { timeout: 5000 });
await players[0].dispatchEvent('#pad', 'pointerdown');
await host.waitForSelector('[data-h="judge1"]', { timeout: 5000 });
await host.click('[data-h="reveal"]');
await tv.waitForSelector('#answer:not([hidden])', { timeout: 5000 });
ok('host reveals the answer on the TV', await tv.locator('#answer:not([hidden])').count() === 1);
await host.click('[data-h="judge1"]');
await host.waitForSelector('[data-h="continue"]', { timeout: 5000 });
ok('host judges correct and the score moves', /\$[1-9]/.test(await tv.locator('#clue-status, #answer').allInnerTexts().then((x) => x.join(' '))));
await host.click('[data-h="continue"]');
await tv.waitForSelector('#s-board.on');
ok('host sends everyone back to the board', true);

ok('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} host checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
