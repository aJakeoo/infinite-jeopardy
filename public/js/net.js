// WebSocket connection to a room, with auto-reconnect, request/ack, and server clock sync.
export class Conn {
  constructor({ code, role, key, pid, onState, onHello, onStatus, onFatal, onMsg }) {
    Object.assign(this, { code, role, key, pid, onState, onHello, onStatus, onFatal, onMsg });
    this.ws = null; this.rid = 0; this.pending = new Map(); this.offsets = []; this.offset = 0; this.rtt = 0;
    this.retry = 0; this.closed = false; this.status = 'connecting'; this.lastMsg = 0;
    this.connect();
    this.pinger = setInterval(() => this.ping(), 2500);
    this.watchdog = setInterval(() => {
      if (this.ws && this.ws.readyState === 1 && Date.now() - this.lastMsg > 9000) { try { this.ws.close(); } catch {} }
    }, 3000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.kick(); });
    window.addEventListener('online', () => this.kick());
  }
  url() {
    const p = new URLSearchParams({ role: this.role });
    if (this.key) p.set('key', this.key);
    if (this.pid) p.set('pid', this.pid);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/api/rooms/${this.code}/ws?${p}`;
  }
  setStatus(s) { if (this.status !== s) { this.status = s; this.onStatus && this.onStatus(s); } }
  kick() { if (!this.ws || this.ws.readyState > 1) { clearTimeout(this.retryTimer); this.connect(); } else this.ping(); }
  async connect() {
    if (this.closed) return;
    this.setStatus(this.retry ? 'reconnecting' : 'connecting');
    let ws;
    try { ws = new WebSocket(this.url()); } catch { return this.later(); }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => { opened = true; this.retry = 0; this.lastMsg = Date.now(); this.setStatus('online'); this.ping(); };
    ws.onmessage = (e) => this.message(e.data);
    ws.onclose = async () => {
      if (this.ws !== ws) return;
      for (const [, p] of this.pending) p.resolve({ ok: false, err: 'Connection lost. Try again.' });
      this.pending.clear();
      if (!opened) {
        // The upgrade was refused: find out why (bad code, bad key) instead of retrying forever.
        try {
          const r = await fetch(this.url().replace(/^ws/, 'http'), { headers: { 'x-probe': '1' } });
          if (r.status === 404 || r.status === 403 || r.status === 400) {
            const j = await r.json().catch(() => ({}));
            this.closed = true; this.setStatus('dead');
            this.onFatal && this.onFatal(j.err || 'Could not join that room.');
            return;
          }
        } catch {}
      }
      this.later();
    };
    ws.onerror = () => {};
  }
  later() {
    this.setStatus('reconnecting');
    const d = Math.min(8000, 400 * 2 ** this.retry) * (0.7 + Math.random() * 0.6);
    this.retry++;
    this.retryTimer = setTimeout(() => this.connect(), d);
  }
  message(raw) {
    this.lastMsg = Date.now();
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'pong') {
      const now = Date.now(), rtt = now - m.c;
      this.rtt = rtt;
      this.offsets.push({ rtt, off: m.now + rtt / 2 - now });
      if (this.offsets.length > 8) this.offsets.shift();
      const best = this.offsets.slice().sort((a, b) => a.rtt - b.rtt).slice(0, 3);
      this.offset = best.reduce((a, b) => a + b.off, 0) / best.length;
      return;
    }
    if (m.t === 'hb') return;
    if (m.t === 'hello') { if (!this.offsets.length) this.offset = m.now - Date.now(); this.onHello && this.onHello(m); return; }
    if (m.t === 'state') { this.onState && this.onState(m.s, m.now); return; }
    if (m.t === 'ack') { const p = this.pending.get(m.rid); if (p) { this.pending.delete(m.rid); p.resolve(m); } return; }
    this.onMsg && this.onMsg(m);
  }
  ping() { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'ping', c: Date.now(), rtt: this.rtt || undefined })); }
  serverNow() { return Date.now() + this.offset; }
  send(msg) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }
  request(msg, timeout = 8000) {
    const rid = ++this.rid;
    return new Promise((resolve) => {
      if (!this.send({ ...msg, rid })) return resolve({ ok: false, err: 'Not connected yet. One moment.' });
      this.pending.set(rid, { resolve });
      setTimeout(() => { if (this.pending.has(rid)) { this.pending.delete(rid); resolve({ ok: false, err: 'The server did not answer. Try again.' }); } }, timeout);
    });
  }
  close() { this.closed = true; clearInterval(this.pinger); clearInterval(this.watchdog); try { this.ws && this.ws.close(); } catch {} }
}

export function storage() {
  const mem = {};
  return {
    get(k) { try { return localStorage.getItem(k); } catch { return mem[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { mem[k] = v; } },
    del(k) { try { localStorage.removeItem(k); } catch { delete mem[k]; } },
  };
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (v) => (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US');
// Replace an element's HTML only when it actually changed (keeps focus, selection and animations).
export function put(el, html) { if (el && el._html !== html) { el._html = html; el.innerHTML = html; return true; } return false; }
