// Original sound effects, synthesized with Web Audio (no audio files to load).
let ctx = null, muted = false, master = null;
try { muted = localStorage.getItem('ij-muted') === '1'; } catch {}

export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
}
export const isMuted = () => muted;
export function setMuted(m) { muted = m; try { localStorage.setItem('ij-muted', m ? '1' : '0'); } catch {} }

function tone(freq, start, dur, { type = 'sine', gain = 0.3, to = null, attack = 0.01 } = {}) {
  const t0 = ctx.currentTime + start;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.05);
}

const SOUNDS = {
  buzz: () => { tone(196, 0, 0.32, { type: 'square', gain: 0.16 }); tone(294, 0, 0.32, { type: 'sawtooth', gain: 0.06 }); },
  open: () => { tone(880, 0, 0.18, { gain: 0.12 }); },
  correct: () => { tone(659, 0, 0.18, { type: 'triangle', gain: 0.25 }); tone(988, 0.12, 0.32, { type: 'triangle', gain: 0.25 }); },
  wrong: () => { tone(311, 0, 0.22, { type: 'triangle', gain: 0.25, to: 233 }); tone(233, 0.16, 0.36, { type: 'triangle', gain: 0.22, to: 175 }); },
  timeout: () => { tone(392, 0, 0.2, { gain: 0.2 }); tone(392, 0.25, 0.2, { gain: 0.2 }); tone(294, 0.5, 0.45, { gain: 0.22 }); },
  dd: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.4, { type: 'triangle', gain: 0.18 })); },
  join: () => { tone(740, 0, 0.12, { gain: 0.1 }); tone(988, 0.08, 0.16, { gain: 0.1 }); },
  pick: () => { tone(523, 0, 0.1, { gain: 0.08 }); },
  tick: () => { tone(1200, 0, 0.05, { type: 'square', gain: 0.04 }); },
  final: () => { [392, 523, 659].forEach((f, i) => tone(f, i * 0.16, 0.6, { type: 'triangle', gain: 0.15 })); },
};

export function play(name) {
  if (muted || !ctx || ctx.state !== 'running' || !SOUNDS[name]) return;
  try { SOUNDS[name](); } catch {}
}

export function vibrate(pattern) {
  // Works on Android. iPhone Safari has no web vibration, so it silently does nothing there.
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch {}
}
