// TV / laptop screen: creates the room, shows the board, and can run the whole game by itself.
import { Conn, storage, esc, money, put } from './net.js';
import { rollTopic } from './topics.js';
import { STYLES, STYLE_IDS, BANDS, bandFor, defaultTune, cleanTune, tuneSummary, AGE_PRESETS, composeAges, splitAges, agesLabel } from './tuning.js';
import * as sfx from './sfx.js';

const $ = (id) => document.getElementById(id);
const store = storage();
const CRED_KEY = 'ij-tv';
const ROOM_TTL = 12 * 3600 * 1000;
const valueFor = (r) => (r + 1) * 200;

let conn = null, S = null, creds = null, lastEvent = 0, ai = false, curScreen = null, lastClueId = null;
const qrCache = {};

/* ---------------- start / resume ---------------- */
function savedCreds() {
  try { const c = JSON.parse(store.get(CRED_KEY) || 'null'); return c && Date.now() - c.at < ROOM_TTL ? c : null; } catch { return null; }
}
function boot() {
  const c = savedCreds();
  if (c) { $('resume').hidden = false; $('resume-code').textContent = c.code; }
  show('s-home');
}
$('start').addEventListener('click', async () => {
  sfx.unlock();
  $('start').disabled = true; $('home-err').textContent = '';
  try {
    const r = await fetch('/api/rooms', { method: 'POST' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.err || 'Could not start a room.');
    creds = { code: j.code, tvKey: j.tvKey, hostKey: j.hostKey, at: Date.now() };
    store.set(CRED_KEY, JSON.stringify(creds));
    connect();
  } catch (e) {
    $('home-err').textContent = e.message && !/fetch|network/i.test(e.message) ? e.message : 'Could not reach the game server. Check the connection and try again.';
  } finally { $('start').disabled = false; }
});
$('resume').addEventListener('click', () => { sfx.unlock(); creds = savedCreds(); if (creds) connect(); else boot(); });

function connect() {
  if (conn) conn.close();
  S = null; lastEvent = 0;
  conn = new Conn({
    code: creds.code, role: 'tv', key: creds.tvKey,
    onHello: (m) => { ai = m.ai; },
    onState: (s) => { const first = !S; S = s; if (first) lastEvent = s.event ? s.event.id : 0; render(); },
    onStatus: (st) => { $('net').hidden = st === 'online'; $('net').textContent = st === 'dead' ? 'Room closed' : 'Reconnecting...'; },
    onFatal: (msg) => { store.del(CRED_KEY); creds = null; conn = null; S = null; $('resume').hidden = true; show('s-home'); $('home-err').textContent = msg; },
  });
}

/* ---------------- screens ---------------- */
const PHASE_SCREEN = { setup: 's-setup', generating: 's-generating', board: 's-board', reading: 's-clue', open: 's-clue', answering: 's-clue', reveal: 's-clue', 'dd-clue': 's-clue', 'dd-wager': 's-dd', 'final-wager': 's-final', 'final-clue': 's-final', 'final-judge': 's-final', over: 's-over' };
function show(id) {
  if (curScreen === id) return;
  curScreen = id;
  document.querySelectorAll('.screen').forEach((el) => el.classList.toggle('on', el.id === id));
  const scene = $('scene');
  scene.dataset.pose = $(id).dataset.pose;
  $('tools').hidden = id === 's-home';
  if (id === 's-home') setMenu(false);
  document.body.classList.toggle('in-game', id !== 's-home' && id !== 's-setup');
}

function render() {
  if (!S) return;
  show(PHASE_SCREEN[S.phase] || 's-setup');
  handleEvent();
  if (S.phase === 'setup') renderSetup();
  if (S.phase === 'generating') renderGenerating();
  if (S.phase === 'board') renderBoard();
  if (PHASE_SCREEN[S.phase] === 's-clue') renderClue();
  if (S.phase === 'dd-wager') renderDD();
  if (PHASE_SCREEN[S.phase] === 's-final') renderFinal();
  if (S.phase === 'over') renderOver();
  renderMenu();
  renderOverlay();
}

/* ---------------- shared bits ---------------- */
const joinUrl = () => `${location.origin}/play?room=${creds.code}`;
const hostUrl = () => `${location.origin}/play?room=${creds.code}&role=host&key=${encodeURIComponent(creds.hostKey)}`;
function qrSvg(text) {
  if (qrCache[text]) return qrCache[text];
  try {
    const q = window.qrcode(0, 'M'); q.addData(text); q.make();
    qrCache[text] = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch { qrCache[text] = ''; }
  return qrCache[text];
}
const playersSorted = () => S.players.slice();
function entityList() {
  if (S.mode === 'teams') return Object.values(S.teams).map((t) => ({ id: t.id, name: t.name, score: t.score, connected: S.players.some((p) => p.team === t.id && p.connected), members: S.players.filter((p) => p.team === t.id).map((p) => p.name) }));
  return playersSorted().map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected }));
}
const nameOf = (eid) => { const e = entityList().find((x) => x.id === eid); return e ? e.name : 'Someone'; };
const playerName = (pid) => { const p = S.players.find((x) => x.id === pid); return p ? p.name : 'Someone'; };

function joinCard(compact) {
  const lobby = S.mode === 'teams'
    ? `<div class="teamcols" style="--n:${Object.keys(S.teams).length}">${Object.values(S.teams).map((t) => `<div class="team"><h4>${esc(t.name)}</h4>${S.players.filter((p) => p.team === t.id).map((p) => `<span>${esc(p.name)}</span>`).join('') || '<span class="lobby-empty">&nbsp;</span>'}</div>`).join('')}</div>`
    : `<div class="lobby">${S.players.length ? S.players.map((p) => `<span class="chip${p.connected ? '' : ' off'}">${esc(p.name)}${compact ? '' : `<button type="button" data-kick="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">&times;</button>`}</span>`).join('') : ''}</div>`;
  return `<div class="qr" role="img" aria-label="QR code to join room ${esc(S.code)}">${qrSvg(joinUrl())}</div>
    ${compact ? `<div class="count">${S.players.length || ''}</div>` : lobby}`;
}

/* ---------------- setup ---------------- */
let setupInit = false;
function renderSetup() {
  if (!setupInit) {
    setupInit = true;
    const t0 = S.settings.topic || (S.gen && S.gen.topic) || '';
    if (t0 && !$('topic').value) $('topic').value = t0;
    const age0 = (S.settings && S.settings.age) || (S.gen && S.gen.age) || '';
    $('age-checks').innerHTML = AGE_PRESETS.map(([id, r]) => `<label class="check"><input type="checkbox" data-band="${id}"><span>${esc(BANDS[id].label)} <small>${r}</small></span></label>`).join('');
    setAges(age0);
    $('style-checks').innerHTML = STYLE_IDS.map((id) => `<label class="check"><input type="checkbox" data-style="${id}"><span>${esc(STYLES[id].label)}</span></label>`).join('');
    setTimeout(() => $('topic').focus(), 300);
  }
  const st = S.settings;
  document.querySelectorAll('#size-seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.size === st.size)));
  document.querySelectorAll('#mode-seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === st.mode)));
  document.querySelectorAll('#teams-seg button').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.teams) === st.teams)));
  $('teams-field').hidden = st.mode !== 'teams';
  // Follow the host phone's typing unless someone is typing here.
  if (sentTopic !== null && (st.topic || '') === sentTopic) sentTopic = null;
  if (typeof st.topic === 'string' && st.topic !== $('topic').value && !topicTimer && sentTopic === null) {
    const quiet = 2000 - (Date.now() - topicTypedAt);
    if (quiet <= 0) $('topic').value = st.topic;
    else setTimeout(() => { if (S && S.phase === 'setup') renderSetup(); }, quiet + 20);
  }
  // The host phone can change the ages too; follow it unless someone is editing them here.
  if (sentAge !== null && (st.age || '') === sentAge) sentAge = null;
  if ($('ages-pop').hidden && !ageTimer && sentAge === null && ageValue() !== (st.age || '')) { setAges(st.age || ''); lastBand = bandFor(st.age || ''); }
  renderTune();
  $('setup-err').textContent = S.gen && S.gen.status === 'error' ? S.gen.error : $('setup-err').dataset.local || '';
  $('demo-note').hidden = ai;
  put($('join-card'), joinCard(false));
}
let topicTimer = null, sentTopic = null, topicTypedAt = 0;
function sendTopic() { clearTimeout(topicTimer); topicTimer = null; if (!S || S.phase !== 'setup') return; sentTopic = $('topic').value; setting({ topic: sentTopic }); }
$('topic').addEventListener('input', () => { topicTypedAt = Date.now(); clearTimeout(topicTimer); topicTimer = setTimeout(sendTopic, 350); });
function setting(obj) { conn.request({ t: 'settings', settings: obj }).then(fail); }

/* fine tune: the age picks a band and pre-ticks its styles; players can then tick and untick */
/* ages: a dropdown of band checkboxes plus an Other box, joined into one string like "7-9, 18+" */
function ageValue() {
  const bands = [...document.querySelectorAll('#age-checks input')].filter((x) => x.checked).map((x) => x.dataset.band);
  return composeAges(bands, $('age').value);
}
function setAges(text) {
  const { bands, other } = splitAges(text);
  document.querySelectorAll('#age-checks input').forEach((x) => { x.checked = bands.includes(x.dataset.band); });
  $('age').value = other;
  $('ages-sum').textContent = agesLabel(text);
}
function setAgesOpen(open) {
  $('ages-pop').hidden = !open;
  $('ages-btn').setAttribute('aria-expanded', String(open));
  if (open) $('tune').open = false;
}
$('ages-btn').addEventListener('click', () => setAgesOpen($('ages-pop').hidden));
document.addEventListener('pointerdown', (e) => { if (!$('ages-pop').hidden && !e.target.closest('#ages')) setAgesOpen(false); });
$('ages-pop').addEventListener('keydown', (e) => { if (e.key === 'Escape' || (e.key === 'Enter' && e.target.id === 'age')) { e.preventDefault(); e.stopPropagation(); setAgesOpen(false); $('ages-btn').focus(); } });
$('age-checks').addEventListener('change', agesChanged);
const curTune = () => cleanTune(S.settings.tune, ageValue());
function renderTune() {
  const age = ageValue(), t = curTune(), b = BANDS[bandFor(age)];
  $('ages-sum').textContent = agesLabel(age);
  document.querySelectorAll('#level-seg button').forEach((x) => x.setAttribute('aria-checked', String(Number(x.dataset.level) === t.level)));
  document.querySelectorAll('#style-checks input').forEach((x) => { x.checked = t.styles.includes(x.dataset.style); });
  $('tune-sum').textContent = tuneSummary(age, t);
  const custom = JSON.stringify(t.styles) !== JSON.stringify(defaultTune(age).styles);
  $('tune-note').textContent = `${age.trim() ? `Set for ${b.label.toLowerCase()}` : 'Set for adults'}${custom ? ', fine tuned' : ''}.`;
}
let ageTimer = null, lastBand = null, sentAge = null;
$('age').addEventListener('input', agesChanged);
function agesChanged() {
  $('ages-sum').textContent = agesLabel(ageValue());
  clearTimeout(ageTimer);
  ageTimer = setTimeout(() => {
    ageTimer = null;
    const age = ageValue(), band = bandFor(age);
    sentAge = age;
    if (lastBand == null) lastBand = bandFor(S.settings.age || '');
    // A new age band resets the boxes to that band's picks; typing within the same band keeps any fine tuning.
    if (band !== lastBand) setting({ age, tune: { ...defaultTune(age), level: curTune().level } });
    else setting({ age });
    lastBand = band;
    renderTune();
  }, 300);
}
// Only one of the two drop-downs open at a time, so the setup card always fits the screen.
$('tune').addEventListener('toggle', () => { if ($('tune').open) { $('loadcode').open = false; setAgesOpen(false); } });
$('loadcode').addEventListener('toggle', () => { if ($('loadcode').open) $('tune').open = false; });
$('level-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setting({ tune: { ...curTune(), level: Number(b.dataset.level) } }); });
$('style-checks').addEventListener('change', () => {
  const styles = [...document.querySelectorAll('#style-checks input')].filter((x) => x.checked).map((x) => x.dataset.style);
  setting({ tune: { ...curTune(), styles } });
});
$('size-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setting({ size: b.dataset.size }); });
$('mode-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setting({ mode: b.dataset.mode }); });
$('teams-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setting({ teams: Number(b.dataset.teams) }); });
$('dice').addEventListener('click', () => {
  $('topic').value = rollTopic(ageValue());
  sendTopic();
  const d = $('dice'); d.classList.remove('rolling'); void d.offsetWidth; d.classList.add('rolling');
  $('setup-err').dataset.local = ''; $('setup-err').textContent = '';
});
$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  sfx.unlock();
  let topic = $('topic').value.trim();
  if (!topic) { $('setup-err').textContent = $('setup-err').dataset.local = 'Type what the board should be about, or roll the dice.'; $('topic').focus(); return; }
  $('make').disabled = true;
  clearTimeout(ageTimer); ageTimer = null;
  setAgesOpen(false);
  const age = ageValue();
  if (age !== (S.settings.age || '')) await conn.request({ t: 'settings', settings: bandFor(age) !== bandFor(S.settings.age || '') ? { age, tune: { ...defaultTune(age), level: curTune().level } } : { age } });
  lastBand = bandFor(age);
  const r = await conn.request({ t: 'generate', topic, age });
  $('make').disabled = false;
  if (!r.ok) { $('setup-err').textContent = $('setup-err').dataset.local = r.err; }
  else $('setup-err').dataset.local = '';
});
$('load').addEventListener('click', loadCode);
$('code-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadCode(); } });
async function loadCode() {
  const code = $('code-in').value.trim().toUpperCase();
  const r = await conn.request({ t: 'load-board', code });
  if (!r.ok) $('setup-err').textContent = $('setup-err').dataset.local = r.err;
}
$('join-card').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kick]');
  if (b) conn.request({ t: 'kick', pid: b.dataset.kick }).then(fail);
});

/* ---------------- generating ---------------- */
const GEN_LINES = ['Picking categories...', 'Writing the easy ones...', 'Making the hard ones harder...', 'Checking the facts...', 'Hiding the Daily Doubles...', 'Writing Final Jeopardy...', 'Almost there...'];
let genTimer = null;
function renderGenerating() {
  $('gen-topic').textContent = S.gen.topic;
  const g = $('gen-fill');
  g.dataset.start = S.gen.startedAt || Date.now();
  g.dataset.tau = S.settings.size === '4x4' ? 14000 : 22000;
  put($('join-card-2'), joinCard(true));
  if (!genTimer) {
    let i = 0; $('gen-line').textContent = GEN_LINES[0];
    genTimer = setInterval(() => {
      if (!S || S.phase !== 'generating') { clearInterval(genTimer); genTimer = null; return; }
      i = Math.min(i + 1, GEN_LINES.length - 1); $('gen-line').textContent = GEN_LINES[i];
    }, 2600);
  }
}

/* ---------------- board ---------------- */
let boardKey = null;
function renderBoard() {
  const b = S.board;
  const cols = b.categories.length, rows = b.categories[0].clues.length;
  const grid = $('grid');
  grid.style.setProperty('--cols', cols); grid.style.setProperty('--rows', rows);
  const k = `${b.shareCode}|${b.title}`;
  const fresh = boardKey !== k; boardKey = k;
  let html = b.categories.map((c) => `<div class="cat">${esc(c.name)}</div>`).join('');
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const used = S.used[`${c}-${r}`];
    html += `<button class="tile${used ? ' used' : ''}${fresh ? ' flip' : ''}" data-c="${c}" data-r="${r}" ${used ? 'disabled aria-label="Played"' : `aria-label="${esc(b.categories[c].name)} for ${valueFor(r)}"`} style="${fresh ? `animation-delay:${(r * cols + c) * 18}ms` : ''}">${used ? '' : `$${valueFor(r)}`}</button>`;
  }
  if (fresh) { grid._html = null; }
  put(grid, html);
  put($('bar-join'), `<div class="qr" role="img" aria-label="QR code to join room ${esc(S.code)}">${qrSvg(joinUrl())}</div>`);
  put($('bar-topic'), `<i>${esc(b.title || b.topic)}</i>${b.demo ? '<small>Demo board</small>' : ''}`);
  renderScores();
}
function renderScores() {
  const ents = entityList();
  put($('scores'), ents.length ? ents.map((e) => `<div class="score${e.score < 0 ? ' neg' : ''}${e.connected ? '' : ' off'}${S.control === e.id ? ' picks' : ''}"><span>${esc(e.name)}</span><b class="num">${money(e.score)}</b></div>`).join('')
    : '');
}
$('grid').addEventListener('click', (e) => {
  const t = e.target.closest('.tile');
  if (!t || t.disabled) return;
  sfx.unlock();
  conn.request({ t: 'pick', c: Number(t.dataset.c), r: Number(t.dataset.r) }).then(fail);
});

/* ---------------- clue ---------------- */
function renderClue() {
  const c = S.current;
  if (!c) return;
  if (c.id !== lastClueId) { lastClueId = c.id; }
  $('clue-cat').textContent = c.category;
  $('clue-val').textContent = c.dd && c.wager != null ? `Daily Double · ${money(c.wager)}` : money(c.value);
  const t = $('clue-text');
  t.textContent = c.clue || '';
  t.classList.toggle('long', (c.clue || '').length > 90 && (c.clue || '').length <= 130);
  t.classList.toggle('xlong', (c.clue || '').length > 130);
  const ans = $('answer');
  $('s-clue').classList.toggle('revealed', !!(c.revealed && c.response));
  if (c.revealed && c.response) {
    let res = '';
    if (S.phase === 'reveal') {
      if (c.result === 'correct') res = `<span class="res good">${esc(c.dd ? nameOf(c.ddEntity) : nameOf(c.resultEid))} ${c.dd ? '+' + money(c.wager) : '+' + money(c.value)}</span>`;
      else if (c.result === 'timeout') res = '<span class="res">Time ran out</span>';
      else if (c.result === 'skipped') res = '<span class="res">Nobody answered</span>';
      else if (c.result === 'incorrect') res = `<span class="res bad">${c.dd ? esc(nameOf(c.ddEntity)) + ' −' + money(c.wager) : 'Nobody got it'}</span>`;
      else res = '<span class="res">Nobody got it</span>';
    }
    put(ans, `<small>Correct response</small><b>${esc(c.response)}</b>${res}`);
    ans.hidden = false;
  } else { ans.hidden = true; ans._html = null; }
  renderClueStatus();
  renderClueControls();
}
function lockedNames(c) {
  if (!c.lockedOut.length) return '';
  return `<span class="locked">Out: ${c.lockedOut.map((e) => esc(nameOf(e))).join(', ')}</span>`;
}
function renderClueStatus() {
  const c = S.current, el = $('clue-status');
  el.classList.toggle('buzzed', S.phase === 'answering');
  if (S.phase === 'reading') put(el, `<span class="msg">Reading the clue...</span><span class="track"><i data-from="${c.openAt - readSpan(c)}" data-to="${c.openAt}" data-dir="fill"></i></span>`);
  else if (S.phase === 'open') put(el, `<span class="msg">Buzz in now!</span>${lockedNames(c)}<span class="track"><i data-from="${c.closesAt - 12000}" data-to="${c.closesAt}" data-dir="drain"></i></span><span class="secs num" data-until="${c.closesAt}"></span>`);
  else if (S.phase === 'answering') put(el, `<div><div class="buzzer-name">${esc(playerName(c.winner))}${S.mode === 'teams' ? ` <span class="buzzer-sub">(${esc(teamOfPid(c.winner))})</span>` : ''}</div>${lineChips(c)}</div>`);
  else if (S.phase === 'dd-clue') put(el, `<span class="msg">${esc(nameOf(c.ddEntity))} answers for ${money(c.wager)}</span>`);
  else put(el, '');
}
// The buzz line: tap a name to make them the one answering.
function lineChips(c) {
  const q = c.queue || [];
  if (q.length < 2) return '';
  return `<div class="line">${q.map((pid, i) => { const out = c.lockedOut.includes(S.mode === 'teams' ? (S.players.find((p) => p.id === pid) || {}).team : pid); return `<button class="lchip${pid === c.winner ? ' on' : ''}${out ? ' out' : ''}" data-select="${esc(pid)}" ${out ? 'disabled' : ''}><b>${i + 1}</b>${esc(playerName(pid))}</button>`; }).join('')}</div>`;
}
const teamOfPid = (pid) => { const p = S.players.find((x) => x.id === pid); return p && S.teams[p.team] ? S.teams[p.team].name : ''; };
const readSpan = (c) => Math.max(2500, Math.min(7000, 1500 + (c.clue || '').length * 45));
const K = (k) => ` <span class="kbd">${k}</span>`;
function renderClueControls() {
  const c = S.current, el = $('clue-controls');
  let h = '';
  if (S.phase === 'reading') h = `<button class="btn on-hill" data-act="open">Open buzzers now${K('O')}</button><button class="btn on-hill" data-act="reveal">Skip and reveal${K('R')}</button>`;
  else if (S.phase === 'open') h = `<button class="btn on-hill" data-act="reveal">Nobody knows, reveal${K('R')}</button>`;
  else if (S.phase === 'answering' || S.phase === 'dd-clue') {
    h = c.revealed
      ? `<button class="btn jb" data-act="judge" data-correct="0" aria-label="Incorrect"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>${K('X')}</button><button class="btn jb" data-act="judge" data-correct="1" aria-label="Correct"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11"/></svg>${K('C')}</button>`
      : `<button class="btn paper" data-act="reveal">Reveal answer${K('R')}</button><button class="btn jb" data-act="judge" data-correct="0" aria-label="Incorrect"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>${K('X')}</button><button class="btn jb" data-act="judge" data-correct="1" aria-label="Correct"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11"/></svg>${K('C')}</button>`;
  } else if (S.phase === 'reveal') h = `<button class="btn paper" data-act="continue">${S.tilesLeft <= 1 ? 'On to Final Jeopardy' : 'Back to the board'}${K('Space')}</button>`;
  put(el, h);
}

/* ---------------- daily double ---------------- */
function renderDD() {
  const c = S.current;
  $('dd-cat').textContent = `${c.category} · ${money(c.value)}`;
  const b = c.ddBounds || { min: 5, max: 1000 };
  $('dd-who').innerHTML = `${esc(nameOf(c.ddEntity))}, make your wager on your phone<br><span class="num">${money(b.min)} to ${money(b.max)}</span>`;
  $('dd-amt').placeholder = `${b.min}-${b.max}`;
}
$('dd-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await conn.request({ t: 'wager', amount: $('dd-amt').value.replace(/[^0-9]/g, '') });
  $('dd-err').textContent = r.ok ? '' : r.err;
  if (r.ok) $('dd-amt').value = '';
});

/* ---------------- final ---------------- */
function renderFinal() {
  const f = S.final; if (!f) return;
  const el = $('final'), ctl = $('final-controls');
  if (S.phase === 'final-wager') {
    put(el, `<h2>Final Jeopardy</h2><p class="fcat">${esc(f.category)}</p>
      <div class="wagers">${f.eligible.map((e) => `<span class="wchip${f.wagered[e] ? ' done' : ''}">${esc(nameOf(e))}</span>`).join('')}</div>
      <p style="margin-top:1.2em">Make your wager on your phone. Anyone at $0 or below sits this one out.</p>`);
    put(ctl, `<button class="btn paper" data-act="show-final">Show the clue${K('Space')}</button>`);
  } else if (S.phase === 'final-clue') {
    put(el, `<h2>Final Jeopardy</h2><p class="fcat">${esc(f.category)}</p>
      <div class="wagers">${f.eligible.map((e) => `<span class="wchip${f.answered[e] ? ' done' : ''}">${esc(nameOf(e))}</span>`).join('')}</div>
      <p class="fclue">${esc(f.clue)}</p>
      <div class="ftimer"><span class="track"><i data-from="${f.closesAt - 30000}" data-to="${f.closesAt}" data-dir="drain"></i></span><span class="secs num" data-until="${f.closesAt}"></span></div>`);
    put(ctl, `<button class="btn on-hill" data-act="stop-final">Stop the clock</button>`);
  } else if (S.phase === 'final-judge') {
    const next = f.order.find((e) => f.judged[e] == null);
    const said = f.responses[next];
    const done = f.order.filter((e) => f.judged[e] != null).length;
    put(el, `<h2>Final Jeopardy</h2><p class="fcat">${esc(f.category)}</p>
      <div class="card judge"><p class="who">${esc(nameOf(next))}</p>
        <p class="said${said ? '' : ' blank'}">${said ? esc(said) : 'No written answer'}</p>
        <p class="wag num">Wagered ${money(f.wagers[next] || 0)}</p>
        ${f.revealed ? `<div class="correct"><small>Correct response</small><b>${esc(f.response || '')}</b></div>` : ''}
        <p class="progress">${done + 1} of ${f.order.length}</p></div>`);
    put(ctl, `${f.revealed ? '' : `<button class="btn on-hill" data-act="reveal">Show correct response${K('R')}</button>`}<button class="btn jb" data-act="final-judge" data-correct="0" aria-label="Incorrect"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>${K('X')}</button><button class="btn jb" data-act="judge-final-ok" data-correct="1" aria-label="Correct"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11"/></svg>${K('C')}</button>`);
  }
}

/* ---------------- game over ---------------- */
function renderOver() {
  const ents = entityList().sort((a, b) => b.score - a.score);
  const top = ents[0];
  const tie = ents.length > 1 && ents[1].score === top.score;
  const b = S.board;
  put($('over'), `<p class="eyebrow">Game over</p>
    <h2 class="champ">${!top ? 'Thanks for playing' : tie ? 'It’s a tie!' : `${esc(top.name)} wins!`}</h2>
    ${S.final && S.final.response ? `<p>Final answer: <i>${esc(S.final.response)}</i></p>` : ''}
    <div class="podium">${ents.map((e, i) => `<div class="p${i === 0 ? ' first' : ''}"><span>${esc(e.name)}</span><b class="num">${money(e.score)}</b></div>`).join('')}</div>
    <div class="after">
      ${b && b.shareCode ? `<div class="code">Board <b>${esc(b.shareCode)}</b></div>` : ''}
      <div class="row"><button class="btn paper big" data-act="new-game">New board</button>${b && b.shareCode ? `<button class="btn on-hill big" data-act="replay" data-code="${esc(b.shareCode)}">Play this board again</button>` : ''}</div>
    </div>`);
}

/* ---------------- actions ---------------- */
function fail(r) { if (r && !r.ok && r.err) toast(r.err, true); return r; }
async function act(name, el) {
  if (!conn) return;
  sfx.unlock();
  if (name === 'judge') return conn.request({ t: 'judge', correct: el.dataset.correct === '1' }).then(fail);
  if (name === 'final-judge' || name === 'judge-final-ok') return conn.request({ t: 'final-judge', correct: el.dataset.correct === '1' }).then(fail);
  if (name === 'replay') { await conn.request({ t: 'new-game' }); return conn.request({ t: 'load-board', code: el.dataset.code }).then(fail); }
  if (name === 'new-game') { setupInit = false; }
  return conn.request({ t: name }).then(fail);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && !b.disabled) { e.preventDefault(); act(b.dataset.act, b); }
  const sel = e.target.closest('[data-select]');
  if (sel && !sel.disabled && conn) conn.request({ t: 'select', pid: sel.dataset.select }).then(fail);
  const o = e.target.closest('[data-overlay]');
  if (o) openOverlay(o.dataset.overlay);
});

/* ---------------- overlays & tools ---------------- */
let overlay = null;
function openOverlay(kind) { overlay = kind; setMenu(false); renderOverlay(); }
function closeOverlay() { overlay = null; renderOverlay(); }
function renderOverlay() {
  const wrap = $('overlay');
  if (!overlay || !creds) { wrap.hidden = true; return; }
  wrap.hidden = false;
  let h = '';
  if (overlay === 'join') h = `<div class="qr big">${qrSvg(joinUrl())}</div><p class="ov-code">${esc(location.host)}/play &middot; <b>${esc(creds.code)}</b></p><button class="btn primary" data-close>Done</button>`;
  else if (overlay === 'host') h = `<h3>Host phone</h3><div class="qr big">${qrSvg(hostUrl())}</div><p>Sees every answer. Keep it away from players.</p><button class="btn primary" data-close>Done</button>`;
  else if (overlay === 'confirm-new') h = `<h3>Start over?</h3><p>Scores reset and everyone stays in the room.</p><div class="row"><button class="btn bad" data-act="new-game" data-close>Start over</button><button class="btn line" data-close>Keep playing</button></div>`;
  else if (overlay === 'confirm-leave') h = `<h3>Close this room?</h3><p>This screen goes back to the start. Phones stay connected to the old room until they leave.</p><div class="row"><button class="btn bad" id="leave-room">Close room</button><button class="btn line" data-close>Keep playing</button></div>`;
  put($('ov'), h);
}
$('overlay').addEventListener('click', (e) => {
  if (e.target === $('overlay') || e.target.closest('[data-close]')) setTimeout(closeOverlay, 0);
  if (e.target.closest('#leave-room')) { store.del(CRED_KEY); if (conn) conn.close(); conn = null; S = null; creds = null; closeOverlay(); setupInit = false; $('resume').hidden = true; show('s-home'); }
});
$('mute').addEventListener('click', () => { sfx.setMuted(!sfx.isMuted()); syncMute(); });
function syncMute() { $('mute-l').textContent = sfx.isMuted() ? 'Sound off' : 'Sound on'; }

/* the hamburger: swings the panel out from the corner */
let menuOpen = false;
function setMenu(open) {
  menuOpen = open;
  $('tools').classList.toggle('open', open);
  $('burger').setAttribute('aria-expanded', String(open));
  $('burger').setAttribute('aria-label', open ? 'Close menu' : 'Menu');
  $('menu-panel').inert = !open;
  if (open) renderMenu();
}
function renderMenu() {
  if (!creds) return;
  $('menu-code').textContent = creds.code;
  $('menu-url').textContent = `${location.host}/play`;
  const code = S && S.board && S.board.shareCode;
  $('menu-board').hidden = !code;
  $('menu-board-code').textContent = code || '';
  $('mi-final').hidden = !(S && S.phase === 'board');
  $('mi-new').hidden = !(S && S.phase !== 'setup');
}
$('burger').addEventListener('click', () => setMenu(!menuOpen));
$('menu-panel').addEventListener('click', (e) => { if (e.target.closest('[data-act]')) setMenu(false); });
document.addEventListener('pointerdown', (e) => { if (menuOpen && !e.target.closest('#tools')) setMenu(false); });
$('fs').addEventListener('click', toggleFs);
function toggleFs() { try { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); } catch {} }

/* ---------------- keyboard ---------------- */
document.addEventListener('keydown', (e) => {
  sfx.unlock();
  if (e.key === 'Escape' && overlay) { closeOverlay(); return; }
  if (e.key === 'Escape' && menuOpen) { setMenu(false); $('burger').focus(); return; }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
  if (typing || e.metaKey || e.ctrlKey || e.altKey || !S) return;
  const k = e.key.toLowerCase();
  const click = (sel) => { const b = document.querySelector(`.screen.on ${sel}`); if (b) { e.preventDefault(); b.click(); return true; } return false; };
  if (k === ' ' || k === 'enter') { if (document.activeElement && document.activeElement.classList.contains('tile')) return; click('[data-act="continue"]') || click('[data-act="show-final"]') || click('[data-act="reveal"]'); }
  else if (k === 'r') click('[data-act="reveal"]');
  else if (k === 'c') click('[data-correct="1"]');
  else if (k === 'x') click('[data-correct="0"]');
  else if (k === 'o') click('[data-act="open"]');
  else if (k === 'j') openOverlay('join');
  else if (k === 'h') openOverlay('host');
  else if (k === 'm') { sfx.setMuted(!sfx.isMuted()); syncMute(); }
  else if (k === 'f') toggleFs();
});

/* ---------------- events -> sound + toasts ---------------- */
function handleEvent() {
  const ev = S.event;
  if (!ev || ev.id <= lastEvent) return;
  lastEvent = ev.id;
  const map = { open: 'open', buzz: 'buzz', correct: 'correct', incorrect: 'wrong', timeout: 'timeout', dd: 'dd', final: 'final', pick: 'pick', join: 'join' };
  if (map[ev.type]) sfx.play(map[ev.type]);
  if (ev.type === 'join') { const p = S.players.find((x) => x.id === ev.pid); if (p) toast(`${p.name} joined`); }
  if (ev.type === 'adjust') toast(`${nameOf(ev.eid)} ${ev.delta >= 0 ? '+' : '−'}${money(Math.abs(ev.delta)).replace('−', '')}`);
  if (ev.type === 'incorrect' && !ev.final && S.phase === 'open') toast(`${nameOf(ev.eid)} −${money(Math.abs(ev.delta))}`, true);
  if (ev.type === 'correct' && ev.final) toast(`${nameOf(ev.eid)} +${money(ev.delta)}`);
  if (ev.type === 'incorrect' && ev.final) toast(`${nameOf(ev.eid)} −${money(Math.abs(ev.delta))}`, true);
}
function toast(text, bad) {
  const t = document.createElement('div');
  t.className = `toast${bad ? ' bad' : ''}`; t.textContent = text;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 3400);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
}

/* ---------------- timers (progress bars, seconds) ---------------- */
let lastTickSec = null;
function frame() {
  if (conn && S) {
    const now = conn.serverNow();
    document.querySelectorAll('.screen.on [data-to]').forEach((i) => {
      const from = Number(i.dataset.from), to = Number(i.dataset.to);
      let p = Math.max(0, Math.min(1, (now - from) / (to - from)));
      if (i.dataset.dir === 'drain') p = 1 - p;
      i.style.transform = `scaleX(${p})`;
    });
    const gf = $('gen-fill');
    if (curScreen === 's-generating' && gf.dataset.start) {
      // Haiku's time varies, so the bar eases toward 95% and never claims to be done before the board arrives.
      const p = 0.95 * (1 - Math.exp(-(now - Number(gf.dataset.start)) / Number(gf.dataset.tau)));
      gf.style.transform = `scaleX(${Math.max(0.03, p)})`;
      $('gen-bar').setAttribute('aria-valuenow', String(Math.round(p * 100)));
    }
    document.querySelectorAll('.screen.on [data-until]').forEach((s) => {
      const left = Math.max(0, Math.ceil((Number(s.dataset.until) - now) / 1000));
      s.textContent = left;
      if (S.phase === 'final-clue' && left !== lastTickSec && left <= 10 && left > 0) { lastTickSec = left; sfx.play('tick'); }
    });
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
let mouseTimer = null;
document.addEventListener('mousemove', () => { document.body.classList.add('mouse'); clearTimeout(mouseTimer); mouseTimer = setTimeout(() => document.body.classList.remove('mouse'), 2500); });
syncMute();
boot();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
