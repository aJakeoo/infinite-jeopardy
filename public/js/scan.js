// In-app QR scanner. Inside the installed app, the iPhone Camera app would open links in Safari instead of
// the app, so players and hosts scan the TV's code from here. Uses the rear camera and jsQR (loaded on demand).

let jsqrLoading = null;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!jsqrLoading) jsqrLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/js/vendor/jsQR.js';
    s.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('jsQR missing')));
    s.onerror = () => { jsqrLoading = null; reject(new Error('Could not load the scanner.')); };
    document.head.appendChild(s);
  });
  return jsqrLoading;
}

export const canScan = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

// Resolves with the decoded text, or null if the person closes the scanner.
export function scanQR() {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'scanner';
    wrap.innerHTML = `<video playsinline muted autoplay></video><div class="scan-frame"></div>
      <p class="scan-msg" role="status"></p><button type="button" class="scan-close" aria-label="Close scanner"><i></i><i></i></button>`;
    document.body.appendChild(wrap);
    const video = wrap.querySelector('video'), msg = wrap.querySelector('.scan-msg');
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    let stream = null, done = false, raf = 0;
    const finish = (text) => {
      if (done) return; done = true;
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      wrap.remove();
      resolve(text);
    };
    wrap.querySelector('.scan-close').addEventListener('click', () => finish(null));
    (async () => {
      try {
        const [jsQR, s] = await Promise.all([loadJsQR(), navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })]);
        stream = s;
        if (done) { s.getTracks().forEach((t) => t.stop()); return; }
        video.srcObject = s;
        await video.play().catch(() => {});
        const tick = () => {
          if (done) return;
          if (video.readyState >= 2 && video.videoWidth) {
            // Decode a downscaled frame: fast enough on older iPhones, sharp enough for a TV-sized code.
            const scale = Math.min(1, 640 / video.videoWidth);
            canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            if (code && code.data) { if (navigator.vibrate) navigator.vibrate(40); finish(code.data); return; }
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        msg.textContent = e && e.name === 'NotAllowedError' ? 'Camera access is off. Allow it in Settings, or type the room code.' : 'The camera is not available. Type the room code instead.';
      }
    })();
  });
}

// What a scanned code means for this app: a player join link, a host link, or nothing we know.
export function readGameLink(text) {
  try {
    const u = new URL(text, location.origin);
    if (!/\/play\/?$/.test(u.pathname)) return null;
    const room = (u.searchParams.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    if (room.length !== 4) return null;
    const key = u.searchParams.get('key');
    return { room, host: u.searchParams.get('role') === 'host' && !!key, key, sameOrigin: u.origin === location.origin, href: u.href };
  } catch { return null; }
}
