import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAge, bandFor, defaultTune, cleanTune, audiencePrompt, STYLE_IDS } from '../../public/js/tuning.js';
import * as TUNING from '../../public/js/tuning.js';
import { validateBoard, userPrompt } from '../../src/boards.js';
import * as G from '../../src/game.js';

test('ages map to the youngest player and the right band', () => {
  const cases = [['', null, 'adults'], ['4-5', 4, 'little'], ['8-10', 8, 'kids'], ['10-12', 10, 'tweens'], ['teens', 15, 'teens'],
    ['13+', 13, 'teens'], ['adults', 25, 'adults'], ['18-21', 18, 'adults'], ['family', 8, 'kids'], ['preschool', 4, 'little'], ['grandparents', 25, 'adults']];
  for (const [t, age, band] of cases) {
    assert.equal(parseAge(t), age, t);
    assert.equal(bandFor(t), band, t);
  }
});

test('each band pre-ticks sensible styles', () => {
  assert.ok(defaultTune('6').styles.includes('describe'));
  assert.ok(!defaultTune('6').styles.includes('beforeafter'));
  assert.ok(defaultTune('adults').styles.includes('wordplay'));
  assert.ok(!defaultTune('adults').styles.includes('beforeafter'), 'Before & After is opt-in');
  assert.ok(!defaultTune('15').styles.includes('rhyme'), 'Rhyme time is opt-in');
  assert.ok(!defaultTune('adults').styles.includes('hints'));
  assert.equal(defaultTune('').level, 0);
  for (const a of ['5', '8', '11', '15', '30']) assert.ok(defaultTune(a).styles.includes('facts'));
});

test('tune input is cleaned', () => {
  assert.deepEqual(cleanTune({ level: 7, styles: ['bogus', 'rhyme', 'facts'] }, ''), { level: 0, styles: ['facts', 'rhyme'] });
  assert.deepEqual(cleanTune({ level: -1, styles: [] }, ''), { level: -1, styles: [] });
  assert.deepEqual(cleanTune(null, '8'), defaultTune('8'));
  assert.deepEqual(cleanTune('junk', '8'), defaultTune('8'));
});

test('the prompt carries the band, level and only the ticked styles', () => {
  const kid = userPrompt({ topic: 'space', age: '7-9', size: '4x4', tune: { level: -1, styles: ['facts', 'describe'] } });
  assert.match(kid, /"Kids" band/);
  assert.match(kid, /under 110 characters/);
  assert.match(kid, /EASIER/);
  assert.match(kid, /Describe it:/);
  assert.doesNotMatch(kid, /- Before & After:/);
  assert.match(kid, /Do not use these styles: .*Before & After/);
  const adult = userPrompt({ topic: 'space', age: '', size: '6x5', tune: { level: 1, styles: ['beforeafter'] } });
  assert.match(adult, /"Adults" band/);
  assert.match(adult, /HARDER/);
  assert.match(adult, /Calibration for adults/);
  assert.doesNotMatch(kid, /Calibration for adults/);
  assert.match(adult, /- Before & After:/);
  const none = audiencePrompt('', { level: 0, styles: [] });
  assert.match(none.text, /plain, direct clues/);
});

test('clue length limit follows the band', () => {
  const mk = (len) => ({ title: 't', categories: Array.from({ length: 4 }, (_, c) => ({ name: 'Cat ' + c, clues: Array.from({ length: 4 }, (_, r) => ({ clue: `Clue ${c}${r} `.padEnd(len, 'x'), response: `Answer ${c}${r}` })) })), final: { category: 'F', clue: 'A final clue here', response: 'Final thing' } });
  assert.ok(validateBoard(mk(140), '4x4', 160).board, 'adult board with 140-char clues is fine');
  const kid = validateBoard(mk(160), '4x4', 110);
  assert.equal(kid.board, null);
  assert.match(kid.hard[0], /under 110/);
  const slight = validateBoard(mk(120), '4x4', 110);
  assert.ok(slight.board, 'a little over is only a warning');
  assert.ok(slight.soft.length > 0);
});

test('room settings keep age and tune, and validate them', () => {
  const s = G.newRoom('ABCD', 0);
  assert.deepEqual(s.settings.tune, defaultTune(''));
  G.setSettings(s, { age: '7-9', tune: { level: 1, styles: ['facts', 'hints', 'nope'] } });
  assert.equal(s.settings.age, '7-9');
  assert.deepEqual(s.settings.tune, { level: 1, styles: ['facts', 'hints'] });
  G.setSettings(s, { size: '4x4' });
  assert.deepEqual(s.settings.tune, { level: 1, styles: ['facts', 'hints'] }, 'other settings leave the tune alone');
  assert.equal(G.view(s, 'tv').settings.tune.level, 1);
  assert.ok(STYLE_IDS.length >= 8);
});

test('difficulty ladder: one steady target per row, Extreme far below the rest', () => {
  const { ladder } = TUNING;
  assert.deepEqual(ladder(0, 5), [90, 76, 63, 49, 35]);
  assert.equal(ladder(0, 4).length, 4);
  for (const lv of [-1, 0, 1, 2]) {
    const l = ladder(lv, 5);
    for (let i = 1; i < l.length; i++) assert.ok(l[i] < l[i - 1], `level ${lv} climbs`);
  }
  assert.ok(ladder(2, 5)[0] < ladder(1, 5)[2], 'even the easiest Extreme row is harder than the middle of Harder');
  for (let r = 0; r < 5; r++) assert.ok(ladder(-1, 5)[r] > ladder(0, 5)[r] && ladder(0, 5)[r] > ladder(1, 5)[r] && ladder(1, 5)[r] > ladder(2, 5)[r], 'every row is harder at each level');
  assert.equal(cleanTune({ level: 2, styles: [] }, '').level, 2);
  assert.equal(TUNING.LEVELS['2'], 'Extreme');
});

test('the prompt carries the ladder, and Extreme asks for deep cuts', () => {
  const p = userPrompt({ topic: 'space', age: '', size: '6x5', tune: { level: 0, styles: ['facts'] } });
  assert.match(p, /Row 1 \(easiest\): about 90%/);
  assert.match(p, /Row 5 \(hardest\): about 35%/);
  assert.match(p, /set "known"/);
  assert.doesNotMatch(p, /EXTREME/);
  const x = userPrompt({ topic: 'space', age: '7-9', size: '4x4', tune: { level: 2, styles: ['facts'] } });
  assert.match(x, /EXTREME/);
  assert.match(x, /Row 4 \(hardest\): about 3%/);
  assert.match(x, /not adult-only/);
  assert.match(x, /under 110 characters/, 'kids reading limits still apply');
});

test('clues are put in order of how well known they are, and far-off clues are flagged', () => {
  const lad = TUNING.ladder(0, 4); // 90 72 53 35
  const mk = (ks) => ({ title: 't', categories: Array.from({ length: 4 }, (_, c) => ({ name: 'Cat ' + c, clues: ks.map((k, r) => ({ clue: `Clue number ${c}${r} here`, response: `Answer ${c}${r}`, known: k })) })), final: { category: 'F', clue: 'A final clue here', response: 'Final thing', known: 10 } });
  const v = validateBoard(mk([50, 90, 35, 70]), '4x4', 160, lad);
  assert.ok(v.board);
  assert.deepEqual(v.board.categories[0].clues.map((x) => x.response), ['What is Answer 01?', 'What is Answer 03?', 'What is Answer 00?', 'What is Answer 02?']);
  assert.equal(v.board.categories[0].known, undefined, 'ratings are not kept on the board');
  assert.equal(v.tuning.length, 0);
  const off = validateBoard(mk([95, 90, 85, 30]), '4x4', 160, lad);
  assert.ok(off.board, 'still playable');
  assert.equal(off.tuning.length, 4 * 1, 'row 3 is far too easy in every category');
  assert.match(off.tuning[0].msg, /#3: rated 85% known.*about 53%.*harder/);
  const noLadder = validateBoard(mk([50, 90, 35, 70]), '4x4', 160);
  assert.equal(noLadder.board.categories[0].clues[0].response, 'What is Answer 00?', 'no ladder, no reordering');
});
