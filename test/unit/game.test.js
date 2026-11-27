import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../../src/game.js';
import { demoBoard, validateBoard, DEMO_BOARDS, coreAnswer, generateBoard } from '../../src/boards.js';

const seq = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };
function room(size = '6x5', mode = 'solo') {
  const s = G.newRoom('ABCD', 0);
  G.setSettings(s, { size, mode });
  return s;
}
function withPlayers(s, names, now = 0) {
  names.forEach((n, i) => assert.equal(G.join(s, `pid${i}xxxxxx`, n, null, now).ok, true));
  return names.map((_, i) => `pid${i}xxxxxx`);
}
function boardNoDD(size = '6x5') {
  const b = demoBoard('1800s history', size);
  return b;
}
function start(s, size = '6x5') {
  G.setBoard(s, boardNoDD(size), 0, seq([0.99]));
  for (const c of s.board.categories) for (const cl of c.clues) cl.dd = false; // predictable tests
}
function openClue(s, c, r, now = 1000) {
  assert.equal(G.pick(s, c, r, now).ok, true);
  assert.equal(s.phase, 'reading');
  G.tick(s, s.current.openAt);
  assert.equal(s.phase, 'open');
  return s.current.openAt;
}

test('demo boards are valid for both sizes', () => {
  for (const b of DEMO_BOARDS) {
    for (const size of ['6x5', '4x4']) {
      const d = demoBoard(b.title, size);
      const v = validateBoard(d, size);
      assert.deepEqual(v.hard, [], `${b.title} ${size}: ${v.hard.join('; ')}`);
    }
  }
});

test('validateBoard catches leaks, duplicates and short boards', () => {
  const b = demoBoard('ocean', '4x4');
  const bad = structuredClone(b);
  bad.categories[0].clues[0].clue = 'This animal, the octopus, has eight arms and squirts ink.';
  bad.categories[1].clues[1].response = bad.categories[0].clues[1].response;
  bad.categories[2].clues.pop();
  const v = validateBoard(bad, '4x4');
  assert.equal(v.board, null);
  assert.ok(v.hard.some((h) => h.includes('gives away')));
  assert.ok(v.hard.some((h) => h.includes('same answer')));
  assert.ok(v.hard.some((h) => h.includes('needs 4')));
});

test('responses are normalised into question form', () => {
  const b = demoBoard('ocean', '4x4');
  b.categories[0].clues[0].response = 'octopus';
  const v = validateBoard(b, '4x4');
  assert.equal(v.board.categories[0].clues[0].response, 'What is octopus?');
  assert.equal(coreAnswer('Who is George Stephenson?'), 'George Stephenson');
  assert.equal(coreAnswer('What is the Pony Express?'), 'Pony Express');
});

test('no API key falls back to a demo board', async () => {
  const b = await generateBoard({}, { topic: 'ocean animals', age: '8', size: '4x4' });
  assert.equal(b.demo, true);
  assert.equal(b.categories.length, 4);
  assert.equal(b.categories[0].clues.length, 4);
  await assert.rejects(generateBoard({}, { topic: '  ', size: '6x5' }));
});

test('AI path: retries once with feedback, then accepts a valid board', async () => {
  const good = demoBoard('1800s', '6x5');
  const leaky = structuredClone(good);
  leaky.categories[0].clues[0].clue = 'George Stephenson built this.';
  const calls = [];
  const client = { messages: { parse: async (req) => { calls.push(req); return { stop_reason: 'end_turn', parsed_output: calls.length === 1 ? leaky : good }; } } };
  const b = await generateBoard({ ANTHROPIC_API_KEY: 'x' }, { topic: '1800s', size: '6x5' }, { client });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, 'claude-haiku-5-5');
  assert.match(calls[1].messages[0].content, /gives away/);
  assert.equal(b.demo, false);
});

test('AI path: refusal and errors become friendly messages', async () => {
  const refuse = { messages: { parse: async () => ({ stop_reason: 'refusal', parsed_output: null }) } };
  await assert.rejects(generateBoard({ ANTHROPIC_API_KEY: 'x' }, { topic: 'x', size: '6x5' }, { client: refuse }), /would not make a board/);
  const down = { messages: { parse: async () => { const e = new Error('rate'); e.status = 429; throw e; } } };
  await assert.rejects(generateBoard({ ANTHROPIC_API_KEY: 'x' }, { topic: 'x', size: '6x5' }, { client: down }), /busy/);
});

test('daily doubles: 2 on classic, 1 on quick, never in row 1, never same category', () => {
  for (let k = 0; k < 200; k++) {
    const b = demoBoard('1800s', '6x5');
    G.placeDailyDoubles(b);
    const dds = [];
    b.categories.forEach((c, ci) => c.clues.forEach((cl, ri) => cl.dd && dds.push([ci, ri])));
    assert.equal(dds.length, 2);
    assert.notEqual(dds[0][0], dds[1][0]);
    assert.ok(dds.every(([, r]) => r > 0));
    const q = demoBoard('ocean', '4x4'); G.placeDailyDoubles(q);
    assert.equal(q.categories.flatMap((c) => c.clues).filter((x) => x.dd).length, 1);
  }
});

test('join: names are cleaned, de-duplicated and capped', () => {
  const s = room();
  G.join(s, 'aaaaaaaaaa', '  Sam  ', null, 0);
  G.join(s, 'bbbbbbbbbb', 'sam', null, 0);
  G.join(s, 'cccccccccc', '<b>Very long name that goes on</b>', null, 0);
  const names = Object.values(s.players).map((p) => p.name);
  assert.deepEqual(names.slice(0, 2), ['Sam', 'sam 2']);
  assert.ok(!names[2].includes('<'));
  assert.ok(names[2].length <= 16);
  assert.equal(G.join(s, 'dddddddddd', '   ', null, 0).ok, false);
  for (let i = 0; i < 30; i++) G.join(s, `x${i}xxxxxxxxx`, `P${i}`, null, 0);
  assert.equal(Object.keys(s.players).length, G.LIMITS.PLAYERS);
});

test('full clue: reading -> open -> buzz -> correct, control passes', () => {
  const s = room(); const [a, b] = withPlayers(s, ['Ana', 'Ben']); start(s);
  const openAt = openClue(s, 0, 1);
  assert.equal(G.buzz(s, b, 300, 20, openAt + 320).ok, true);
  assert.equal(G.buzz(s, a, 200, 20, openAt + 330).ok, true); // later arrival, faster reaction: wins
  G.tick(s, openAt + 320 + G.T.BUZZ_WINDOW);
  assert.equal(s.phase, 'answering');
  assert.equal(s.current.winner, a);
  G.judge(s, true, openAt + 2000);
  assert.equal(s.players[a].score, 400);
  assert.equal(s.control, a);
  assert.equal(s.phase, 'reveal');
  G.continueGame(s, openAt + 3000);
  assert.equal(s.phase, 'board');
  assert.ok(s.used['0-1']);
  assert.equal(G.pick(s, 0, 1, 0).ok, false);
});

test('a fake 0ms reaction cannot beat physics', () => {
  const s = room(); const [a, b] = withPlayers(s, ['Ana', 'Ben']); start(s);
  const openAt = openClue(s, 0, 0);
  G.buzz(s, a, 150, 10, openAt + 160);
  G.buzz(s, b, 0, 10, openAt + 900); // claims instant, but arrived 900ms after open
  G.tick(s, openAt + 160 + G.T.BUZZ_WINDOW);
  assert.equal(s.current.winner, a);
});

test('early buzz gets a short penalty; buzz just before open counts', () => {
  const s = room(); const [a, b] = withPlayers(s, ['Ana', 'Ben']); start(s);
  G.pick(s, 1, 0, 1000);
  const openAt = s.current.openAt;
  assert.equal(G.buzz(s, a, 0, 0, openAt - 1000).reason, 'early');
  assert.equal(s.phase, 'reading');
  // b buzzes 100ms before the server opens (clock drift): accepted, buzzers open
  assert.equal(G.buzz(s, b, 5, 0, openAt - 100).ok, true);
  assert.equal(s.phase, 'open');
  // a's penalty ended long ago (250ms), so a can buzz
  assert.equal(G.buzz(s, a, 50, 0, openAt - 60).ok, true);
});

test('early buzz right before open blocks briefly', () => {
  const s = room(); const [a] = withPlayers(s, ['Ana']); start(s);
  G.pick(s, 1, 0, 1000);
  const openAt = s.current.openAt;
  G.buzz(s, a, 0, 0, openAt - 120); // within grace: counts as on time
  assert.equal(s.phase, 'open');
  const s2 = room(); const [x] = withPlayers(s2, ['X']); start(s2);
  G.pick(s2, 1, 0, 1000);
  const o2 = s2.current.openAt;
  assert.equal(G.buzz(s2, x, 0, 0, o2 - 200).reason, 'early');
  G.tick(s2, o2);
  assert.equal(G.buzz(s2, x, 10, 0, o2 + 10).reason, 'penalty');
  assert.equal(G.buzz(s2, x, 60, 0, o2 + 60).ok, true);
});

test('wrong answer: points lost, locked out, others can buzz, then timeout', () => {
  const s = room(); const [a, b] = withPlayers(s, ['Ana', 'Ben']); start(s);
  const openAt = openClue(s, 2, 2);
  G.buzz(s, a, 100, 0, openAt + 100); G.tick(s, openAt + 300);
  G.judge(s, false, openAt + 2000);
  assert.equal(s.players[a].score, -600);
  assert.equal(s.phase, 'open');
  assert.equal(G.buzz(s, a, 10, 0, openAt + 2100).reason, 'locked');
  G.tick(s, openAt + 2000 + G.T.REOPEN_MS + 1);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.current.revealed, true);
  assert.equal(s.players[b].score, 0);
});

test('everyone wrong ends the clue immediately', () => {
  const s = room(); const [a, b] = withPlayers(s, ['Ana', 'Ben']); start(s);
  const o = openClue(s, 0, 0);
  G.buzz(s, a, 100, 0, o + 100); G.tick(s, o + 300); G.judge(s, false, o + 400);
  G.buzz(s, b, 100, 0, o + 500); G.tick(s, o + 700); G.judge(s, false, o + 800);
  assert.equal(s.phase, 'reveal');
});

test('reveal first, then judge: wrong answer after reveal does not reopen buzzers', () => {
  const s = room(); const [a] = withPlayers(s, ['Ana', 'Ben']); start(s);
  const o = openClue(s, 0, 0);
  G.buzz(s, a, 100, 0, o + 100); G.tick(s, o + 300);
  G.reveal(s, o + 1000);
  assert.equal(s.phase, 'answering');
  assert.ok(G.view(s, 'tv').current.response);
  G.judge(s, false, o + 1100);
  assert.equal(s.phase, 'reveal');
});

test('nobody buzzes: time runs out', () => {
  const s = room(); withPlayers(s, ['Ana']); start(s);
  const o = openClue(s, 0, 0);
  assert.equal(G.nextWake(s), o + G.T.OPEN_MS);
  G.tick(s, o + G.T.OPEN_MS);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.current.result, 'timeout');
});

test('views hide answers from players and the TV until revealed', () => {
  const s = room(); const [a] = withPlayers(s, ['Ana']); start(s);
  openClue(s, 0, 0);
  const tv = G.view(s, 'tv'), pl = G.view(s, 'player', a), host = G.view(s, 'host');
  assert.equal(tv.current.response, null);
  assert.equal(pl.current.response, null);
  assert.ok(host.current.response);
  assert.equal(JSON.stringify(tv).includes(s.board.categories[3].clues[3].response), false);
  assert.equal(JSON.stringify(pl).includes(s.board.final.response), false);
  assert.ok(JSON.stringify(host).includes(s.board.categories[3].clues[3].response));
});

test('daily double: control player wagers within bounds and wins or loses it', () => {
  const s = room(); const [a, b] = withPlayers(s, ['Ana', 'Ben']); start(s);
  s.board.categories[3].clues[2].dd = true;
  // nobody has control yet: the leader (tie -> first) gets it
  assert.equal(G.pick(s, 3, 2, 0).ok, true);
  assert.equal(s.phase, 'dd-wager');
  const dde = s.current.ddEntity;
  assert.equal(G.wager(s, dde, 3, 0).ok, false);
  assert.equal(G.wager(s, dde, 1001, 0).ok, false); // max is $1000 when score is 0
  assert.equal(G.wager(s, dde === a ? b : a, 100, 0).ok, false);
  assert.equal(G.wager(s, dde, 1000, 0).ok, true);
  assert.equal(s.phase, 'dd-clue');
  assert.equal(G.buzz(s, b, 10, 0, 10).ok, false);
  G.judge(s, false, 100);
  assert.equal(s.players[dde].score, -1000);
});

test('daily double wager can go up to your score when it is high', () => {
  const s = room(); const [a] = withPlayers(s, ['Ana']); start(s);
  s.players[a].score = 3000; s.control = a;
  s.board.categories[0].clues[4].dd = true;
  G.pick(s, 0, 4, 0);
  assert.deepEqual(G.ddBounds(s, a), { min: 5, max: 3000 });
  assert.equal(G.wager(s, a, 3000, 0).ok, true);
  G.judge(s, true, 0);
  assert.equal(s.players[a].score, 6000);
});

test('teams: teammates share a score and a lockout', () => {
  const s = room('6x5', 'teams');
  G.join(s, 'aaaaaaaaaa', 'Ana', 't1', 0); G.join(s, 'bbbbbbbbbb', 'Ben', 't1', 0); G.join(s, 'cccccccccc', 'Cy', 't2', 0);
  start(s);
  const o = openClue(s, 0, 0);
  G.buzz(s, 'aaaaaaaaaa', 100, 0, o + 100); G.tick(s, o + 300);
  G.judge(s, false, o + 400);
  assert.equal(s.teams.t1.score, -200);
  assert.equal(G.buzz(s, 'bbbbbbbbbb', 10, 0, o + 500).reason, 'locked');
  G.buzz(s, 'cccccccccc', 10, 0, o + 500); G.tick(s, o + 700);
  G.judge(s, true, o + 800);
  assert.equal(s.teams.t2.score, 200);
  assert.equal(s.control, 't2');
});

test('teams: auto balance and team count changes', () => {
  const s = room('6x5', 'teams');
  for (let i = 0; i < 5; i++) G.join(s, `p${i}xxxxxxxx`, `P${i}`, null, 0);
  const counts = (n) => Object.values(s.players).filter((p) => p.team === n).length;
  assert.equal(counts('t1'), 3); assert.equal(counts('t2'), 2);
  G.setSettings(s, { teams: 3 });
  G.join(s, 'p9xxxxxxxx', 'New', null, 0);
  assert.equal(s.players.p9xxxxxxxx.team, 't3');
  G.setSettings(s, { teams: 2 });
  assert.ok(Object.values(s.players).every((p) => ['t1', 't2'].includes(p.team)));
});

test('final jeopardy: eligibility, wagers, answers, judging order', () => {
  const s = room('4x4'); const [a, b, c] = withPlayers(s, ['Ana', 'Ben', 'Cy']); start(s, '4x4');
  s.players[a].score = 1000; s.players[b].score = 400; s.players[c].score = -200;
  for (let ci = 0; ci < 4; ci++) for (let r = 0; r < 4; r++) s.used[`${ci}-${r}`] = true;
  delete s.used['3-3'];
  G.pick(s, 3, 3, 0); G.tick(s, s.current.openAt); G.reveal(s, 1); G.continueGame(s, 2);
  assert.equal(s.phase, 'final-wager');
  assert.deepEqual(s.final.eligible.sort(), [a, b].sort());
  assert.equal(G.wager(s, c, 0, 3).ok, false);
  assert.equal(G.wager(s, a, 1001, 3).ok, false);
  assert.equal(G.wager(s, a, 1000, 3).ok, true);
  assert.equal(s.phase, 'final-wager');
  assert.equal(G.view(s, 'player', b).final.clue, null);
  assert.equal(G.view(s, 'player', b).final.wagers[a], undefined);
  G.wager(s, b, 400, 4);
  assert.equal(s.phase, 'final-clue');
  G.finalAnswer(s, a, 'What is HMS Beagle?', 5);
  G.finalAnswer(s, b, 'beagle', 6);
  assert.equal(G.finalAnswer(s, c, 'x', 6).ok, false);
  G.tick(s, s.final.closesAt);
  assert.equal(s.phase, 'final-judge');
  assert.deepEqual(s.final.order, [b, a]);
  G.finalJudge(s, null, false, 7);
  assert.equal(s.players[b].score, 0);
  G.finalJudge(s, null, true, 8);
  assert.equal(s.players[a].score, 2000);
  assert.equal(s.phase, 'over');
});

test('final with nobody above $0 goes straight to game over', () => {
  const s = room('4x4'); withPlayers(s, ['Ana']); start(s, '4x4');
  G.startFinal(s, 0);
  assert.equal(s.phase, 'over');
});

test('final: missing wagers count as $0 when the TV shows the clue', () => {
  const s = room('4x4'); const [a, b] = withPlayers(s, ['Ana', 'Ben']); start(s, '4x4');
  s.players[a].score = 500; s.players[b].score = 500;
  G.startFinal(s, 0);
  G.wager(s, a, 500, 1);
  G.showFinalClue(s, 2);
  assert.equal(s.final.wagers[b], 0);
  G.stopFinal(s, 3);
  G.finalJudge(s, null, true, 4); G.finalJudge(s, null, true, 5);
  assert.equal(s.players[a].score + s.players[b].score, 1500);
});

test('kicking the player who is answering moves the game on', () => {
  const s = room(); const [a, b] = withPlayers(s, ['Ana', 'Ben']); start(s);
  const o = openClue(s, 0, 0);
  G.buzz(s, a, 100, 0, o + 100); G.tick(s, o + 300);
  G.removePlayer(s, a, o + 400);
  assert.equal(s.phase, 'open');
  assert.equal(s.players[a], undefined);
  G.buzz(s, b, 100, 0, o + 500); G.tick(s, o + 700);
  assert.equal(s.current.winner, b);
});

test('disconnected players cannot hold up a clue they cannot buzz on', () => {
  const s = room(); const [a, b] = withPlayers(s, ['Ana', 'Ben']); start(s);
  G.setConnected(s, b, false, 0);
  const o = openClue(s, 0, 0);
  G.buzz(s, a, 100, 0, o + 100); G.tick(s, o + 300); G.judge(s, false, o + 400);
  assert.equal(s.phase, 'reveal');
});

test('new game keeps players, resets scores; settings locked mid-game', () => {
  const s = room(); const [a] = withPlayers(s, ['Ana']); start(s);
  s.players[a].score = 800;
  assert.equal(G.setSettings(s, { size: '4x4' }).ok, false);
  G.newGame(s, 0);
  assert.equal(s.phase, 'setup');
  assert.equal(s.players[a].score, 0);
  assert.equal(G.setSettings(s, { size: '4x4' }).ok, true);
});

test('playing every clue of a 4x4 board ends in final', () => {
  const s = room('4x4'); const [a] = withPlayers(s, ['Ana']); start(s, '4x4');
  let t = 1000;
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    G.pick(s, c, r, t); G.tick(s, s.current.openAt); t = s.current.openAt;
    G.buzz(s, a, 100, 0, t + 100); G.tick(s, t + 300); G.judge(s, true, t + 400); G.continueGame(s, t + 500);
    t += 1000;
  }
  assert.equal(s.players[a].score, 4 * (200 + 400 + 600 + 800));
  assert.equal(s.phase, 'final-wager');
});

test('adjust validates input', () => {
  const s = room(); const [a] = withPlayers(s, ['Ana']);
  assert.equal(G.adjust(s, a, 200, 0).ok, true);
  assert.equal(G.adjust(s, a, 'abc', 0).ok, false);
  assert.equal(G.adjust(s, 'nobody', 200, 0).ok, false);
  assert.equal(s.players[a].score, 200);
});

test('buzz line: wrong answer passes to the next buzzer, who can win the points', () => {
  const s = room();
  const [a, b, c, d, e] = withPlayers(s, ['Ava', 'Johnny', 'Cy', 'Dee', 'Eve']);
  start(s);
  const open = openClue(s, 0, 0);
  for (const [i, p] of [a, b, c, d, e].entries()) G.buzz(s, p, 100 + i * 10, 0, open + 100 + i * 10);
  G.tick(s, open + 1000);
  assert.equal(s.phase, 'answering');
  assert.equal(s.current.winner, a);
  assert.deepEqual(s.current.queue, [a, b, c, d], 'only the top four line up');
  G.judge(s, false, open + 2000);
  assert.equal(s.phase, 'answering', 'no reopening while someone is still in line');
  assert.equal(s.current.winner, b);
  assert.equal(s.players[a].score, -200);
  G.judge(s, true, open + 3000);
  assert.equal(s.players[b].score, 200, 'the second buzzer gets the points');
  assert.equal(s.control, b);
});

test('buzz line: the host can tap any name, and late buzzes join the line', () => {
  const s = room();
  const [a, b, c] = withPlayers(s, ['Ava', 'Johnny', 'Cy']);
  start(s);
  const open = openClue(s, 0, 1);
  G.buzz(s, a, 100, 0, open + 100);
  G.tick(s, open + 500);
  assert.deepEqual(s.current.queue, [a]);
  assert.equal(G.buzz(s, c, 0, 0, open + 900).reason, 'queued', 'buzzing while Ava answers gets you in line');
  assert.deepEqual(s.current.queue, [a, c]);
  assert.equal(G.select(s, b, open + 1000).ok, true, 'host picks Johnny even though he never buzzed');
  assert.equal(s.current.winner, b);
  G.judge(s, false, open + 1100);
  assert.ok(s.current.lockedOut.includes(b));
  assert.equal(s.current.winner, a, 'back to the first in line who has not answered');
  assert.equal(G.select(s, b, open + 1200).ok, false, 'someone who already answered cannot be picked again');
  G.judge(s, false, open + 1300);
  assert.equal(s.current.winner, c);
  G.judge(s, false, open + 1400);
  assert.equal(s.phase, 'reveal', 'everyone tried, so the clue ends');
  assert.equal(G.view(s, 'tv').current.queue.length, 3);
});

test('buzz line: selecting while buzzers are open starts the answer', () => {
  const s = room();
  const [a] = withPlayers(s, ['Ava', 'Ben']);
  start(s);
  openClue(s, 1, 0);
  assert.equal(G.select(s, a, 5000).ok, true);
  assert.equal(s.phase, 'answering');
  assert.equal(s.current.winner, a);
});
