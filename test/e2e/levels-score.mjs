// Difficulty eval, step 2: scores blind ratings against the levels and rows the clues came from.
// Usage: node test/e2e/levels-score.mjs   (after test/e2e/levels.mjs and filling test/e2e/out/levels-ratings.txt)
import fs from 'node:fs';
import { ladder, LEVELS } from '../../public/js/tuning.js';

const key = JSON.parse(fs.readFileSync('test/e2e/out/levels-key.json', 'utf8'));
const rated = new Map(fs.readFileSync('test/e2e/out/levels-ratings.txt', 'utf8').trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number)));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const levels = [...new Set(key.map((k) => k.level))].sort((a, b) => a - b);
const rows = Math.max(...key.map((k) => k.r)) + 1;
const r0 = (x) => String(Math.round(x)).padStart(3);

console.log('Average percent who would get it (blind rating), target in brackets, spread (sd) across categories after the slash\n');
console.log('level        ' + Array.from({ length: rows }, (_, r) => `row ${r + 1}       `).join('') + 'board  inversions');
const summary = {};
for (const lv of levels) {
  const tgt = ladder(lv, rows);
  const cells = [];
  for (let r = 0; r < rows; r++) {
    const v = key.filter((k) => k.level === lv && k.r === r).map((k) => rated.get(k.id));
    cells.push({ m: mean(v), s: sd(v), t: tgt[r] });
  }
  // inversions: within a category, a clue rated easier than the one above it by more than 10 points
  let inv = 0, pairs = 0;
  for (const ci of new Set(key.filter((k) => k.level === lv).map((k) => k.ci))) {
    const col = key.filter((k) => k.level === lv && k.ci === ci).sort((a, b) => a.r - b.r).map((k) => rated.get(k.id));
    for (let r = 1; r < col.length; r++) { pairs++; if (col[r] > col[r - 1] + 10) inv++; }
  }
  const all = key.filter((k) => k.level === lv).map((k) => rated.get(k.id));
  summary[lv] = { mean: mean(all), rowSd: mean(cells.map((c) => c.s)), inv, pairs, cells };
  console.log(`${LEVELS[lv].padEnd(12)} ` + cells.map((c) => `${r0(c.m)} [${r0(c.t)}]/${r0(c.s)} `).join('') + ` ${r0(mean(all))}   ${inv}/${pairs}`);
}
const order = levels.every((lv, i) => i === 0 || summary[lv].mean < summary[levels[i - 1]].mean);
console.log(`\nLevels in order of difficulty: ${order ? 'yes' : 'NO'}`);
for (let i = 1; i < levels.length; i++) console.log(`  ${LEVELS[levels[i - 1]]} -> ${LEVELS[levels[i]]}: ${Math.round(summary[levels[i - 1]].mean - summary[levels[i]].mean)} points harder`);
const big = key.map((k) => ({ ...k, got: rated.get(k.id), want: ladder(k.level, rows)[k.r] })).filter((k) => Math.abs(k.got - k.want) >= 35);
console.log(`\nClues 35+ points off their row target: ${big.length} of ${key.length}`);
for (const k of big.sort((a, b) => a.level - b.level || a.r - b.r)) console.log(`  ${LEVELS[k.level]}, row ${k.r + 1} (target ${k.want}%, rated ${k.got}%): ${k.response}  [${k.cat}]`);
