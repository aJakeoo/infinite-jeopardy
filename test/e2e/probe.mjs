// Live probe: makes one real AI board on a deployed site and prints it. Usage: node test/e2e/probe.mjs <url> [band|none] [topic]
import { chromium } from 'playwright-core';
const BASE = process.argv[2], AGE = process.argv[3] || 'adults', TOPIC = process.argv[4] || 'space';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const tv = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
await tv.goto(BASE + '/'); await tv.click('#start'); await tv.waitForSelector('#s-setup.on');
await tv.click('#ages-btn'); if (AGE !== 'none') await tv.check(`#age-checks input[data-band="${AGE}"]`); await tv.click('#ages-btn');
await tv.waitForTimeout(800);
await tv.fill('#topic', TOPIC); await tv.click('#make');
const t0 = Date.now();
await tv.waitForFunction(() => document.querySelector('#s-generating.on') || document.getElementById('setup-err').innerText, null, { timeout: 15000 }).catch(() => {});
await tv.waitForTimeout(500);
await tv.waitForFunction(() => ['s-board', 's-setup'].includes(document.querySelector('.screen.on')?.id) && !document.querySelector('#s-generating.on'), null, { timeout: 150000 }).catch(() => {});
console.log('screen', await tv.evaluate(() => document.querySelector('.screen.on')?.id), ((Date.now() - t0) / 1000).toFixed(1) + 's', 'err:', await tv.locator('#setup-err').innerText().catch(() => ''));
const code = await tv.evaluate(() => document.getElementById('menu-board-code')?.textContent || '');
if (code) { const j = await (await fetch(BASE + '/api/boards/' + code)).json(); const bd = j.board; console.log('  title:', bd.title); for (const c of bd.categories) console.log('  [' + c.name + '] ' + c.clues.map((x) => x.clue.length).join('/') + ' chars | $200: ' + c.clues[0].clue + ' -> ' + c.clues[0].response + ' | top: ' + c.clues.at(-1).clue + ' -> ' + c.clues.at(-1).response); console.log('  FINAL: ' + bd.final.clue + ' -> ' + bd.final.response); }
await b.close();
