// Infinite Jeopardy game engine.
// Pure state machine: every function takes the room state and a `now` (ms) and mutates the state.
// The Durable Object (src/room.js) owns persistence, sockets and timers; this file owns the rules,
// so the rules can be unit-tested in plain Node without Cloudflare.

export const SIZES = {
  '6x5': { cols: 6, rows: 5, dd: 2 },
  '4x4': { cols: 4, rows: 4, dd: 1 },
};
export const valueFor = (row) => (row + 1) * 200;

export const T = {
  READ_MS_PER_CHAR: 45, READ_MIN: 2500, READ_MAX: 7000, // buzzers open after the clue has been read
  OPEN_MS: 12000,        // how long buzzers stay open before time runs out
  REOPEN_MS: 8000,       // after a wrong answer, remaining players get this long
  BUZZ_WINDOW: 120,      // after the first buzz arrives, wait this long for faster-but-laggier buzzes
  EARLY_PENALTY: 250,    // buzzing before the buzzers open locks you out this long
  OPEN_GRACE: 150,       // a buzz this close before openAt counts as on time (clock drift)
  FINAL_MS: 30000,
  LATENCY_SLACK: 80,
};
export const LIMITS = { PLAYERS: 24, NAME: 16, RESPONSE: 80, TOPIC: 120, AGE: 30 };
export const TEAM_NAMES = ['Sky', 'Hill', 'Dune', 'Tide'];

const PHASES_WITH_CLUE = new Set(['reading', 'open', 'answering', 'reveal', 'dd-clue']);

export function newRoom(code, now) {
  return {
    v: 1, code, createdAt: now, lastActivity: now, seq: 0,
    phase: 'setup',
    settings: { size: '6x5', mode: 'solo', teams: 2 },
    gen: { status: 'idle', error: null, topic: '', age: '' },
    board: null, used: {}, players: {}, teams: {}, control: null,
    current: null, final: null, event: null,
  };
}

/* ---------------- helpers ---------------- */

const err = (e) => ({ ok: false, err: e });
const OK = { ok: true };
const key = (c, r) => `${c}-${r}`;
export const isTeams = (s) => s.settings.mode === 'teams';
export function entityOf(s, pid) {
  const p = s.players[pid];
  if (!p) return null;
  return isTeams(s) ? p.team : pid;
}
export function entityName(s, eid) {
  if (isTeams(s)) return s.teams[eid] ? s.teams[eid].name : '?';
  return s.players[eid] ? s.players[eid].name : '?';
}
export function scoreOf(s, eid) {
  if (isTeams(s)) return s.teams[eid] ? s.teams[eid].score : 0;
  return s.players[eid] ? s.players[eid].score : 0;
}
function addScore(s, eid, delta) {
  if (isTeams(s)) { if (s.teams[eid]) s.teams[eid].score += delta; }
  else if (s.players[eid]) s.players[eid].score += delta;
}
export function entities(s) {
  if (isTeams(s)) return Object.keys(s.teams);
  return Object.keys(s.players);
}
function connectedEntities(s) {
  const out = new Set();
  for (const p of Object.values(s.players)) if (p.connected) out.add(isTeams(s) ? p.team : p.id);
  out.delete(undefined); out.delete(null);
  return out;
}
function event(s, type, data, now) {
  s.seq += 1;
  s.event = { id: s.seq, type, at: now, ...data };
}
export function boardDims(board) {
  return { cols: board.categories.length, rows: board.categories[0].clues.length };
}
function maxBoardValue(s) {
  const { rows } = boardDims(s.board);
  return valueFor(rows - 1);
}
export function readMs(text) {
  return Math.max(T.READ_MIN, Math.min(T.READ_MAX, 1500 + text.length * T.READ_MS_PER_CHAR));
}
export function tilesLeft(s) {
  if (!s.board) return 0;
  const { cols, rows } = boardDims(s.board);
  let n = 0;
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) if (!s.used[key(c, r)]) n++;
  return n;
}
function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.NAME);
}

/* ---------------- settings, players, teams ---------------- */

export function setSettings(s, next) {
  if (!['setup', 'over'].includes(s.phase)) return err('Settings can only change before a game starts.');
  if (next.size && SIZES[next.size]) s.settings.size = next.size;
  if (next.mode === 'solo' || next.mode === 'teams') s.settings.mode = next.mode;
  if (Number.isInteger(next.teams) && next.teams >= 2 && next.teams <= 4) s.settings.teams = next.teams;
  syncTeams(s);
  return OK;
}

function syncTeams(s) {
  if (!isTeams(s)) return;
  const want = s.settings.teams;
  for (let i = 0; i < want; i++) {
    const id = `t${i + 1}`;
    if (!s.teams[id]) s.teams[id] = { id, name: `Team ${TEAM_NAMES[i]}`, score: 0 };
  }
  for (const id of Object.keys(s.teams)) if (Number(id.slice(1)) > want) delete s.teams[id];
  for (const p of Object.values(s.players)) if (!s.teams[p.team]) p.team = smallestTeam(s);
}

function smallestTeam(s) {
  const counts = Object.keys(s.teams).map((id) => [id, Object.values(s.players).filter((p) => p.team === id).length]);
  counts.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  return counts.length ? counts[0][0] : null;
}

export function join(s, pid, rawName, team, now) {
  const name = cleanName(rawName);
  if (!pid || typeof pid !== 'string' || pid.length > 40) return err('Bad player id.');
  if (!name) return err('Type a name to join.');
  const existing = s.players[pid];
  if (!existing && Object.keys(s.players).length >= LIMITS.PLAYERS) return err(`This room is full (${LIMITS.PLAYERS} players).`);
  // Keep names unique so the TV never shows two "Sam"s.
  let finalName = name;
  const taken = (n) => Object.values(s.players).some((p) => p.id !== pid && p.name.toLowerCase() === n.toLowerCase());
  for (let i = 2; taken(finalName); i++) finalName = `${name.slice(0, LIMITS.NAME - 2)} ${i}`;
  if (existing) {
    existing.name = finalName;
  } else {
    s.players[pid] = { id: pid, name: finalName, score: 0, team: null, connected: true, joinedAt: now };
  }
  if (isTeams(s)) {
    syncTeams(s);
    const p = s.players[pid];
    if (team && s.teams[team]) p.team = team;
    else if (!p.team || !s.teams[p.team]) p.team = smallestTeam(s);
  }
  event(s, existing ? 'update' : 'join', { pid }, now);
  return OK;
}

export function removePlayer(s, pid, now) {
  if (!s.players[pid]) return err('No such player.');
  delete s.players[pid];
  if (!isTeams(s) && s.control === pid) s.control = null;
  if (s.current) {
    if (s.current.winner === pid) { s.current.winner = null; if (s.phase === 'answering') reopenOrReveal(s, now); }
    s.current.buzzes = (s.current.buzzes || []).filter((b) => b.pid !== pid);
    if (!isTeams(s) && s.current.ddEntity === pid) s.current.ddEntity = null;
  }
  if (s.final && !isTeams(s)) {
    s.final.eligible = s.final.eligible.filter((e) => e !== pid);
    delete s.final.wagers[pid]; delete s.final.responses[pid]; delete s.final.judged[pid];
  }
  maybeAdvance(s, now);
  return OK;
}

export function setConnected(s, pid, connected, now) {
  const p = s.players[pid];
  if (!p || p.connected === connected) return false;
  p.connected = connected;
  maybeAdvance(s, now);
  return true;
}

/* ---------------- boards ---------------- */

export function setBoard(s, board, now, rand = Math.random) {
  s.board = structuredClone(board);
  placeDailyDoubles(s.board, rand);
  s.used = {}; s.current = null; s.final = null; s.control = null;
  for (const p of Object.values(s.players)) p.score = 0;
  for (const t of Object.values(s.teams)) t.score = 0;
  s.gen = { ...s.gen, status: 'idle', error: null };
  s.phase = 'board';
  event(s, 'board', {}, now);
  return OK;
}

export function placeDailyDoubles(board, rand = Math.random) {
  const { cols, rows } = boardDims(board);
  const n = cols >= 6 ? 2 : 1;
  const weights = rows === 5 ? [0, 0.12, 0.3, 0.33, 0.25] : [0, 0.25, 0.4, 0.35];
  for (const cat of board.categories) for (const clue of cat.clues) clue.dd = false;
  const catOrder = [...Array(cols).keys()];
  for (let i = catOrder.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [catOrder[i], catOrder[j]] = [catOrder[j], catOrder[i]]; }
  for (let k = 0; k < n; k++) {
    let x = rand(), row = rows - 1;
    for (let r = 0; r < rows; r++) { x -= weights[r] || 0; if (x < 0) { row = r; break; } }
    board.categories[catOrder[k]].clues[row].dd = true;
  }
}

/* ---------------- clue flow ---------------- */

export function pick(s, c, r, now) {
  if (s.phase !== 'board') return err('Pick a clue from the board.');
  const cat = s.board.categories[c];
  const clue = cat && cat.clues[r];
  if (!clue) return err('That clue does not exist.');
  if (s.used[key(c, r)]) return err('That clue has been played.');
  s.current = {
    id: s.seq + 1, c, r, value: valueFor(r), dd: !!clue.dd,
    openAt: null, closesAt: null, windowEnd: null,
    buzzes: [], lockedOut: [], penalty: {}, winner: null, revealed: false,
    result: null, wager: null, ddEntity: null, by: null,
  };
  if (clue.dd) {
    const ents = entities(s);
    if (ents.length === 0) { s.current.dd = false; }
    else {
      let dde = s.control && ents.includes(s.control) ? s.control : null;
      if (!dde) dde = ents.slice().sort((a, b) => scoreOf(s, b) - scoreOf(s, a))[0];
      s.current.ddEntity = dde;
      s.phase = 'dd-wager';
      event(s, 'dd', { eid: dde }, now);
      return OK;
    }
  }
  s.phase = 'reading';
  s.current.openAt = now + readMs(clue.clue);
  event(s, 'pick', { c, r }, now);
  return OK;
}

export function openNow(s, now) {
  if (s.phase !== 'reading') return err('Buzzers are not waiting to open.');
  s.current.openAt = now;
  goOpen(s, now);
  return OK;
}

function goOpen(s, now) {
  s.phase = 'open';
  s.current.closesAt = now + T.OPEN_MS;
  s.current.windowEnd = null;
  s.current.buzzes = [];
  event(s, 'open', {}, now);
}

function eligibleToBuzz(s) {
  const conn = connectedEntities(s);
  for (const e of s.current.lockedOut) conn.delete(e);
  return conn;
}

export function buzz(s, pid, reported, rttHalf, now) {
  const p = s.players[pid];
  if (!p) return { ok: false, reason: 'not-joined' };
  const eid = entityOf(s, pid);
  const cur = s.current;
  if (s.phase === 'reading' && cur && now >= cur.openAt - T.OPEN_GRACE) {
    cur.openAt = Math.min(cur.openAt, now);
    goOpen(s, now);
  }
  if (s.phase === 'reading') {
    cur.penalty[pid] = now + T.EARLY_PENALTY;
    return { ok: false, reason: 'early' };
  }
  if (s.phase !== 'open') return { ok: false, reason: 'closed' };
  if (cur.lockedOut.includes(eid)) return { ok: false, reason: 'locked' };
  if ((cur.penalty[pid] || 0) > now) return { ok: false, reason: 'penalty' };
  if (cur.buzzes.some((b) => b.pid === pid)) return { ok: true, reason: 'dupe' };
  // Fairness: phones report how long after the buzzers opened they tapped (their own clock).
  // Never trust a report that is faster than the server could physically have seen it.
  const elapsed = now - cur.openAt;
  const floor = Math.max(0, elapsed - (rttHalf || 0) - T.LATENCY_SLACK);
  let reaction = Number.isFinite(reported) ? reported : elapsed;
  reaction = Math.max(floor, Math.min(reaction, elapsed + 50), 0);
  cur.buzzes.push({ pid, eid, at: now, reaction });
  if (!cur.windowEnd) cur.windowEnd = now + T.BUZZ_WINDOW;
  return { ok: true, reason: 'queued' };
}

function resolveBuzz(s, now) {
  const cur = s.current;
  const valid = cur.buzzes.filter((b) => s.players[b.pid] && !cur.lockedOut.includes(b.eid));
  cur.windowEnd = null;
  cur.buzzes = [];
  if (!valid.length) return;
  valid.sort((a, b) => a.reaction - b.reaction || a.at - b.at);
  const w = valid[0];
  cur.winner = w.pid;
  cur.runnerUp = valid[1] ? { pid: valid[1].pid, ms: Math.round(valid[1].reaction - w.reaction) } : null;
  s.phase = 'answering';
  event(s, 'buzz', { pid: w.pid }, now);
}

function reopenOrReveal(s, now) {
  const cur = s.current;
  if (!cur.revealed && eligibleToBuzz(s).size > 0) {
    s.phase = 'open';
    cur.closesAt = now + T.REOPEN_MS;
    cur.windowEnd = null; cur.buzzes = [];
    event(s, 'open', {}, now);
  } else {
    s.phase = 'reveal';
    cur.revealed = true;
    cur.result = cur.result || 'nobody';
  }
}

export function reveal(s, now) {
  const cur = s.current;
  if (s.phase === 'reading' || s.phase === 'open') {
    s.phase = 'reveal'; cur.revealed = true; cur.result = 'skipped';
    event(s, 'reveal', {}, now);
    return OK;
  }
  if (s.phase === 'answering' || s.phase === 'dd-clue') {
    cur.revealed = true;
    event(s, 'reveal', {}, now);
    return OK;
  }
  if (s.phase === 'final-judge' && s.final) { s.final.revealed = true; event(s, 'reveal', {}, now); return OK; }
  return err('Nothing to reveal right now.');
}

export function judge(s, correct, now) {
  const cur = s.current;
  if (s.phase === 'answering') {
    const pid = cur.winner;
    const eid = entityOf(s, pid);
    if (eid == null) { reopenOrReveal(s, now); return OK; }
    if (correct) {
      addScore(s, eid, cur.value);
      s.control = eid;
      cur.result = 'correct'; cur.revealed = true; cur.resultEid = eid;
      s.phase = 'reveal';
      event(s, 'correct', { pid, eid, delta: cur.value }, now);
    } else {
      addScore(s, eid, -cur.value);
      cur.lockedOut.push(eid);
      cur.winner = null;
      cur.result = 'incorrect';
      event(s, 'incorrect', { pid, eid, delta: -cur.value }, now);
      reopenOrReveal(s, now);
    }
    return OK;
  }
  if (s.phase === 'dd-clue') {
    const eid = cur.ddEntity;
    const w = cur.wager || 0;
    addScore(s, eid, correct ? w : -w);
    if (correct) s.control = eid;
    cur.result = correct ? 'correct' : 'incorrect';
    cur.revealed = true;
    s.phase = 'reveal';
    event(s, correct ? 'correct' : 'incorrect', { eid, delta: correct ? w : -w }, now);
    return OK;
  }
  return err('Nobody is answering right now.');
}

export function continueGame(s, now) {
  if (s.phase !== 'reveal') return err('Finish this clue first.');
  const cur = s.current;
  s.used[key(cur.c, cur.r)] = true;
  s.current = null;
  if (tilesLeft(s) === 0) return startFinal(s, now);
  s.phase = 'board';
  event(s, 'board', {}, now);
  return OK;
}

export function ddBounds(s, eid) {
  return { min: 5, max: Math.max(scoreOf(s, eid), maxBoardValue(s)) };
}

export function wager(s, eid, amount, now) {
  const n = Math.round(Number(amount));
  if (!Number.isFinite(n)) return err('Type a number.');
  if (s.phase === 'dd-wager') {
    if (eid !== s.current.ddEntity) return err('Only the Daily Double player can wager.');
    const { min, max } = ddBounds(s, eid);
    if (n < min || n > max) return err(`Wager between $${min} and $${max.toLocaleString('en-US')}.`);
    s.current.wager = n;
    s.phase = 'dd-clue';
    event(s, 'dd-wager', { eid, wager: n }, now);
    return OK;
  }
  if (s.phase === 'final-wager') {
    if (!s.final.eligible.includes(eid)) return err('You are not in Final Jeopardy.');
    const max = Math.max(0, scoreOf(s, eid));
    if (n < 0 || n > max) return err(`Wager between $0 and $${max.toLocaleString('en-US')}.`);
    s.final.wagers[eid] = n;
    event(s, 'final-wager', { eid }, now);
    if (s.final.eligible.every((e) => s.final.wagers[e] != null)) showFinalClue(s, now);
    return OK;
  }
  return err('No wager is needed right now.');
}

/* ---------------- final ---------------- */

export function startFinal(s, now) {
  if (!s.board) return err('No board loaded.');
  if (s.current && s.phase !== 'board') return err('Finish this clue first.');
  s.current = null;
  const eligible = entities(s).filter((e) => scoreOf(s, e) > 0);
  if (!s.board.final || eligible.length === 0) {
    s.phase = 'over';
    s.final = s.board.final ? { eligible: [], wagers: {}, responses: {}, judged: {}, order: [], revealed: true, closesAt: null, skipped: true } : null;
    event(s, 'over', {}, now);
    return OK;
  }
  s.final = { eligible, wagers: {}, responses: {}, judged: {}, order: [], revealed: false, closesAt: null };
  s.phase = 'final-wager';
  event(s, 'final', {}, now);
  return OK;
}

export function showFinalClue(s, now) {
  if (s.phase !== 'final-wager') return err('Not waiting on final wagers.');
  for (const e of s.final.eligible) if (s.final.wagers[e] == null) s.final.wagers[e] = 0;
  s.phase = 'final-clue';
  s.final.closesAt = now + T.FINAL_MS;
  event(s, 'final-clue', {}, now);
  return OK;
}

export function finalAnswer(s, eid, text, now) {
  if (s.phase !== 'final-clue') return err('Final answers are closed.');
  if (!s.final.eligible.includes(eid)) return err('You are not in Final Jeopardy.');
  s.final.responses[eid] = String(text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, LIMITS.RESPONSE);
  return OK;
}

export function stopFinal(s, now) {
  if (s.phase !== 'final-clue') return err('The final clue is not running.');
  s.phase = 'final-judge';
  // Reveal from lowest score to highest, like the show.
  s.final.order = s.final.eligible.slice().sort((a, b) => scoreOf(s, a) - scoreOf(s, b));
  s.final.closesAt = null;
  event(s, 'final-judge', {}, now);
  return OK;
}

export function finalJudge(s, eid, correct, now) {
  if (s.phase !== 'final-judge') return err('Not judging Final Jeopardy.');
  const next = s.final.order.find((e) => s.final.judged[e] == null);
  if (eid == null) eid = next;
  if (!s.final.eligible.includes(eid) || s.final.judged[eid] != null) return err('Already judged.');
  const w = s.final.wagers[eid] || 0;
  addScore(s, eid, correct ? w : -w);
  s.final.judged[eid] = !!correct;
  event(s, correct ? 'correct' : 'incorrect', { eid, delta: correct ? w : -w, final: true }, now);
  if (s.final.order.every((e) => s.final.judged[e] != null)) {
    s.final.revealed = true;
    s.phase = 'over';
    event(s, 'over', {}, now);
  }
  return OK;
}

/* ---------------- misc ---------------- */

export function adjust(s, eid, delta, now) {
  const d = Math.round(Number(delta));
  if (!Number.isFinite(d) || Math.abs(d) > 100000) return err('Bad amount.');
  if (isTeams(s) ? !s.teams[eid] : !s.players[eid]) return err('No such player.');
  addScore(s, eid, d);
  event(s, 'adjust', { eid, delta: d }, now);
  return OK;
}

export function newGame(s, now) {
  s.phase = 'setup';
  s.board = null; s.used = {}; s.current = null; s.final = null; s.control = null;
  s.gen = { status: 'idle', error: null, topic: s.gen.topic, age: s.gen.age };
  for (const p of Object.values(s.players)) p.score = 0;
  for (const t of Object.values(s.teams)) t.score = 0;
  event(s, 'setup', {}, now);
  return OK;
}

/* ---------------- time ---------------- */

// Advance any timed transitions that are due. Returns true if something changed.
export function tick(s, now) {
  let changed = false;
  for (let guard = 0; guard < 5; guard++) {
    const cur = s.current;
    if (s.phase === 'reading' && cur && now >= cur.openAt) { goOpen(s, cur.openAt); changed = true; continue; }
    if (s.phase === 'open' && cur && cur.windowEnd && now >= cur.windowEnd) { resolveBuzz(s, now); changed = true; continue; }
    if (s.phase === 'open' && cur && !cur.windowEnd && now >= cur.closesAt) {
      s.phase = 'reveal'; cur.revealed = true; cur.result = cur.result === 'incorrect' ? 'incorrect' : 'timeout';
      event(s, 'timeout', {}, now); changed = true; continue;
    }
    if (s.phase === 'final-clue' && s.final && now >= s.final.closesAt) { stopFinal(s, now); changed = true; continue; }
    break;
  }
  return changed;
}

function maybeAdvance(s, now) {
  // If everyone who could still buzz has left, end the clue instead of waiting.
  if (s.phase === 'open' && s.current && !s.current.windowEnd && eligibleToBuzz(s).size === 0 && Object.keys(s.players).length === 0) {
    s.phase = 'reveal'; s.current.revealed = true; s.current.result = 'nobody';
  }
  if (s.phase === 'final-wager' && s.final && s.final.eligible.length && s.final.eligible.every((e) => s.final.wagers[e] != null)) showFinalClue(s, now);
}

export function nextWake(s) {
  const cur = s.current;
  if (s.phase === 'reading' && cur) return cur.openAt;
  if (s.phase === 'open' && cur) return cur.windowEnd || cur.closesAt;
  if (s.phase === 'final-clue' && s.final) return s.final.closesAt;
  return null;
}

/* ---------------- views (what each screen is allowed to see) ---------------- */

export function view(s, role, pid) {
  const host = role === 'host';
  const v = {
    code: s.code, phase: s.phase, settings: s.settings, gen: s.gen, seq: s.seq, event: s.event,
    control: s.control, used: s.used, teams: s.teams, mode: s.settings.mode,
    players: Object.values(s.players).map((p) => ({ id: p.id, name: p.name, score: p.score, team: p.team, connected: p.connected })),
    board: null, current: null, final: null, tilesLeft: tilesLeft(s),
  };
  if (s.board) {
    v.board = {
      topic: s.board.topic, age: s.board.age, title: s.board.title, shareCode: s.board.shareCode || null, demo: !!s.board.demo,
      categories: s.board.categories.map((cat) => ({
        name: cat.name,
        clues: cat.clues.map((cl) => (host ? { clue: cl.clue, response: cl.response, dd: cl.dd } : {})),
      })),
      finalCategory: s.board.final ? s.board.final.category : null,
    };
  }
  const cur = s.current;
  if (cur) {
    const clue = s.board.categories[cur.c].clues[cur.r];
    const showClue = s.phase !== 'dd-wager' || host;
    v.current = {
      id: cur.id, c: cur.c, r: cur.r, value: cur.value, dd: cur.dd, category: s.board.categories[cur.c].name,
      clue: showClue ? clue.clue : null,
      response: host || cur.revealed ? clue.response : null,
      openAt: cur.openAt, closesAt: cur.closesAt, winner: cur.winner, runnerUp: cur.runnerUp || null,
      lockedOut: cur.lockedOut, revealed: cur.revealed, result: cur.result, resultEid: cur.resultEid ?? null,
      wager: cur.wager, ddEntity: cur.ddEntity,
      ddBounds: cur.ddEntity != null ? ddBounds(s, cur.ddEntity) : null,
    };
  }
  if (s.final && s.board && s.board.final) {
    const f = s.final, fb = s.board.final;
    const myE = pid ? entityOf(s, pid) : null;
    const judging = s.phase === 'final-judge' || s.phase === 'over';
    v.final = {
      category: fb.category,
      clue: s.phase === 'final-wager' && !host ? null : fb.clue,
      response: host || f.revealed || s.phase === 'over' ? fb.response : null,
      eligible: f.eligible, closesAt: f.closesAt, order: f.order, judged: f.judged, revealed: f.revealed, skipped: !!f.skipped,
      wagered: Object.fromEntries(f.eligible.map((e) => [e, f.wagers[e] != null])),
      answered: Object.fromEntries(f.eligible.map((e) => [e, !!f.responses[e]])),
      wagers: host || judging ? f.wagers : (myE != null && f.wagers[myE] != null ? { [myE]: f.wagers[myE] } : {}),
      responses: host || judging ? f.responses : (myE != null && f.responses[myE] != null ? { [myE]: f.responses[myE] } : {}),
    };
  }
  return v;
}
