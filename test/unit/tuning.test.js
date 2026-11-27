import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAge, bandFor, defaultTune, cleanTune, audiencePrompt, STYLE_IDS } from '../../public/js/tuning.js';
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
  assert.match(kid, /notch easier/);
  assert.match(kid, /Describe it:/);
  assert.doesNotMatch(kid, /- Before & After:/);
  assert.match(kid, /Do not use these styles: .*Before & After/);
  const adult = userPrompt({ topic: 'space', age: '', size: '6x5', tune: { level: 1, styles: ['beforeafter'] } });
  assert.match(adult, /"Adults" band/);
  assert.match(adult, /notch harder/);
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
