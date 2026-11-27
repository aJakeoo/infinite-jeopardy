// Cloudflare Worker entry: serves the static site (public/) and the game API.
//   POST /api/rooms                 -> { code, tvKey, hostKey }
//   GET  /api/rooms/:code/ws        -> WebSocket into the room's Durable Object
//   GET  /api/boards/:shareCode     -> { ok, board } (does the board code exist?)
//   GET  /api/health                -> { ok, ai }
import * as G from './game.js';
import { generateBoard, UserError } from './boards.js';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const SHARE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const randCode = (alphabet, n) => {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
};
const randKey = () => randCode(SHARE_ALPHABET + 'abcdefghjkmnpqrstuvwxyz', 24);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (parts[0] !== 'api') return env.ASSETS.fetch(req);
      if (parts[1] === 'health') return json({ ok: true, ai: !!env.ANTHROPIC_API_KEY });
      if (parts[1] === 'rooms' && parts.length === 2 && req.method === 'POST') {
        for (let i = 0; i < 8; i++) {
          const code = randCode(ROOM_ALPHABET, 4);
          const stub = env.ROOM.get(env.ROOM.idFromName(code));
          const r = await stub.fetch('https://room/init', { method: 'POST', body: JSON.stringify({ code, tvKey: randKey(), hostKey: randKey() }) });
          if (r.status === 200) return json(await r.json());
        }
        return json({ ok: false, err: 'Could not find a free room code. Try again.' }, 503);
      }
      if (parts[1] === 'rooms' && parts[3] === 'ws') {
        const code = (parts[2] || '').toUpperCase();
        if (!/^[A-Z]{4}$/.test(code)) return json({ ok: false, err: 'Room codes are 4 letters.' }, 400);
        if (req.headers.get('Upgrade') !== 'websocket' && !req.headers.get('x-probe')) return json({ ok: false, err: 'Expected a WebSocket.' }, 426);
        return env.ROOM.get(env.ROOM.idFromName(code)).fetch(req);
      }
      if (parts[1] === 'boards' && parts[2]) {
        const code = parts[2].toUpperCase();
        if (!/^[A-Z2-9]{6}$/.test(code)) return json({ ok: false, err: 'Board codes are 6 characters.' }, 400);
        const r = await env.VAULT.get(env.VAULT.idFromName(code)).fetch('https://vault/get');
        return json(await r.json(), r.status);
      }
      return json({ ok: false, err: 'Not found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ ok: false, err: 'Server error' }, 500);
    }
  },
};

/* ======================================================================
   Room: one Durable Object per 4-letter room code. Holds the game state,
   all sockets (TV, host phones, player phones), and the timers.
   ====================================================================== */
export class Room {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.s = null; this.keys = null; this.resolveTimer = null;
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get('state')) || null;
      this.keys = (await ctx.storage.get('keys')) || null;
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"hb"}', '{"t":"hb"}'));
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/init') {
      if (this.s) return new Response('taken', { status: 409 });
      const { code, tvKey, hostKey } = await req.json();
      this.s = G.newRoom(code, Date.now());
      this.keys = { tvKey, hostKey };
      await this.ctx.storage.put({ state: this.s, keys: this.keys });
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return json({ ok: true, code, tvKey, hostKey });
    }
    // WebSocket upgrade
    if (!this.s) return json({ ok: false, err: 'That room does not exist. Check the code on the TV.' }, 404);
    const role = url.searchParams.get('role') || 'player';
    const k = url.searchParams.get('key') || '';
    if (role === 'tv' && k !== this.keys.tvKey) return json({ ok: false, err: 'This screen is not the TV for that room.' }, 403);
    if (role === 'host' && k !== this.keys.hostKey) return json({ ok: false, err: 'That host link is not valid.' }, 403);
    if (!['tv', 'host', 'player'].includes(role)) return json({ ok: false, err: 'Bad role.' }, 400);
    const pid = role === 'player' ? (url.searchParams.get('pid') || '').slice(0, 40) : null;
    if (role === 'player' && !/^[A-Za-z0-9_-]{8,40}$/.test(pid)) return json({ ok: false, err: 'Bad player id.' }, 400);
    if (req.headers.get('Upgrade') !== 'websocket') return json({ ok: true });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role, pid ? `p:${pid}` : role]);
    server.serializeAttachment({ role, pid, ip: req.headers.get('CF-Connecting-IP') || 'local', rttHalf: 60 });
    const now = Date.now();
    if (pid && this.s.players[pid]) G.setConnected(this.s, pid, true, now);
    this.s.lastActivity = now;
    server.send(JSON.stringify({ t: 'hello', role, pid, now, ai: !!this.env.ANTHROPIC_API_KEY }));
    await this.commit();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const a = ws.deserializeAttachment() || {};
    const now = Date.now();
    if (m.t === 'ping') {
      if (Number.isFinite(m.rtt)) { a.rttHalf = Math.max(0, Math.min(1000, m.rtt / 2)); ws.serializeAttachment(a); }
      ws.send(JSON.stringify({ t: 'pong', c: m.c, now }));
      return;
    }
    if (!this.s) return;
    G.tick(this.s, now);
    let res = { ok: true }, changed = true;
    try {
      res = await this.handle(ws, a, m, now);
      if (res && res.quiet) changed = false;
    } catch (e) {
      console.error(e);
      res = { ok: false, err: 'Something went wrong on the server.' };
    }
    if (m.rid) ws.send(JSON.stringify({ t: 'ack', rid: m.rid, ok: !!(res && res.ok !== false), err: res && res.err, reason: res && res.reason }));
    this.s.lastActivity = now;
    if (changed) await this.commit();
  }

  async handle(ws, a, m, now) {
    const s = this.s;
    const isTv = a.role === 'tv', isHost = a.role === 'host', isPlayer = a.role === 'player';
    const ctrl = isTv || isHost;
    const deny = { ok: false, err: 'Only the TV or the host can do that.' };
    switch (m.t) {
      case 'join': return isPlayer ? G.join(s, a.pid, m.name, m.team, now) : { ok: false, err: 'Only players join.' };
      case 'leave': return isPlayer ? G.removePlayer(s, a.pid, now) : deny;
      case 'buzz': {
        if (!isPlayer) return { ok: false };
        const r = G.buzz(s, a.pid, Number(m.reaction), a.rttHalf, now);
        this.scheduleResolve();
        return { ok: r.ok, reason: r.reason, quiet: !r.ok && r.reason !== 'early' };
      }
      case 'wager': {
        if (isPlayer) return G.wager(s, G.entityOf(s, a.pid), m.amount, now);
        if (ctrl) return G.wager(s, m.eid ?? (s.phase === 'dd-wager' ? s.current.ddEntity : null), m.amount, now);
        return deny;
      }
      case 'final-answer': return isPlayer ? G.finalAnswer(s, G.entityOf(s, a.pid), m.text, now) : deny;
    }
    if (!ctrl) return deny;
    switch (m.t) {
      case 'settings': return G.setSettings(s, m.settings || {});
      case 'generate': return this.generate(m, a, now);
      case 'load-board': return this.loadBoard(m.code, now);
      case 'pick': return G.pick(s, m.c | 0, m.r | 0, now);
      case 'open': return G.openNow(s, now);
      case 'reveal': return G.reveal(s, now);
      case 'judge': return G.judge(s, !!m.correct, now);
      case 'continue': return G.continueGame(s, now);
      case 'start-final': return s.phase === 'board' ? G.startFinal(s, now) : { ok: false, err: 'Finish the clue first.' };
      case 'show-final': return G.showFinalClue(s, now);
      case 'stop-final': return G.stopFinal(s, now);
      case 'final-judge': return G.finalJudge(s, m.eid ?? null, !!m.correct, now);
      case 'adjust': return G.adjust(s, m.eid, m.delta, now);
      case 'kick': return G.removePlayer(s, m.pid, now);
      case 'new-game': return G.newGame(s, now);
      default: return { ok: false, err: 'Unknown action.', quiet: true };
    }
  }

  async generate(m, a, now) {
    const s = this.s;
    if (!['setup', 'over'].includes(s.phase)) return { ok: false, err: 'Finish this game before making a new board.' };
    if (s.gen.status === 'working') return { ok: false, err: 'Already making a board.' };
    if (m.settings) G.setSettings(s, m.settings);
    const topic = String(m.topic || '').trim().slice(0, G.LIMITS.TOPIC);
    const age = String(m.age ?? s.settings.age ?? '').trim().slice(0, G.LIMITS.AGE);
    if (!topic) return { ok: false, err: 'Type what the board should be about, or roll the dice.' };
    if (this.env.ANTHROPIC_API_KEY) {
      const lim = await this.env.LIMITER.get(this.env.LIMITER.idFromName('global')).fetch('https://limiter/take', { method: 'POST', body: JSON.stringify({ ip: a.ip }) });
      const lj = await lim.json();
      if (!lj.ok) return { ok: false, err: lj.err };
    }
    s.gen = { status: 'working', error: null, topic, age, startedAt: now };
    s.phase = 'generating';
    await this.commit();
    // Generate in the background so the socket stays responsive.
    this.ctx.waitUntil(this.runGeneration({ topic, age, size: s.settings.size, tune: s.settings.tune }));
    return { ok: true, quiet: true };
  }

  async runGeneration(req) {
    let board = null, error = null;
    try { board = await generateBoard(this.env, req); }
    catch (e) { error = e instanceof UserError ? e.message : 'Could not make a board. Try again.'; if (!(e instanceof UserError)) console.error(e); }
    const s = this.s, now = Date.now();
    if (s.phase !== 'generating') return;
    if (!board) {
      s.phase = 'setup';
      s.gen = { ...s.gen, status: 'error', error };
      await this.commit();
      return;
    }
    board.shareCode = await this.saveBoard(board);
    G.setBoard(s, board, now);
    await this.commit();
  }

  async saveBoard(board) {
    const plain = { title: board.title, topic: board.topic, age: board.age, demo: !!board.demo,
      categories: board.categories.map((c) => ({ name: c.name, clues: c.clues.map((x) => ({ clue: x.clue, response: x.response })) })), final: board.final };
    for (let i = 0; i < 6; i++) {
      const code = randCode(SHARE_ALPHABET, 6);
      const r = await this.env.VAULT.get(this.env.VAULT.idFromName(code)).fetch('https://vault/put', { method: 'POST', body: JSON.stringify(plain) });
      if (r.status === 200) return code;
    }
    return null;
  }

  async loadBoard(code, now) {
    const s = this.s;
    if (!['setup', 'over'].includes(s.phase)) return { ok: false, err: 'Finish this game before loading a board.' };
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z2-9]{6}$/.test(code)) return { ok: false, err: 'Board codes are 6 letters and numbers.' };
    const r = await this.env.VAULT.get(this.env.VAULT.idFromName(code)).fetch('https://vault/get');
    const j = await r.json();
    if (!j.ok) return { ok: false, err: 'No board has that code.' };
    const b = j.board;
    const size = `${b.categories.length}x${b.categories[0].clues.length}`;
    if (G.SIZES[size]) s.settings.size = size;
    G.setBoard(s, { ...b, shareCode: code }, now);
    s.gen = { status: 'idle', error: null, topic: b.topic || '', age: b.age || '' };
    return { ok: true };
  }

  scheduleResolve() {
    const s = this.s;
    if (s.phase === 'open' && s.current && s.current.windowEnd && !this.resolveTimer) {
      const wait = Math.max(0, s.current.windowEnd - Date.now()) + 2;
      this.resolveTimer = setTimeout(async () => {
        this.resolveTimer = null;
        if (G.tick(this.s, Date.now())) await this.commit();
      }, wait);
    }
  }

  async alarm() {
    const now = Date.now();
    if (!this.s) return;
    if (now - this.s.lastActivity > ROOM_TTL_MS && this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.s = null;
      return;
    }
    if (G.tick(this.s, now)) await this.commit();
    else await this.armAlarm();
  }

  async armAlarm() {
    const wake = G.nextWake(this.s);
    const fallback = Date.now() + ROOM_TTL_MS;
    await this.ctx.storage.setAlarm(wake ? Math.max(Date.now() + 5, wake + 2) : fallback);
  }

  async webSocketClose(ws) { await this.dropSocket(ws); }
  async webSocketError(ws) { await this.dropSocket(ws); }
  async dropSocket(ws) {
    const a = ws.deserializeAttachment() || {};
    if (!this.s || !a.pid) return;
    const still = this.ctx.getWebSockets(`p:${a.pid}`).some((w) => w !== ws && w.readyState === 1);
    if (!still && G.setConnected(this.s, a.pid, false, Date.now())) await this.commit();
  }

  async commit() {
    await this.ctx.storage.put('state', this.s);
    await this.armAlarm();
    this.broadcast();
    this.scheduleResolve();
  }

  broadcast() {
    const now = Date.now();
    const cache = {};
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1) continue;
      const a = ws.deserializeAttachment() || {};
      const k = a.role === 'player' ? `p:${a.pid}` : a.role;
      if (!cache[k]) cache[k] = JSON.stringify({ t: 'state', now, s: G.view(this.s, a.role, a.pid) });
      try { ws.send(cache[k]); } catch { /* socket closing */ }
    }
  }
}

/* ======================================================================
   BoardVault: one tiny Durable Object per share code. Write-once.
   ====================================================================== */
export class BoardVault {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/put') {
      if (await this.ctx.storage.get('board')) return new Response('taken', { status: 409 });
      await this.ctx.storage.put('board', await req.json());
      return json({ ok: true });
    }
    const board = await this.ctx.storage.get('board');
    return board ? json({ ok: true, board }) : json({ ok: false, err: 'No board has that code.' }, 404);
  }
}

/* ======================================================================
   Limiter: protects the AI budget. A daily cap for the whole site and an
   hourly cap per IP address. Both are set in wrangler.jsonc vars.
   ====================================================================== */
export class Limiter {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(req) {
    const { ip } = await req.json();
    const day = new Date().toISOString().slice(0, 10);
    const hour = new Date().toISOString().slice(0, 13);
    const dailyMax = Number(this.env.DAILY_BOARD_LIMIT || 100);
    const ipMax = Number(this.env.HOURLY_BOARDS_PER_IP || 12);
    const dKey = `d:${day}`, iKey = `i:${hour}:${ip}`;
    const [d, i] = await Promise.all([this.ctx.storage.get(dKey), this.ctx.storage.get(iKey)]);
    if ((d || 0) >= dailyMax) return json({ ok: false, err: 'Infinite Jeopardy has made its boards for today. Try again tomorrow, or load a board code.' });
    if ((i || 0) >= ipMax) return json({ ok: false, err: 'You have made a lot of boards this hour. Take a breather and try again soon.' });
    await this.ctx.storage.put({ [dKey]: (d || 0) + 1, [iKey]: (i || 0) + 1 });
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 26 * 3600 * 1000);
    return json({ ok: true });
  }
  async alarm() {
    // Clear old counters once a day.
    const today = new Date().toISOString().slice(0, 10);
    const all = await this.ctx.storage.list();
    const old = [...all.keys()].filter((k) => !k.includes(today));
    if (old.length) await this.ctx.storage.delete(old);
    await this.ctx.storage.setAlarm(Date.now() + 26 * 3600 * 1000);
  }
}
