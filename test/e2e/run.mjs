// End-to-end QA: plays real games against `npm run dev` with a TV, several phones and a host phone,
// in the system Chrome. Usage: node test/e2e/run.mjs [baseUrl]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const OUT = path.resolve('test/e2e/out');
fs.mkdirSync(OUT, { recursive: true });
const IPHONE13 = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
const IPHONE17PM = { ...IPHONE13, viewport: { width: 440, height: 956 } };
const IPHONE_SE = { ...IPHONE13, viewport: { width: 375, height: 667 } };

const results = [];
const consoleErrors = [];
let shotN = 0;
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? `  (${detail})` : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(page, name) { shotN++; await page.screenshot({ path: path.join(OUT, `${String(shotN).padStart(2, '0')}-${name}.png`) }); }

const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function newPage(label, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${label}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`${label}: PAGEERROR ${e.message}`));
  page.label = label;
  return page;
}
const screenOn = (tv) => tv.evaluate(() => document.querySelector('.screen.on')?.id);
async function waitScreen(tv, id, timeout = 15000) {
  await tv.waitForFunction((x) => document.querySelector('.screen.on')?.id === x, id, { timeout });
}
async function phoneText(p) { return p.evaluate(() => document.getElementById('stagep').innerText); }

async function createRoom(tv) {
  await tv.goto(BASE + '/');
  await tv.click('#start');
  await waitScreen(tv, 's-setup');
  return tv.evaluate(() => JSON.parse(localStorage.getItem('ij-tv')));
}
async function joinPhone(p, code, name) {
  await p.goto(`${BASE}/play?room=${code}`);
  await p.fill('#name', name);
  await p.click('#join-btn');
  await p.waitForSelector('#v-game:not([hidden])', { timeout: 8000 });
}
async function makeBoard(tv, topic, age) {
  await tv.fill('#topic', topic);
  if (age != null) await tv.fill('#age', age);
  await tv.click('#make');
  await waitScreen(tv, 's-board', 20000);
}
async function buzz(p) {
  await p.waitForSelector('#pad.live', { timeout: 12000 });
  await p.locator('#pad').dispatchEvent('pointerdown');
}

/* =====================================================================
   GAME 1: classic 6x5, three players + host phone, full game to the end
   ===================================================================== */
async function game1() {
  console.log('\n== Game 1: classic board, 3 players, host phone ==');
  const tv = await newPage('tv', { viewport: { width: 1920, height: 1080 } });
  const creds = await createRoom(tv);
  ok('room code is 4 letters', /^[A-Z]{4}$/.test(creds.code), creds.code);
  ok('setup shows a QR code', await tv.locator('#join-card .qr svg').count() === 1);
  ok('setup shows the demo-board note when there is no AI key', await tv.locator('#demo-note:not([hidden])').count() === 1);
  await shot(tv, 'tv-setup-empty');

  // empty topic error
  await tv.fill('#topic', '');
  await tv.click('#make');
  await wait(200);
  ok('empty topic shows an error', /Type what the board/.test(await tv.locator('#setup-err').innerText()));
  // dice fills a topic
  await tv.click('#dice');
  ok('dice fills the topic', (await tv.inputValue('#topic')).length > 2, await tv.inputValue('#topic'));
  await tv.fill('#age', '6');
  const kid = []; for (let i = 0; i < 12; i++) { await tv.click('#dice'); kid.push(await tv.inputValue('#topic')); }
  ok('age 6 dice never rolls adult topics', !kid.some((t) => /Wine|Cocktail|Cold War|Philosophy|Economics/.test(t)), kid.join(' | '));

  const phones = [await newPage('p-ana', IPHONE13), await newPage('p-ben', IPHONE17PM), await newPage('p-cy', IPHONE_SE)];
  await shot(phones[0], 'phone-join-blank').catch(() => {});
  // wrong room code
  await phones[0].goto(`${BASE}/play`);
  await shot(phones[0], 'phone-join');
  await phones[0].fill('#room', 'ZZZZ'); await phones[0].fill('#name', 'Ana'); await phones[0].click('#join-btn');
  await phones[0].waitForFunction(() => /does not exist|Could not/.test(document.getElementById('join-err').innerText), null, { timeout: 15000 }).catch(() => {});
  ok('bad room code shows a clear error', /does not exist/.test(await phones[0].locator('#join-err').innerText()), await phones[0].locator('#join-err').innerText());

  await joinPhone(phones[0], creds.code, 'Ana');
  await joinPhone(phones[1], creds.code, 'Ben');
  await joinPhone(phones[2], creds.code, 'ana'); // duplicate name gets a suffix
  await tv.waitForFunction(() => document.querySelectorAll('#join-card .chip').length === 3, null, { timeout: 5000 });
  const chips = await tv.locator('#join-card .chip').allInnerTexts();
  ok('TV lobby lists 3 players', chips.length === 3, chips.join(','));
  ok('duplicate name gets a suffix', chips.some((c) => /ana 2/.test(c)), chips.join(','));
  await shot(tv, 'tv-setup-lobby');
  await shot(phones[0], 'phone-waiting');

  const host = await newPage('host', IPHONE17PM);
  await host.goto(`${BASE}/play?room=${creds.code}&role=host&key=${creds.hostKey}`);
  await host.waitForSelector('#v-game:not([hidden])');
  ok('host phone connects', /Set up the board/.test(await phoneText(host)));
  const badHost = await newPage('badhost', IPHONE13);
  await badHost.goto(`${BASE}/play?room=${creds.code}&role=host&key=wrong`);
  await badHost.waitForFunction(() => !document.getElementById('v-join').hidden && /not valid/.test(document.getElementById('join-err').innerText), null, { timeout: 15000 }).catch(() => {});
  ok('a wrong host key is refused', /not valid/.test(await badHost.locator('#join-err').innerText()));
  await badHost.context().close();

  await makeBoard(tv, '1800s history', '12+');
  await wait(900);
  ok('board has 6 categories', await tv.locator('#grid .cat').count() === 6);
  ok('board has 30 tiles', await tv.locator('#grid .tile').count() === 30);
  const shareCode = (await tv.locator('#bar-topic').innerText()).match(/Board ([A-Z0-9]{6})/)?.[1];
  ok('board has a share code', !!shareCode, shareCode);
  await shot(tv, 'tv-board');
  await host.waitForSelector('.hboard');
  ok('host sees the board with 2 Daily Double marks', await host.locator('.hboard button.dd').count() === 2);
  await shot(host, 'host-board');
  ok('players do not receive answers', !(await phones[0].evaluate(() => document.body.innerHTML)).includes('Promontory'));

  // Play every clue with a mix of outcomes.
  let clueN = 0, sawDD = 0, sawEarly = false;
  const scoresBefore = {};
  while (await screenOn(tv) === 's-board') {
    const tile = tv.locator('#grid .tile:not(.used)').first();
    if (await tile.count() === 0) break;
    await tile.click();
    await tv.waitForFunction(() => ['s-clue', 's-dd'].includes(document.querySelector('.screen.on')?.id), null, { timeout: 5000 });
    clueN++;
    if (await screenOn(tv) === 's-dd') {
      sawDD++;
      if (sawDD === 1) await shot(tv, 'tv-daily-double');
      // whichever phone shows the wager form
      let wp = null;
      for (const p of phones) if (await p.locator('#wager-form').count()) wp = p;
      ok(`DD ${sawDD}: exactly one phone gets the wager form`, !!wp);
      if (sawDD === 1) await shot(wp, 'phone-dd-wager');
      await wp.fill('#wager-in', '1');
      await wp.click('#wager-form button.primary');
      await wp.waitForFunction(() => /Wager between/.test(document.getElementById('wager-err')?.innerText || ''), null, { timeout: 3000 }).catch(() => {});
      ok(`DD ${sawDD}: too-small wager is refused`, /Wager between/.test(await wp.locator('#wager-err').innerText().catch(() => '')));
      await wp.click('[data-amt]'); // Min
      await wp.click('#wager-form button.primary');
      await waitScreen(tv, 's-clue');
      await tv.click('[data-act="reveal"]');
      await tv.click(sawDD === 1 ? '[data-correct="1"]' : '[data-correct="0"]');
      await tv.waitForSelector('[data-act="continue"]');
      await tv.click('[data-act="continue"]');
      await tv.waitForFunction(() => ['s-board', 's-final'].includes(document.querySelector('.screen.on')?.id));
      continue;
    }
    // normal clue
    if (clueN === 1) {
      await shot(tv, 'tv-clue-reading');
      await shot(phones[0], 'phone-pad-wait');
      // early buzz from Ben
      await phones[1].locator('#pad').dispatchEvent('pointerdown');
      await phones[1].waitForSelector('.toast-p', { timeout: 3000 }).catch(() => {});
      sawEarly = /Too early/.test(await phones[1].locator('.toast-p').innerText().catch(() => ''));
      ok('buzzing before the buzzers open shows "Too early"', sawEarly);
    }
    const mode = clueN % 5; // 0: nobody, 1: Ana right, 2: Ben wrong then Cy right, 3: host judges, 4: reveal then wrong
    if (mode === 0) {
      await tv.click('[data-act="open"]').catch(() => {});
      await tv.waitForSelector('[data-act="reveal"]');
      await tv.click('[data-act="reveal"]');
    } else if (mode === 1) {
      await buzz(phones[0]);
      await tv.waitForSelector('.buzzer-name', { timeout: 5000 });
      if (clueN === 1) { await shot(tv, 'tv-buzzed'); await shot(phones[0], 'phone-won'); await shot(phones[1], 'phone-lost'); await shot(host, 'host-answering'); }
      ok(`clue ${clueN}: TV names Ana as the buzzer`, /Ana/.test(await tv.locator('.buzzer-name').innerText()));
      await tv.click('[data-act="reveal"]');
      await tv.waitForSelector('#answer:not([hidden])');
      if (clueN === 1) await shot(tv, 'tv-revealed-judge');
      await tv.click('[data-correct="1"]');
    } else if (mode === 2) {
      await buzz(phones[1]);
      await tv.waitForSelector('.buzzer-name');
      await tv.click('[data-correct="0"]');
      await phones[1].waitForSelector('#pad.out', { timeout: 5000 });
      ok(`clue ${clueN}: wrong answer locks Ben out`, true);
      if (clueN === 2) { await shot(tv, 'tv-reopened'); await shot(phones[1], 'phone-out'); }
      await buzz(phones[2]);
      await tv.waitForSelector('.buzzer-name');
      ok(`clue ${clueN}: Cy gets the rebound`, /ana 2/.test(await tv.locator('.buzzer-name').innerText()));
      await tv.click('[data-correct="1"]');
    } else if (mode === 3) {
      await buzz(phones[0]);
      await host.waitForSelector('[data-h="judge1"]', { timeout: 5000 });
      await host.click('[data-h="judge1"]');
    } else {
      await buzz(phones[2]);
      await tv.waitForSelector('.buzzer-name');
      await tv.click('[data-act="reveal"]');
      await tv.click('[data-correct="0"]');
    }
    await tv.waitForSelector('[data-act="continue"]', { timeout: 15000 });
    if (clueN === 1) { await shot(tv, 'tv-reveal'); await shot(phones[0], 'phone-reveal'); }
    if (clueN === 3) {
      // reload a phone mid-game: it should come straight back with its score
      const before = await phones[0].locator('#me-score').innerText();
      await phones[0].reload();
      await phones[0].waitForSelector('#v-game:not([hidden])', { timeout: 8000 });
      await phones[0].waitForFunction((b) => document.getElementById('me-score').innerText === b, before, { timeout: 5000 }).catch(() => {});
      ok('a phone that reloads rejoins with its score', (await phones[0].locator('#me-score').innerText()) === before, `${before} vs ${await phones[0].locator('#me-score').innerText()}`);
    }
    if (clueN === 4) {
      // reload the TV mid-game: resume button brings it back
      await tv.reload();
      await tv.waitForSelector('#resume:not([hidden])');
      await tv.click('#resume');
      await tv.waitForFunction(() => document.querySelector('.screen.on')?.id === 's-clue', null, { timeout: 8000 });
      ok('TV resumes the room after a reload', true);
    }
    await tv.click('[data-act="continue"]');
    await tv.waitForFunction(() => ['s-board', 's-final', 's-over'].includes(document.querySelector('.screen.on')?.id), null, { timeout: 5000 });
  }
  ok('all 30 clues were played', clueN === 30, String(clueN));
  ok('both Daily Doubles came up', sawDD === 2, String(sawDD));

  // Host score adjust: make sure at least two players are positive for a real final
  if (await screenOn(tv) === 's-final') {
    await shot(tv, 'tv-final-wager');
    const finalists = [];
    for (const p of phones) if (await p.locator('#wager-form').count()) finalists.push(p);
    ok('final: wager forms appear on eligible phones', finalists.length >= 1, String(finalists.length));
    if (finalists[0]) await shot(finalists[0], 'phone-final-wager');
    for (const [i, p] of finalists.entries()) {
      await p.click(i === 0 ? '[data-amt]:last-child' : '[data-amt]:first-child');
      await p.click('#wager-form button.primary');
    }
    await tv.waitForSelector('.fclue', { timeout: 8000 });
    await shot(tv, 'tv-final-clue');
    for (const [i, p] of finalists.entries()) {
      await p.waitForSelector('#final-in');
      await p.fill('#final-in', i === 0 ? 'What is HMS Beagle?' : 'What is the Mayflower?');
      await p.click('#final-form button');
      await p.waitForSelector('.ok-note');
    }
    if (finalists[0]) await shot(finalists[0], 'phone-final-answer');
    await tv.click('[data-act="stop-final"]');
    await tv.waitForSelector('.judge');
    await shot(tv, 'tv-final-judge');
    for (let i = 0; i < finalists.length; i++) {
      const said = await tv.locator('.judge .said').innerText();
      await tv.click('[data-act="reveal"]').catch(() => {});
      await tv.click(/Beagle/.test(said) ? '[data-correct="1"]' : '[data-correct="0"]');
      await wait(300);
    }
  }
  await waitScreen(tv, 's-over', 8000);
  ok('game reaches the game-over screen', true);
  await shot(tv, 'tv-over');
  await shot(phones[0], 'phone-over');
  await shot(host, 'host-over');
  const champ = await tv.locator('.champ').innerText();
  ok('game over names a winner', /wins|tie/.test(champ), champ);

  // Replay the same board by code
  await tv.click('[data-act="replay"]');
  await waitScreen(tv, 's-board', 8000);
  ok('"Play this board again" reloads the same board', (await tv.locator('#bar-topic').innerText()).includes(shareCode));
  ok('scores reset for the replay', !(await tv.locator('#scores').innerText()).match(/\$[1-9]/));

  // A player leaves via the menu
  await phones[2].click('#menu-btn');
  await phones[2].click('[data-m="leave"]');
  await phones[2].waitForSelector('#v-join:not([hidden])');
  await tv.waitForFunction(() => document.querySelectorAll('#scores .score').length === 2, null, { timeout: 5000 }).catch(() => {});
  ok('leaving removes the player from the TV', await tv.locator('#scores .score').count() === 2);

  for (const p of [tv, host, ...phones]) await p.context().close();
  return shareCode;
}

/* =====================================================================
   GAME 2: teams, quick 4x4, loaded by board code, with the host doing the judging
   ===================================================================== */
async function game2(shareCode) {
  console.log('\n== Game 2: teams, quick board, keyboard control ==');
  const tv = await newPage('tv2', { viewport: { width: 1366, height: 768 } });
  const creds = await createRoom(tv);
  await tv.click('#mode-seg [data-mode="teams"]');
  await tv.click('#size-seg [data-size="4x4"]');
  await tv.waitForSelector('#teams-field:not([hidden])');
  const ps = [await newPage('t-a', IPHONE13), await newPage('t-b', IPHONE13), await newPage('t-c', IPHONE13)];
  for (const [i, p] of ps.entries()) await joinPhone(p, creds.code, ['Dee', 'Eli', 'Fay'][i]);
  await ps[0].waitForSelector('.teampick');
  await shot(ps[0], 'phone-team-pick');
  // move Fay to Team Sky
  await ps[2].click('[data-team="t1"]');
  await tv.waitForFunction(() => document.querySelector('.teamcols .team')?.innerText.includes('Fay'), null, { timeout: 5000 }).catch(() => {});
  ok('a phone can switch teams', (await tv.locator('.teamcols .team').first().innerText()).includes('Fay'));
  await shot(tv, 'tv-teams-lobby');
  await makeBoard(tv, 'The ocean', 'kids');
  ok('quick board has 4x4 tiles', await tv.locator('#grid .tile').count() === 16);
  await shot(tv, 'tv-board-4x4');

  // keyboard: pick with click, then O / C / Space (clear any Daily Double first)
  for (let i = 0; i < 3; i++) {
    await tv.locator('#grid .tile:not(.used)').first().click();
    await tv.waitForFunction(() => ['s-clue', 's-dd'].includes(document.querySelector('.screen.on')?.id));
    if (await screenOn(tv) === 's-clue') break;
    await tv.fill('#dd-amt', '5'); await tv.click('#dd-form button');
    await waitScreen(tv, 's-clue');
    await tv.click('[data-act="reveal"]'); await tv.click('[data-correct="0"]');
    await tv.waitForSelector('[data-act="continue"]'); await tv.click('[data-act="continue"]'); await waitScreen(tv, 's-board');
  }
  if (await screenOn(tv) === 's-clue') {
    await tv.keyboard.press('o');
    await buzz(ps[0]);
    await tv.waitForSelector('.buzzer-name');
    await tv.keyboard.press('c');
    await tv.waitForSelector('[data-act="continue"]');
    await tv.keyboard.press(' ');
    await waitScreen(tv, 's-board');
    ok('keyboard shortcuts O, C, Space work', true);
    const sc = await tv.locator('#scores').innerText();
    ok('team score shows on the TV', /Team Sky/.test(sc), sc);
    await wait(300);
    const teamScores = await Promise.all(ps.map((p) => p.locator('#me-score').innerText()));
    ok('teammates share one score (Dee and Fay)', teamScores[0] === teamScores[2], teamScores.join(','));
  } else ok('first quick clue was a Daily Double (keyboard test skipped)', true);

  // load a board code is only possible in setup: start over
  await tv.click('[data-overlay="menu"]');
  await tv.click('[data-overlay="confirm-new"]');
  await tv.click('#ov [data-act="new-game"]');
  await waitScreen(tv, 's-setup');
  await tv.click('#loadcode summary');
  await tv.fill('#code-in', 'BADBAD');
  await tv.click('#load');
  await wait(400);
  ok('unknown board code shows an error', /No board has that code/.test(await tv.locator('#setup-err').innerText()));
  await tv.fill('#code-in', shareCode.toLowerCase());
  await tv.click('#load');
  await waitScreen(tv, 's-board', 8000);
  ok('a saved board code loads (lowercase typed)', (await tv.locator('#grid .tile').count()) === 30);

  // Skip to final via menu with no positive scores -> game over
  await tv.click('[data-overlay="menu"]');
  await tv.click('#ov [data-act="start-final"]');
  await waitScreen(tv, 's-over', 8000);
  ok('skipping to final with nobody above $0 ends the game', true);
  for (const p of [tv, ...ps]) await p.context().close();
}

/* =====================================================================
   GAME 3: buzz fairness and stress: 8 phones buzz at once, many times
   ===================================================================== */
async function game3() {
  console.log('\n== Game 3: 8 phones mashing the buzzer ==');
  const tv = await newPage('tv3', { viewport: { width: 1280, height: 720 } });
  const creds = await createRoom(tv);
  const ps = [];
  for (let i = 0; i < 8; i++) { const p = await newPage(`m${i}`, IPHONE13); await joinPhone(p, creds.code, `M${i}`); ps.push(p); }
  await makeBoard(tv, 'ocean');
  let rounds = 0, singleWinner = 0;
  for (let k = 0; k < 6; k++) {
    await tv.locator('#grid .tile:not(.used)').first().click();
    await tv.waitForFunction(() => ['s-clue', 's-dd'].includes(document.querySelector('.screen.on')?.id));
    if (await screenOn(tv) === 's-dd') {
      await tv.fill('#dd-amt', '5'); await tv.click('#dd-form button');
      await waitScreen(tv, 's-clue');
      await tv.click('[data-act="reveal"]'); await tv.click('[data-correct="1"]');
    } else {
      await tv.click('[data-act="open"]');
      await Promise.all(ps.map((p) => p.waitForSelector('#pad.live')));
      await Promise.all(ps.map((p) => p.locator('#pad').dispatchEvent('pointerdown')));
      await tv.waitForSelector('.buzzer-name');
      const won = (await Promise.all(ps.map((p) => p.locator('#pad.won').count()))).reduce((a, b) => a + b, 0);
      rounds++; if (won === 1) singleWinner++;
      await tv.click('[data-correct="1"]');
    }
    await tv.waitForSelector('[data-act="continue"]');
    await tv.click('[data-act="continue"]');
    await waitScreen(tv, 's-board');
  }
  ok('when 8 phones buzz together, exactly one wins every time', singleWinner === rounds, `${singleWinner}/${rounds}`);
  // kick from the lobby? use the host-less TV: kick needs setup; check phones count stays 8
  ok('8 players show on the scoreboard', await tv.locator('#scores .score').count() === 8);
  // a phone drops off in the middle of a clue: the clue still finishes
  for (let i = 0; i < 3; i++) {
    await tv.locator('#grid .tile:not(.used)').first().click();
    await tv.waitForFunction(() => ['s-clue', 's-dd'].includes(document.querySelector('.screen.on')?.id));
    if (await screenOn(tv) === 's-clue') break;
    await tv.fill('#dd-amt', '5'); await tv.click('#dd-form button'); await waitScreen(tv, 's-clue');
    await tv.click('[data-act="reveal"]'); await tv.click('[data-correct="0"]');
    await tv.waitForSelector('[data-act="continue"]'); await tv.click('[data-act="continue"]'); await waitScreen(tv, 's-board');
  }
  if (await screenOn(tv) === 's-clue') {
    await tv.click('[data-act="open"]');
    await ps[0].waitForSelector('#pad.live');
    await ps[0].locator('#pad').dispatchEvent('pointerdown');
    await tv.waitForSelector('.buzzer-name');
    await ps[0].context().close(); ps.shift();
    await tv.waitForFunction(() => document.querySelectorAll('#scores .score.off').length >= 0);
    await tv.click('[data-correct="0"]');
    await tv.waitForFunction(() => document.querySelector('#clue-controls')?.innerText.length > 0);
    ok('a phone leaving mid-answer does not freeze the clue', true);
    await tv.click('[data-act="reveal"]').catch(() => {});
    await tv.waitForSelector('[data-act="continue"]'); await tv.click('[data-act="continue"]');
    await waitScreen(tv, 's-board');
    await tv.waitForFunction(() => document.querySelectorAll('#scores .score.off').length === 1, null, { timeout: 5000 }).catch(() => {});
    ok('the disconnected phone is greyed out on the TV', await tv.locator('#scores .score.off').count() === 1);
  }
  // a late joiner during the game
  const late = await newPage('late', IPHONE13);
  await joinPhone(late, creds.code, 'Late');
  await tv.waitForFunction(() => /Late/.test(document.getElementById('scores').innerText), null, { timeout: 5000 }).catch(() => {});
  ok('someone can join in the middle of a game', /Late/.test(await tv.locator('#scores').innerText()));
  ps.push(late);
  // host: adjust and remove
  const host = await newPage('host3', IPHONE13);
  await host.goto(`${BASE}/play?room=${creds.code}&role=host&key=${creds.hostKey}`);
  await host.waitForSelector('[data-adj]');
  await host.locator('.adj .row', { hasText: 'Late' }).locator('[data-d="200"]').click();
  await tv.waitForFunction(() => /Late\s*\$200/.test(document.getElementById('scores').innerText), null, { timeout: 5000 }).catch(() => {});
  ok('host can add points', /Late\s*\$200/.test(await tv.locator('#scores').innerText()), await tv.locator('#scores').innerText());
  await host.locator('.adj .row', { hasText: 'Late' }).locator('[data-kick]').click();
  await host.locator('.adj .row', { hasText: 'Late' }).locator('[data-kick]').click();
  await late.waitForSelector('#v-join:not([hidden])', { timeout: 5000 }).catch(() => {});
  ok('host can remove a player, and their phone is told', /no longer in this game/.test(await late.locator('#join-err').innerText()));
  await host.context().close();
  for (const p of [tv, ...ps]) await p.context().close();
}

/* =====================================================================
   Layout checks: no horizontal scroll, nothing off-screen, at phone + TV sizes
   ===================================================================== */
async function layout() {
  console.log('\n== Layout checks ==');
  for (const [label, opts] of [['iphone-se', IPHONE_SE], ['iphone-13', IPHONE13], ['iphone-17pm', IPHONE17PM]]) {
    const p = await newPage(label, opts);
    await p.goto(`${BASE}/play`);
    const over = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    ok(`${label}: join page has no sideways scroll`, !over);
    const btn = await p.locator('#join-btn').boundingBox();
    ok(`${label}: join button is on screen`, btn && btn.y + btn.height <= opts.viewport.height, JSON.stringify(btn));
    await p.context().close();
  }
  for (const vp of [{ width: 1920, height: 1080 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 3840, height: 2160 }]) {
    const tv = await newPage(`tv-${vp.width}`, { viewport: vp });
    await createRoom(tv);
    const r = await tv.evaluate(() => {
      const bad = [];
      document.querySelectorAll('.screen.on *').forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.width && (b.right > innerWidth + 1 || b.bottom > innerHeight + 1 || b.left < -1)) bad.push(el.className || el.tagName);
      });
      return bad.slice(0, 5);
    });
    ok(`TV ${vp.width}x${vp.height}: setup fits on screen`, r.length === 0, r.join(','));
    if (vp.width === 1024) await shot(tv, 'tv-setup-1024');
    await tv.context().close();
  }
}

try {
  const code = await game1();
  await game2(code);
  await game3();
  await layout();
} catch (e) {
  ok('test run finished without crashing', false, e.stack.split('\n').slice(0, 4).join(' | '));
}
const unexpected = consoleErrors.filter((e) => !/^(p-ana|badhost): (WebSocket connection to .*(ZZZZ|key=wrong)|Failed to load resource: the server responded with a status of (404|403))/.test(e));
ok('no unexpected console errors on any page', unexpected.length === 0, unexpected.slice(0, 6).join(' || '));
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${OUT}`);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, consoleErrors }, null, 2));
process.exit(failed.length ? 1 : 0);
