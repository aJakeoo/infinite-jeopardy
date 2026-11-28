// Difficulty eval, step 1: makes one real board per level on the same topic and writes a blind rating sheet.
// Usage: node test/e2e/levels.mjs <base url> [topic] [band]   (makes 4 real AI boards)
// Writes test/e2e/out/levels-boards.json (answer key) and test/e2e/out/levels-blind.txt (shuffled clues, no level or row).
// Rate each blind line as the percent of the audience who would get it, in test/e2e/out/levels-ratings.txt ("id pct" per line),
// then run test/e2e/levels-score.mjs.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2], TOPIC = process.argv[3] || 'space', BAND = process.argv[4] || 'adults';
if (!BASE) { console.log('Usage: node test/e2e/levels.mjs <base url> [topic] [band]'); process.exit(2); }
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-quic'] });
const boards = {};
for (const level of [-1, 0, 1, 2]) {
  const tv = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await tv.goto(BASE + '/'); await tv.click('#start'); await tv.waitForSelector('#s-setup.on');
  await tv.click('#ages-btn'); await tv.check(`#age-checks input[data-band="${BAND}"]`); await tv.click('#ages-btn');
  await tv.click(`#level-seg [data-level="${level}"]`); await tv.waitForTimeout(800);
  await tv.fill('#topic', TOPIC); await tv.click('#make');
  const t0 = Date.now();
  await tv.waitForSelector('#s-generating.on', { timeout: 15000 }).catch(() => {});
  await tv.waitForFunction(() => !document.querySelector('#s-generating.on'), null, { timeout: 330000 }).catch(() => {});
  const code = await tv.evaluate(() => document.getElementById('menu-board-code')?.textContent || '');
  let j; for (let i = 0; i < 5 && !j && code; i++) j = await fetch(BASE + '/api/boards/' + code).then((r) => r.json()).catch(() => null);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!j || !j.board) { console.log(`level ${level}: no board after ${secs}s (${await tv.locator('#setup-err').innerText().catch(() => '')})`); continue; }
  boards[level] = j.board;
  console.log(`level ${level}: "${j.board.title}" in ${secs}s, stats ${JSON.stringify(j.board.stats)}`);
  await tv.context().close();
}
await browser.close();
fs.mkdirSync('test/e2e/out', { recursive: true });
fs.writeFileSync('test/e2e/out/levels-boards.json', JSON.stringify({ topic: TOPIC, band: BAND, boards }, null, 2));
// blind sheet: every clue, shuffled, with only a random id
const items = [];
for (const [level, b] of Object.entries(boards)) b.categories.forEach((c, ci) => c.clues.forEach((x, r) => items.push({ level: Number(level), ci, r, cat: c.name, clue: x.clue, response: x.response })));
for (let i = items.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [items[i], items[k]] = [items[k], items[i]]; }
items.forEach((it, i) => (it.id = i + 1));
fs.writeFileSync('test/e2e/out/levels-key.json', JSON.stringify(items, null, 2));
fs.writeFileSync('test/e2e/out/levels-blind.txt', items.map((it) => `${it.id}. ${it.clue} -> ${it.response}`).join('\n') + '\n');
console.log(`${items.length} clues written to test/e2e/out/levels-blind.txt`);
