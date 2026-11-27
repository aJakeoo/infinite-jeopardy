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
const page = async (opts) => { const p = await (await browser.newContext(opts)).newPage(); p.on('pageerror', (e) => errors.push(e.message + ' @ ' + (e.stack || '').split('\n').slice(0, 3).join(' / '))); return p; };
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

// the typed topic mirrors both ways
await host.fill('#hs-topic', 'volcanoes');
await tv.waitForFunction(() => document.getElementById('topic').value === 'volcanoes', null, { timeout: 5000 }).catch(() => {});
ok('topic typed on the host shows on the TV', (await tv.locator('#topic').inputValue()) === 'volcanoes', await tv.locator('#topic').inputValue());
await tv.fill('#topic', 'bridges');
await host.click('.hl >> nth=0');
await host.waitForFunction(() => document.getElementById('hs-topic').value === 'bridges', null, { timeout: 5000 }).catch(() => {});
ok('topic typed on the TV shows on the host', (await host.locator('#hs-topic').inputValue()) === 'bridges', await host.locator('#hs-topic').inputValue());

// scanning the TV's QR from inside the app (a fake camera shows the real code)
async function cameraPhone(svg) {
  const p = await page(PHONE);
  await p.addInitScript((svgText) => {
    navigator.mediaDevices.getUserMedia = async () => {
      const c = document.createElement('canvas'); c.width = 640; c.height = 480;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 480);
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText.replace('<svg ', '<svg width="360" height="360" '));
      await img.decode();
      const draw = () => { g.fillRect(0, 0, 640, 480); g.drawImage(img, 140, 60, 360, 360); requestAnimationFrame(draw); };
      draw();
      return c.captureStream(15);
    };
  }, svg);
  return p;
}
const joinSvg = await tv.locator('#join-card .qr svg').evaluate((el) => el.outerHTML);
const scanner = await cameraPhone(joinSvg);
await scanner.goto(BASE + '/play');
await scanner.fill('#name', 'Scanny');
await scanner.click('#scan-btn');
await scanner.waitForSelector('#v-game:not([hidden])', { timeout: 15000 }).catch(() => {});
await tv.waitForFunction(() => /Scanny/.test(document.getElementById('join-card').innerText), null, { timeout: 5000 }).catch(() => {});
ok('a player can join by scanning the TV QR inside the app', /Scanny/.test(await tv.locator('#join-card').innerText()));
await tv.click('#burger'); await tv.click('[data-overlay="host"]');
const hostSvg = await tv.locator('#ov .qr svg').evaluate((el) => el.outerHTML);
await tv.keyboard.press('Escape');
const hostScan = await cameraPhone(hostSvg);
await hostScan.goto(BASE + '/play');
await hostScan.click('#scan-btn');
await hostScan.waitForSelector('#hs-form', { timeout: 15000 }).catch(() => {});
ok('scanning the host QR inside the app opens the host controls', await hostScan.locator('#hs-form').count() === 1);
await hostScan.goto(BASE + '/play');
ok('the app offers to go back to hosting', /Back to hosting/.test(await hostScan.locator('#host-resume').innerText().catch(() => '')));
const man = await (await fetch(BASE + '/manifest-play.webmanifest')).json();
ok('the phone app manifest is served', man.display === 'standalone' && man.start_url === '/play' && man.icons.length >= 2);
const swOk = (await fetch(BASE + '/sw.js')).ok && (await fetch(BASE + '/icons/icon-512.png')).ok;
ok('service worker and icons are served', swOk);
ok('the phone registers its service worker', await scanner.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())));

// dice + make the board from the host
await host.click('#hs-dice');
ok('host dice fills in a topic', (await host.locator('#hs-topic').inputValue()).length > 2);
await host.fill('#hs-topic', 'the ocean');
await host.click('#hs-make');
const t0 = Date.now();
await tv.waitForSelector('#s-board.on', { timeout: 120000 });
console.log(`  (board took ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
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
