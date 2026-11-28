// Phone: the player buzzer (default) or the host remote (?role=host&key=...).
import { Conn, storage, esc, money, put } from './net.js';
import * as sfx from './sfx.js';
import { rollTopic } from './topics.js';
import { scanQR, canScan, readGameLink } from './scan.js';
import { STYLES, STYLE_IDS, BANDS, LEVELS, AGE_PRESETS, bandFor, defaultTune, cleanTune, composeAges, splitAges } from './tuning.js';

const $ = (id) => document.getElementById(id);
const store = storage();
const params = new URLSearchParams(location.search);
const ROLE = params.get('role') === 'host' ? 'host' : 'player';
const HOST_KEY = params.get('key') || '';
const valueFor = (r) => (r + 1) * 200;

let conn = null, S = null, joined = false, joining = false, myBuzz = null, lastEvent = 0, lastPhaseKey = '', chosenTeam = null;

function pid() {
  let id = store.get('ij-pid');
  if (!id || !/^[A-Za-z0-9_-]{8,40}$/.test(id)) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
    store.set('ij-pid', id);
  }
  return id;
}
const PID = ROLE === 'player' ? pid() : null;

/* ---------------- join ---------------- */
function boot() {
  document.body.classList.toggle('host', ROLE === 'host');
  const urlRoom = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (ROLE === 'host') {
    if (!urlRoom || !HOST_KEY) { showJoin('That host link is missing its room or key. Open it again from the TV.'); return; }
    // Remember the host link so the installed app can go straight back to hosting.
    store.set('ij-host', JSON.stringify({ room: urlRoom, key: HOST_KEY, at: Date.now() }));
    startConn(urlRoom);
    showGame();
    return;
  }
  let saved = null;
  try { saved = JSON.parse(store.get('ij-player') || 'null'); } catch {}
  $('room').value = urlRoom || (saved && saved.code) || '';
  $('name').value = (saved && saved.name) || '';
  // Coming back to the same room (refresh, phone locked, tab closed): rejoin automatically.
  if (saved && saved.code && saved.name && (!urlRoom || urlRoom === saved.code) && Date.now() - (saved.at || 0) < 12 * 3600 * 1000) {
    joinGame(saved.code, saved.name, true);
    return;
  }
  showJoin();
  if (!urlRoom && !$('room').value) return; // nothing typed yet: leave the keyboard down so the Scan button shows
  setTimeout(() => ($('room').value.length === 4 ? $('name') : $('room')).focus(), 250);
}
function showJoin(msg) {
  $('v-join').hidden = false; $('v-game').hidden = true;
  $('scene').dataset.pose = 'join';
  $('join-err').textContent = msg || '';
}
/* scan the TV's QR from inside the app */
$('scan-btn').hidden = !canScan();
$('scan-btn').addEventListener('click', () => { sfx.unlock(); startScan(); });
// "Join a game" on the TV home links to /play?scan=1: open the camera right away (the code form stays behind it)
if (canScan() && ROLE !== 'host' && new URLSearchParams(location.search).has('scan')) {
  history.replaceState(null, '', '/play');
  setTimeout(startScan, 150);
}
async function startScan() {
  const text = await scanQR();
  if (!text) return;
  const g = readGameLink(text);
  if (!g) { $('join-err').textContent = 'That QR is not an Infinite Jeopardy room.'; return; }
  if (g.host) { location.href = `/play?room=${g.room}&role=host&key=${encodeURIComponent(g.key)}`; return; }
  $('room').value = g.room;
  $('join-err').textContent = '';
  if ($('name').value.trim()) joinGame(g.room, $('name').value.replace(/\s+/g, ' ').trim(), false);
  else $('name').focus();
}

/* back to hosting a room from the installed app */
(() => {
  if (ROLE === 'host') return;
  let h = null;
  try { h = JSON.parse(store.get('ij-host') || 'null'); } catch {}
  if (!h || !h.room || !h.key || Date.now() - (h.at || 0) > 12 * 3600 * 1000) return;
  const b = $('host-resume');
  b.textContent = `Back to hosting ${h.room}`;
  b.hidden = false;
  b.addEventListener('click', () => { location.href = `/play?room=${h.room}&role=host&key=${encodeURIComponent(h.key)}`; });
})();

/* install as an app: Android/Chrome gets the real prompt, iPhone gets the Share steps */
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installEvt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (!standalone) $('install-link').hidden = false; });
if (!standalone && isIOS) $('install-link').hidden = false;
$('install-link').addEventListener('click', async () => {
  if (installEvt) { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('install-link').hidden = true; return; }
  $('sheet').hidden = false;
  put($('sheet-card'), `<h3>Get the app</h3><ol class="steps"><li>Tap <b>Share</b> <svg class="share" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/></svg> in Safari</li><li>Tap <b>Add to Home Screen</b></li><li>Open <b>Jeopardy</b> from your home screen</li></ol><button class="btn line wide" data-m="close">Done</button>`);
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

function showGame() { $('v-join').hidden = true; $('v-game').hidden = false; }

$('room').addEventListener('input', () => {
  const v = $('room').value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if ($('room').value !== v) $('room').value = v;
  if (v.length === 4 && document.activeElement === $('room')) $('name').focus();
});
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  sfx.unlock();
  const code = $('room').value.trim().toUpperCase();
  const name = $('name').value.replace(/\s+/g, ' ').trim();
  if (!/^[A-Z]{4}$/.test(code)) { $('join-err').textContent = 'Room codes are 4 letters. Check the TV.'; $('room').focus(); return; }
  if (!name) { $('join-err').textContent = 'Type your name.'; $('name').focus(); return; }
  joinGame(code, name, false);
});

function joinGame(code, name, auto) {
  joining = { code, name, auto };
  $('join-btn').disabled = true;
  $('join-err').textContent = auto ? '' : 'Joining...';
  if (!conn || conn.code !== code || conn.closed) startConn(code);
  else if (S) sendJoin();
}

async function sendJoin() {
  if (!joining) return;
  const { code, name } = joining;
  const r = await conn.request({ t: 'join', name, team: chosenTeam });
  $('join-btn').disabled = false;
  if (!r.ok) { joining = false; showJoin(r.err); return; }
  store.set('ij-player', JSON.stringify({ code, name, at: Date.now() }));
  joining = false; joined = true;
  $('join-err').textContent = '';
  showGame();
  render();
}

function startConn(code) {
  if (conn) conn.close();
  S = null;
  conn = new Conn({
    code, role: ROLE, key: ROLE === 'host' ? HOST_KEY : null, pid: PID,
    onState: (s) => {
      const first = !S; S = s;
      if (first) lastEvent = s.event ? s.event.id : 0;
      if (ROLE === 'player') {
        const me = S.players.find((p) => p.id === PID);
        if (joining && first) sendJoin();
        else if (!me && joined) { joined = false; showJoin('You are no longer in this game. Join again?'); $('join-btn').disabled = false; }
        else if (me && !joined && !joining) { joined = true; showGame(); }
      }
      render();
    },
    onStatus: (st) => {
      $('dot').classList.toggle('bad', st !== 'online');
      $('foot-text').textContent = st === 'online' ? `Room ${code}` : st === 'dead' ? 'Disconnected' : 'Reconnecting...';
    },
    onFatal: (msg) => {
      conn = null; S = null; joined = false; joining = false;
      $('join-btn').disabled = false;
      if (ROLE === 'player') store.del('ij-player');
      showJoin(msg);
    },
  });
}

/* ---------------- helpers ---------------- */
const me = () => S && S.players.find((p) => p.id === PID);
const isTeams = () => S && S.mode === 'teams';
const myEid = () => { const m = me(); return !m ? null : isTeams() ? m.team : m.id; };
function entityList() {
  if (isTeams()) return Object.values(S.teams).map((t) => ({ id: t.id, name: t.name, score: t.score, connected: S.players.some((p) => p.team === t.id && p.connected) }));
  return S.players.map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected }));
}
const nameOf = (eid) => { const e = S && entityList().find((x) => x.id === eid); return e ? e.name : 'Someone'; };
const playerName = (id) => { const p = S.players.find((x) => x.id === id); return p ? p.name : 'Someone'; };
const scoreOf = (eid) => { const e = entityList().find((x) => x.id === eid); return e ? e.score : 0; };
function toast(text, bad) {
  document.querySelectorAll('.toast-p').forEach((t) => t.remove());
  const t = document.createElement('div'); t.className = `toast-p${bad ? ' bad' : ''}`; t.textContent = text;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
}
function fail(r) { if (r && !r.ok && r.err) toast(r.err, true); return r; }

/* ---------------- render ---------------- */
function render() {
  if (!S) return;
  handleEvent();
  if (ROLE === 'host') return renderHost();
  if (!joined) return;
  renderHeader();
  renderPlayer();
}
function renderHeader() {
  const m = me(); if (!m) return;
  $('me-name').textContent = m.name;
  $('me-team').textContent = isTeams() && S.teams[m.team] ? S.teams[m.team].name : '';
  const sc = isTeams() ? scoreOf(m.team) : m.score;
  $('me-score').textContent = money(sc);
  $('me-score').classList.toggle('neg', sc < 0);
}

function renderPlayer() {
  const st = $('stagep'), ph = S.phase, c = S.current, eid = myEid();
  let pose = 'wait', html = '', key = ph;
  if (ph === 'setup' || ph === 'generating') {
    html = `<div class="say"><h2>${ph === 'generating' ? 'Writing the board...' : 'You’re in!'}</h2><p>${ph === 'generating' ? esc(S.gen.topic) : 'Watch the TV. The game starts when the board is ready.'}</p></div>`;
    if (isTeams() && ph === 'setup') html += teamPicker();
    html += `<div class="spacer"></div>` + miniScores();
    pose = 'wait';
  } else if (ph === 'board') {
    const mine = S.control != null && S.control === eid;
    html = `<div class="say"><h2>${mine ? 'Your pick!' : S.control ? `${esc(nameOf(S.control))} picks` : 'Pick a clue on the TV'}</h2><p>${mine ? 'Call out a category and amount.' : 'Get ready to buzz.'}</p></div><div class="spacer"></div>${miniScores()}`;
    pose = 'wait';
  } else if (['reading', 'open', 'answering', 'dd-clue'].includes(ph) && !(ph === 'dd-clue')) {
    key = `pad-${c.id}`;
    html = `<div><p class="cluecat">${esc(c.category)} · ${money(c.value)}</p><p class="clueline">${esc(c.clue || '')}</p></div>
      <button class="pad wait" id="pad" type="button" aria-label="Buzz"><span class="pl" id="pad-l">Buzz</span><span class="ps" id="pad-s"></span><span class="bar" id="pad-bar"></span></button>`;
    pose = 'buzz';
  } else if (ph === 'dd-clue') {
    const mine = c.ddEntity === eid;
    html = `<div><p class="cluecat">Daily Double · ${money(c.wager || 0)}</p><p class="clueline">${esc(c.clue || '')}</p></div>
      <div class="say on-hill"><h2>${mine ? 'Answer out loud!' : `${esc(nameOf(c.ddEntity))} is answering`}</h2></div>${c.revealed ? answerBox(c) : ''}`;
    key = `ddc-${c.id}-${c.revealed}`;
    pose = 'buzz';
  } else if (ph === 'reveal') {
    html = `<div><p class="cluecat">${esc(c.category)} · ${money(c.dd && c.wager != null ? c.wager : c.value)}</p><p class="clueline">${esc(c.clue || '')}</p></div>${answerBox(c)}<div class="spacer"></div>`;
    pose = 'low';
  } else if (ph === 'dd-wager') {
    const mine = c.ddEntity === eid;
    if (mine) {
      const b = c.ddBounds;
      key = `ddw-${c.id}`;
      html = `<div class="say"><h2>Daily Double!</h2><p>${esc(c.category)}</p></div>
        <form class="card form" id="wager-form"><h3>Your wager</h3><p class="num">${money(b.min)} to ${money(b.max)}</p>
        <input id="wager-in" class="big-amt num" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="${b.min}">
        <div class="quick"><button type="button" data-amt="${b.min}">Min</button><button type="button" data-amt="${Math.max(b.min, Math.round(b.max / 2 / 5) * 5)}">Half</button><button type="button" data-amt="${b.max}">All in</button></div>
        <button class="btn primary wide">Lock it in</button><p class="err" id="wager-err"></p></form>`;
    } else html = `<div class="say"><h2>Daily Double!</h2><p>${esc(nameOf(c.ddEntity))} is making a wager.</p></div><div class="spacer"></div>${miniScores()}`;
    pose = 'low';
  } else if (ph === 'final-wager') {
    const f = S.final, inIt = f.eligible.includes(eid);
    key = `fw-${inIt}-${f.wagered[eid]}`;
    if (inIt && !f.wagered[eid]) {
      const max = Math.max(0, scoreOf(eid));
      html = `<div class="say"><h2>Final Jeopardy</h2><p>${esc(f.category)}</p></div>
        <form class="card form" id="wager-form"><h3>Your wager</h3><p class="num">$0 to ${money(max)}</p>
        <input id="wager-in" class="big-amt num" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="0">
        <div class="quick"><button type="button" data-amt="0">Nothing</button><button type="button" data-amt="${Math.round(max / 2)}">Half</button><button type="button" data-amt="${max}">All in</button></div>
        <button class="btn primary wide">Lock it in</button><p class="err" id="wager-err"></p></form>`;
    } else if (inIt) html = `<div class="say"><h2>Wager locked</h2><p>${f.wagers[eid] != null ? money(f.wagers[eid]) : ''} on ${esc(f.category)}. Waiting for everyone else.</p></div>`;
    else html = `<div class="say"><h2>Final Jeopardy</h2><p>You need more than $0 to play this one. Watch the TV!</p></div>`;
    pose = 'low';
  } else if (ph === 'final-clue') {
    const f = S.final, inIt = f.eligible.includes(eid);
    key = `fc-${inIt}`;
    html = `<div><p class="cluecat">${esc(f.category)}</p><p class="clueline">${esc(f.clue || '')}</p></div>`;
    if (inIt) html += `<form class="card form" id="final-form"><h3>Your answer</h3><textarea id="final-in" maxlength="80" placeholder="What is..." autocapitalize="sentences"></textarea>
        <button class="btn primary wide">Send answer</button><p class="err" id="final-note"></p></form>`;
    else html += `<div class="say"><p>Watch the TV. You can still play along in your head.</p></div>`;
    pose = 'low';
  } else if (ph === 'final-judge') {
    const f = S.final, j = f.judged[eid];
    html = `<div class="say"><h2>${j == null ? 'Judging Final Jeopardy...' : j ? 'You got it!' : 'Not this time'}</h2><p>${f.eligible.includes(eid) ? `You wrote: <i>${esc(f.responses[eid] || 'nothing')}</i>` : 'Watch the TV.'}</p></div><div class="spacer"></div>${miniScores()}`;
    pose = 'low';
  } else if (ph === 'over') {
    const ents = entityList().sort((a, b) => b.score - a.score);
    const place = ents.findIndex((e) => e.id === eid) + 1;
    const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 >> 3 ^ 1) && n % 10] || 'th');
    html = `<div class="say"><h2>${place === 1 ? 'You won!' : `You finished ${ord(place)}`}</h2><p>with ${money(scoreOf(eid))}. Stay on this page for the next board.</p></div><div class="spacer"></div>${miniScores()}`;
    pose = 'wait';
  }
  $('scene').dataset.pose = pose;
  if (key !== lastPhaseKey || !document.querySelector('#stagep form')) { lastPhaseKey = key; if (put(st, html)) bindPlayer(); }
  updatePad();
}

function answerBox(c) {
  let res = '';
  if (S.phase === 'reveal') {
    const eid = myEid();
    if (c.result === 'correct') res = (c.dd ? c.ddEntity : c.resultEid) === eid ? `<span class="res good">You got it! +${money(c.dd ? c.wager : c.value)}</span>` : `<span class="res">${esc(nameOf(c.dd ? c.ddEntity : c.resultEid))} got it</span>`;
    else if (c.result === 'timeout') res = '<span class="res">Time ran out</span>';
    else res = '<span class="res">Nobody got it</span>';
  }
  return `<div class="answerbox"><small>Correct response</small><b>${esc(c.response || '')}</b>${res}</div>`;
}

function teamPicker() {
  const m = me();
  return `<div class="teampick">${Object.values(S.teams).map((t) => `<button type="button" data-team="${t.id}" aria-pressed="${m && m.team === t.id}">${esc(t.name)}<span>${S.players.filter((p) => p.team === t.id).map((p) => esc(p.name)).join(', ') || 'Nobody yet'}</span></button>`).join('')}</div>`;
}
function miniScores() {
  const eid = myEid();
  const ents = entityList().slice().sort((a, b) => b.score - a.score).slice(0, 8);
  return `<div class="mini-scores">${ents.map((e) => `<div class="row${e.id === eid ? ' me' : ''}${e.connected ? '' : ' off'}"><span>${esc(e.name)}</span><b class="num">${money(e.score)}</b></div>`).join('')}</div>`;
}

function bindPlayer() {
  const pad = $('pad');
  if (pad) {
    pad.addEventListener('pointerdown', (e) => { e.preventDefault(); doBuzz(); });
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  const wf = $('wager-form');
  if (wf) {
    wf.addEventListener('click', (e) => { const b = e.target.closest('[data-amt]'); if (b) { $('wager-in').value = b.dataset.amt; } });
    wf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = $('wager-in').value.replace(/[^0-9]/g, '');
      if (v === '') { $('wager-err').textContent = 'Type an amount.'; return; }
      const r = await conn.request({ t: 'wager', amount: Number(v) });
      if (!r.ok) $('wager-err').textContent = r.err;
    });
  }
  const ff = $('final-form');
  if (ff) ff.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await conn.request({ t: 'final-answer', text: $('final-in').value });
    // No explanation needed: the button just says "Sent" until the answer is edited again.
    $('final-note').textContent = r.ok ? '' : r.err;
    const btn = ff.querySelector('button');
    if (r.ok) { btn.textContent = 'Sent'; btn.classList.add('sent'); sfx.vibrate(30); }
  });
  if (ff) $('final-in').addEventListener('input', () => { const btn = ff.querySelector('button'); btn.textContent = 'Send answer'; btn.classList.remove('sent'); });
  document.querySelectorAll('[data-team]').forEach((b) => b.addEventListener('click', async () => {
    chosenTeam = b.dataset.team;
    const m = me();
    fail(await conn.request({ t: 'join', name: m ? m.name : $('name').value, team: chosenTeam }));
  }));
}

/* ---------------- the buzzer ---------------- */
function padState() {
  const c = S.current, eid = myEid(), now = conn.serverNow();
  if (!c) return { cls: 'wait', l: 'Buzz', s: '' };
  const out = c.lockedOut.includes(eid);
  if (S.phase === 'answering') {
    if (c.winner === PID) return { cls: 'won', l: 'You’re up!', s: 'Answer out loud' };
    const spot = (c.queue || []).indexOf(PID);
    if (spot > 0 && !out) return { cls: 'lost queued', l: `#${spot + 1}`, s: 'You’re next if they miss' };
    if (!out && spot < 0 && (c.queue || []).length < 4 && !isTeams()) return { cls: 'live', l: 'Buzz', s: `${playerName(c.winner)} is answering` };
    if (isTeams() && myEid() === (S.players.find((p) => p.id === c.winner) || {}).team) return { cls: 'won', l: 'Your team!', s: `${playerName(c.winner)} answers` };
    return { cls: out ? 'out' : 'lost', l: playerName(c.winner), s: out ? 'You’re out this round' : 'buzzed first' };
  }
  if (out) return { cls: 'out', l: 'Out', s: 'Wrong answer. Wait for the next clue.' };
  if (myBuzz === `${c.id}-${c.round}` && S.phase === 'open') return { cls: 'live pressed', l: 'Buzzed!', s: 'Checking who was first...' };
  const openNow = S.phase === 'open' || (S.phase === 'reading' && c.openAt && now >= c.openAt);
  if (openNow) return { cls: 'live', l: 'Buzz', s: 'Tap anywhere' };
  return { cls: 'wait', l: 'Buzz', s: 'Wait for it...' };
}
let lastPadCls = '';
function updatePad() {
  const pad = $('pad'); if (!pad || !S || !S.current) return;
  const p = padState();
  if (p.cls !== lastPadCls) {
    if (p.cls === 'live' && lastPadCls === 'wait') sfx.vibrate(20);
    lastPadCls = p.cls;
  }
  pad.className = `pad ${p.cls}`;
  $('pad-l').textContent = p.l; $('pad-s').textContent = p.s;
}
async function doBuzz() {
  sfx.unlock();
  if (!S || !S.current || !['reading', 'open', 'answering'].includes(S.phase)) return;
  const c = S.current;
  if (S.phase === 'answering' && (c.winner === PID || (c.queue || []).includes(PID))) return;
  if (myBuzz === `${c.id}-${c.round}` || c.lockedOut.includes(myEid())) return;
  const localOpen = c.openAt - conn.offset;
  const reaction = Date.now() - localOpen;
  myBuzz = `${c.id}-${c.round}`;
  updatePad();
  const r = await conn.request({ t: 'buzz', reaction });
  if (!r.ok) {
    myBuzz = null;
    if (r.reason === 'early') { toast('Too early! Wait for the buzzer to light up.', true); sfx.vibrate([30, 40, 30]); }
    else if (r.reason === 'penalty') toast('Too early. Locked for a moment.', true);
    else if (r.reason === 'locked') toast('You’re out for this clue.', true);
    else if (r.reason === 'full') toast('The line is full.', true);
    updatePad();
  }
}
document.addEventListener('keydown', (e) => {
  // Laptop players and switch users: Space or Enter buzzes.
  if (ROLE !== 'player' || !$('pad')) return;
  if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) doBuzz(); }
});

/* ---------------- host remote ---------------- */
function renderHost() {
  showGame();
  $('me-name').textContent = 'Host';
  $('me-team').textContent = `Room ${S.code}`;
  $('me-score').textContent = '';
  $('scene').dataset.pose = 'host';
  const ph = S.phase, c = S.current;
  let h = '';
  const btn = (act, label, cls = 'paper', extra = '') => `<button class="btn ${cls}" data-h="${act}" ${extra}>${label}</button>`;
  if (ph === 'setup') { $('stagep').classList.remove('fit'); renderHostSetup(); return; }
  hostSetupBuilt = false;
  if (ph === 'generating') {
    h = `<div class="card hcard"><span class="cat">Writing the board</span><p class="q">${esc(S.gen.topic)}</p><div class="hbar"><i></i></div></div><div class="hbtns">${btn('new-game', 'Cancel', 'line full')}</div>`;
  } else if (ph === 'board') {
    const b = S.board, cols = b.categories.length, rows = b.categories[0].clues.length;
    let g = b.categories.map((cat) => `<div class="hc">${esc(cat.name)}</div>`).join('');
    for (let r = 0; r < rows; r++) for (let ci = 0; ci < cols; ci++) {
      const used = S.used[`${ci}-${r}`], cl = b.categories[ci].clues[r];
      g += `<button class="${used ? 'used' : ''}${cl.dd && !used ? ' dd' : ''}" data-pick="${ci}-${r}" ${used ? 'disabled' : ''}>${used ? '' : valueFor(r)}</button>`;
    }
    h = `<p class="sect">Tap a clue to open it on the TV${S.control ? ` &middot; ${esc(nameOf(S.control))} picks` : ''}</p><div class="hboard" style="--cols:${cols}">${g}</div>
      <div class="hbtns">${btn('start-final', 'Skip to Final Jeopardy', 'line full')}</div>`;
  } else if (c && ['reading', 'open', 'answering', 'reveal', 'dd-clue', 'dd-wager'].includes(ph)) {
    let status = '';
    if (ph === 'reading') status = 'Reading the clue. Buzzers open soon.';
    if (ph === 'open') status = c.lockedOut.length ? `Buzzers open. Out: ${c.lockedOut.map((e) => esc(nameOf(e))).join(', ')}` : 'Buzzers are open.';
    if (ph === 'answering') status = `${esc(playerName(c.winner))} is answering.`;
    if (ph === 'dd-wager') status = `Daily Double! Waiting for ${esc(nameOf(c.ddEntity))} to wager (${money(c.ddBounds.min)} to ${money(c.ddBounds.max)}).`;
    if (ph === 'dd-clue') status = `${esc(nameOf(c.ddEntity))} wagered ${money(c.wager)}.`;
    if (ph === 'reveal') status = c.result === 'correct' ? `${esc(nameOf(c.dd ? c.ddEntity : c.resultEid))} got it.` : 'Nobody got it.';
    h = `<div class="card hcard"><span class="cat">${esc(c.category)} &middot; ${money(c.value)}${c.dd ? ' &middot; Daily Double' : ''}</span>
        <p class="q">${esc(c.clue || '')}</p><p class="a"><small>Answer</small>${esc(c.response || '')}</p><p class="hstatus">${status}</p></div>`;
    let b = '';
    if (ph === 'open' || ph === 'answering') h += hostLine(c);
    if (ph === 'reading') b = btn('open', 'Open buzzers now') + btn('reveal', 'Skip and reveal');
    if (ph === 'open') b = btn('reveal', 'Nobody knows, reveal', 'paper full');
    const judging = ph === 'answering' || ph === 'dd-clue';
    if (judging) b += btn('judge0', '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>', 'jb', 'aria-label="Incorrect"') + (c.revealed ? '' : btn('reveal', 'Reveal', 'line mid', 'aria-label="Reveal answer on TV"')) + btn('judge1', '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11"/></svg>', 'jb', 'aria-label="Correct"');
    if (ph === 'reveal') b = btn('continue', S.tilesLeft <= 1 ? 'On to Final Jeopardy' : 'Back to the board', 'primary full');
    if (ph === 'dd-wager') b = `<form class="full" id="h-wager" style="display:flex;gap:8px"><input id="h-wager-in" inputmode="numeric" placeholder="Wager" style="flex:1;border-radius:12px;border:0;padding:14px;font-size:18px"><button class="btn primary">Set</button></form>`;
    h += `<div class="hbtns${judging ? (c.revealed ? '' : ' judge3') : ''}">${b}</div>`;
  } else if (ph.startsWith('final')) {
    const f = S.final;
    h = `<div class="card hcard"><span class="cat">Final Jeopardy &middot; ${esc(f.category)}</span><p class="q">${esc(f.clue || '')}</p><p class="a"><small>Answer</small>${esc(f.response || '')}</p></div>`;
    h += `<p class="sect">Players</p><div class="flist">${f.eligible.map((e) => `<div class="row"><span>${esc(nameOf(e))}${f.judged[e] != null ? (f.judged[e] ? ' ✓' : ' ✗') : ''}</span><span>${f.wagers[e] != null ? money(f.wagers[e]) : '...'} &middot; <i>${esc(f.responses[e] || (ph === 'final-wager' ? '' : 'no answer'))}</i></span></div>`).join('')}</div>`;
    let b = '';
    if (ph === 'final-wager') b = btn('show-final', 'Show the clue now', 'primary full');
    if (ph === 'final-clue') b = btn('stop-final', 'Stop the clock', 'paper full');
    if (ph === 'final-judge') {
      const next = f.order.find((e) => f.judged[e] == null);
      b = `<p class="sect full">Judging ${esc(nameOf(next))}: <i>${esc(f.responses[next] || 'no answer')}</i></p>` + btn('fjudge0', '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>', 'jb', 'aria-label="Incorrect"') + btn('fjudge1', '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11"/></svg>', 'jb', 'aria-label="Correct"') + (f.revealed ? '' : btn('reveal', 'Show answer on TV', 'line full'));
    }
    h += `<div class="hbtns">${b}</div>`;
  } else if (ph === 'over') {
    h = `<div class="card hcard"><p class="hstatus">Game over. ${S.board && S.board.shareCode ? `Board code ${esc(S.board.shareCode)}.` : ''}</p></div><div class="hbtns">${btn('new-game', 'New board', 'primary full')}</div>`;
  }
  // While a clue is live the screen must fit without scrolling, so scores wait for the board or the reveal.
  const live = ['reading', 'open', 'answering', 'dd-wager', 'dd-clue'].includes(ph) && !!c;
  $('stagep').classList.toggle('fit', live);
  if (ph !== 'generating' && !live) h += `<p class="sect">Scores</p><div class="adj">${entityList().map((e) => `<div class="row"><span>${esc(e.name)}</span><b class="num">${money(e.score)}</b><button data-adj="${e.id}" data-d="-200" aria-label="Take 200 from ${esc(e.name)}">−</button><button data-adj="${e.id}" data-d="200" aria-label="Give 200 to ${esc(e.name)}">+</button>${isTeams() ? '' : `<button class="x${pendingKick === e.id ? ' sure' : ''}" data-kick="${e.id}" aria-label="Remove ${esc(e.name)}">${pendingKick === e.id ? '?' : '&times;'}</button>`}</div>`).join('') || '<div class="row"><span>No players yet</span></div>'}</div>`;
  if (isTeams() || ph === 'generating') h += playersBlock();
  if (!(document.activeElement && document.activeElement.id === 'h-wager-in')) put($('stagep'), h);
}

// Host: everyone who could answer, buzz order first. Tap a name to make them the one being judged; tap again to undo.
function hostLine(c) {
  const q = c.queue || [];
  const outOf = (pid) => c.lockedOut.includes(isTeams() ? (S.players.find((p) => p.id === pid) || {}).team : pid);
  const rest = S.players.filter((p) => !q.includes(p.id)).map((p) => p.id);
  const row = (pid, n) => `<button type="button" class="qrow${pid === c.winner ? ' on' : ''}${outOf(pid) ? ' out' : ''}" data-select="${esc(pid)}" ${outOf(pid) ? 'disabled' : ''}><b>${n || ''}</b><span>${esc(playerName(pid))}</span></button>`;
  return `<div class="qlist${S.players.length > 4 ? ' two' : ''}">${q.map((pid, i) => row(pid, i + 1)).join('')}${rest.map((pid) => row(pid, '')).join('')}</div>`;
}

/* host setup: everything the TV setup screen can do */
let pendingKick = null, kickTimer = null;
let hostSetupBuilt = false, hostAgeTimer = null, hostTopicTimer = null, hostSentTopic = null, hostTopicTypedAt = 0;
function sendHostTopic() { clearTimeout(hostTopicTimer); hostTopicTimer = null; if (!$('hs-topic') || !S || S.phase !== 'setup') return; hostSentTopic = $('hs-topic').value; conn.request({ t: 'settings', settings: { topic: hostSentTopic } }).then(fail); }
const seg = (id, items, attr) => `<div class="hseg" id="${id}">${items.map(([v, l]) => `<button type="button" data-${attr}="${v}">${l}</button>`).join('')}</div>`;
function playersBlock() {
  return `<p class="sect">Players</p><div class="pchips">${S.players.map((p) => `<span class="pchip${p.connected ? '' : ' off'}">${esc(p.name)}${isTeams() && S.teams[p.team] ? ` <small>${esc(S.teams[p.team].name)}</small>` : ''}<button class="x${pendingKick === p.id ? ' sure' : ''}" data-kick="${p.id}" aria-label="Remove ${esc(p.name)}">${pendingKick === p.id ? '?' : '&times;'}</button></span>`).join('') || '<span class="pnone">Nobody yet</span>'}</div>`;
}
function renderHostSetup() {
  if (!hostSetupBuilt) {
    hostSetupBuilt = true;
    put($('stagep'), `<form class="card hcard hsetup" id="hs-form" autocomplete="off">
      <div class="hrow"><input id="hs-topic" maxlength="120" placeholder="Board topic" value="${esc(S.settings.topic || S.gen.topic || '')}"><button type="button" class="btn primary hdice" id="hs-dice" aria-label="Roll a random topic">
        <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="3" width="26" height="26" rx="6"/><circle cx="10" cy="10" r="2.4"/><circle cx="22" cy="10" r="2.4"/><circle cx="16" cy="16" r="2.4"/><circle cx="10" cy="22" r="2.4"/><circle cx="22" cy="22" r="2.4"/></svg></button></div>
      <span class="hl">Ages</span>
      <div class="hchecks" id="hs-ages">${AGE_PRESETS.map(([id, r]) => `<label class="hchk"><input type="checkbox" data-band="${id}"><span>${esc(BANDS[id].label)} <small>${r}</small></span></label>`).join('')}</div>
      <input id="hs-other" maxlength="30" placeholder="Other ages">
      <span class="hl">Difficulty</span>${seg('hs-level', Object.entries(LEVELS).sort((a, b) => a[0] - b[0]), 'level')}
      <details class="htune"><summary class="hl">Question styles</summary><div class="hchecks" id="hs-styles">${STYLE_IDS.map((id) => `<label class="hchk"><input type="checkbox" data-style="${id}"><span>${esc(STYLES[id].label)}</span></label>`).join('')}</div></details>
      <span class="hl">Board</span>${seg('hs-size', [['6x5', 'Classic 6 × 5'], ['4x4', 'Quick 4 × 4']], 'size')}
      <span class="hl">Play as</span>${seg('hs-mode', [['solo', 'Players'], ['teams', 'Teams']], 'mode')}
      <div id="hs-teams-w"><span class="hl">Teams</span>${seg('hs-teams', [['2', '2'], ['3', '3'], ['4', '4']], 'teams')}</div>
      <button class="btn primary wide" id="hs-make">Make the board</button>
      <p class="err" id="hs-err"></p>
      <div class="hrow"><input id="hs-code" maxlength="6" placeholder="Board code" autocapitalize="characters"><button type="button" class="btn line" id="hs-load">Load</button></div>
    </form><div id="hs-players"></div>`);
  }
  const st = S.settings, t = cleanTune(st.tune, st.age || '');
  if (hostSentTopic !== null && (st.topic || '') === hostSentTopic) hostSentTopic = null;
  if (typeof st.topic === 'string' && st.topic !== $('hs-topic').value && !hostTopicTimer && hostSentTopic === null) {
    const quiet = 2000 - (Date.now() - hostTopicTypedAt);
    if (quiet <= 0) $('hs-topic').value = st.topic;
    else setTimeout(() => { if (S && S.phase === 'setup' && hostSetupBuilt) renderHostSetup(); }, quiet + 20);
  }
  if (document.activeElement !== $('hs-other') && !hostAgeTimer) {
    const { bands, other } = splitAges(st.age || '');
    document.querySelectorAll('#hs-ages input').forEach((x) => { x.checked = bands.includes(x.dataset.band); });
    $('hs-other').value = other;
  }
  document.querySelectorAll('#hs-styles input').forEach((x) => { x.checked = t.styles.includes(x.dataset.style); });
  const mark = (id, attr, val) => document.querySelectorAll(`#${id} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === String(val))));
  mark('hs-level', 'level', t.level); mark('hs-size', 'size', st.size); mark('hs-mode', 'mode', st.mode); mark('hs-teams', 'teams', st.teams);
  $('hs-teams-w').hidden = st.mode !== 'teams';
  if (S.gen.status === 'error') $('hs-err').textContent = S.gen.error;
  put($('hs-players'), playersBlock());
}
const hostAges = () => composeAges([...document.querySelectorAll('#hs-ages input')].filter((x) => x.checked).map((x) => x.dataset.band), $('hs-other').value);
async function sendHostAges() {
  clearTimeout(hostAgeTimer); hostAgeTimer = null;
  const age = hostAges(), old = S.settings.age || '';
  if (age === old) return;
  const lvl = cleanTune(S.settings.tune, old).level;
  // A new band re-ticks that band's styles, same rule as the TV.
  fail(await conn.request({ t: 'settings', settings: bandFor(age) !== bandFor(old) ? { age, tune: { ...defaultTune(age), level: lvl } } : { age } }));
}
$('stagep').addEventListener('change', (e) => {
  if (ROLE !== 'host' || !S || S.phase !== 'setup') return;
  if (e.target.closest('#hs-ages')) sendHostAges();
  if (e.target.closest('#hs-styles')) {
    const styles = [...document.querySelectorAll('#hs-styles input')].filter((x) => x.checked).map((x) => x.dataset.style);
    conn.request({ t: 'settings', settings: { tune: { ...cleanTune(S.settings.tune, S.settings.age || ''), styles } } }).then(fail);
  }
});
$('stagep').addEventListener('input', (e) => {
  if (ROLE === 'host' && e.target.id === 'hs-topic') { hostTopicTypedAt = Date.now(); clearTimeout(hostTopicTimer); hostTopicTimer = setTimeout(sendHostTopic, 350); return; }
  if (ROLE !== 'host' || e.target.id !== 'hs-other') return;
  clearTimeout(hostAgeTimer); hostAgeTimer = setTimeout(sendHostAges, 400);
});
$('stagep').addEventListener('submit', async (e) => {
  if (e.target.id !== 'hs-form') return;
  e.preventDefault();
  clearTimeout(hostTopicTimer); hostTopicTimer = null;
  const topic = $('hs-topic').value.trim();
  if (!topic) { $('hs-err').textContent = 'Type a topic or roll the dice.'; return; }
  $('hs-err').textContent = '';
  await sendHostAges();
  $('hs-make').disabled = true;
  const r = await conn.request({ t: 'generate', topic, age: hostAges() });
  if ($('hs-make')) $('hs-make').disabled = false;
  if (!r.ok && $('hs-err')) $('hs-err').textContent = r.err;
});
$('stagep').addEventListener('click', async (e) => {
  if (ROLE !== 'host') return;
  const b = e.target.closest('button'); if (!b) return;
  sfx.unlock();
  if (b.dataset.select) return fail(await conn.request({ t: 'select', pid: b.dataset.select }));
  if (b.id === 'hs-dice') { $('hs-topic').value = rollTopic(hostAges()); sendHostTopic(); return; }
  if (b.id === 'hs-load') { const r = await conn.request({ t: 'load-board', code: $('hs-code').value.trim().toUpperCase() }); if (!r.ok) $('hs-err').textContent = r.err; return; }
  if (b.dataset.level != null) return fail(await conn.request({ t: 'settings', settings: { tune: { ...cleanTune(S.settings.tune, S.settings.age || ''), level: Number(b.dataset.level) } } }));
  if (b.dataset.size) return fail(await conn.request({ t: 'settings', settings: { size: b.dataset.size } }));
  if (b.dataset.mode) return fail(await conn.request({ t: 'settings', settings: { mode: b.dataset.mode } }));
  if (b.dataset.teams) return fail(await conn.request({ t: 'settings', settings: { teams: Number(b.dataset.teams) } }));
  if (b.dataset.pick) { const [c, r] = b.dataset.pick.split('-').map(Number); return fail(await conn.request({ t: 'pick', c, r })); }
  if (b.dataset.adj) return fail(await conn.request({ t: 'adjust', eid: b.dataset.adj, delta: Number(b.dataset.d) }));
  // Remove takes two taps; the first one is remembered across screen refreshes for a few seconds.
  if (b.dataset.kick) {
    const id = b.dataset.kick;
    if (pendingKick === id) { pendingKick = null; clearTimeout(kickTimer); return fail(await conn.request({ t: 'kick', pid: id })); }
    pendingKick = id; clearTimeout(kickTimer); kickTimer = setTimeout(() => { pendingKick = null; render(); }, 4000);
    return render();
  }
  const h = b.dataset.h; if (!h) return;
  if (h === 'judge0' || h === 'judge1') return fail(await conn.request({ t: 'judge', correct: h === 'judge1' }));
  if (h === 'fjudge0' || h === 'fjudge1') return fail(await conn.request({ t: 'final-judge', correct: h === 'fjudge1' }));
  fail(await conn.request({ t: h }));
});
$('stagep').addEventListener('submit', async (e) => {
  if (e.target.id !== 'h-wager') return;
  e.preventDefault();
  fail(await conn.request({ t: 'wager', amount: Number($('h-wager-in').value.replace(/[^0-9]/g, '')) }));
});

/* ---------------- menu ---------------- */
function closeSheet() { $('sheet').hidden = true; $('menu-btn').setAttribute('aria-expanded', 'false'); }
$('menu-btn').addEventListener('click', () => {
  const sheet = $('sheet');
  if (!sheet.hidden) { closeSheet(); return; }
  sheet.hidden = false;
  $('menu-btn').setAttribute('aria-expanded', 'true');
  put($('sheet-card'), ROLE === 'host'
    ? `<h3>Host menu</h3><button class="btn paper wide" data-m="new">Start over with a new board</button><button class="btn line wide" data-m="close">Close</button>`
    : `<h3>Menu</h3><p>${esc(me() ? me().name : '')} in room ${esc(S ? S.code : '')}</p>
       <button class="btn paper wide" data-m="rename">Change my name</button>
       <button class="btn bad wide" data-m="leave">Leave the game</button>
       <button class="btn line wide" data-m="close">Close</button>`);
});
$('sheet').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-m]');
  if (e.target === $('sheet') || (b && b.dataset.m === 'close')) { closeSheet(); return; }
  if (!b) return;
  closeSheet();
  if (b.dataset.m === 'leave') {
    await conn.request({ t: 'leave' });
    store.del('ij-player'); joined = false; joining = false;
    conn.close(); conn = null; S = null;
    showJoin('You left the game.');
  }
  if (b.dataset.m === 'rename') { joined = false; showJoin(); $('name').value = me() ? me().name : ''; $('name').focus(); }
  if (b.dataset.m === 'new') fail(await conn.request({ t: 'new-game' }));
});

/* ---------------- events ---------------- */
function handleEvent() {
  const ev = S.event;
  if (!ev || ev.id <= lastEvent) return;
  lastEvent = ev.id;
  if (ROLE !== 'player') return;
  if (ev.type === 'buzz' && ev.pid === PID) { sfx.vibrate([60, 30, 60]); sfx.play('buzz'); }
  if (ev.type === 'correct' && ev.eid === myEid()) { sfx.vibrate(40); toast(`+${money(Math.abs(ev.delta))}`); }
  if (ev.type === 'incorrect' && ev.eid === myEid()) { sfx.vibrate([80, 40, 80]); toast(`−${money(Math.abs(ev.delta))}`, true); }
  if (ev.type === 'dd' && ev.eid === myEid()) sfx.vibrate([40, 30, 40, 30, 40]);
  if (ev.type === 'open') myBuzz = null;
}

/* ---------------- frame loop: pad opens locally at the exact moment ---------------- */
function frame() {
  if (S && conn && ROLE === 'player' && joined) {
    updatePad();
    const bar = $('pad-bar');
    if (bar && S.current) {
      const now = conn.serverNow(), c = S.current;
      let p = 0;
      if (S.phase === 'open' && c.closesAt) p = Math.max(0, Math.min(1, (c.closesAt - now) / 12000));
      bar.style.transform = `scaleX(${p})`;
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
boot();
