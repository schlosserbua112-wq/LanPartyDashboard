'use strict';

// Animationen und Soundeffekte für alle Seiten, ohne Bibliotheken und ohne
// Audiodateien: Die Töne werden per Web Audio erzeugt.
//
//   FX.sound('win')                 Ton abspielen (siehe SOUNDS)
//   FX.confetti({ x, y })           Konfetti ab Bildschirmpunkt (sonst Mitte)
//   FX.bump(el, 'fx-pop')           CSS-Animation (neu) starten
//   FX.floatText(el, '+5')          Aufsteigender Text über einem Element
//   FX.flip(container, update)      Umsortieren weich animieren ([data-key])
//   FX.bars(container, update)      Balken ([data-key][data-w]) von alt auf neu
//   FX.track(key, value)            Vorherigen Wert liefern (undefined beim 1. Mal)
//   FX.muteButton()                 Knopf zum Stummschalten (Taste M)

const FX = (() => {
  const reducedMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // --- Stummschalten ---------------------------------------------------------

  const MUTE_KEY = 'lanparty-muted';
  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch {}
  const muteListeners = new Set();

  function setMuted(value) {
    muted = Boolean(value);
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch {}
    muteListeners.forEach((fn) => fn(muted));
    if (!muted) sound('pop');
  }

  function muteButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mute-btn';
    const show = (m) => {
      btn.textContent = m ? '🔇' : '🔊';
      btn.title = (m ? 'Ton einschalten' : 'Ton ausschalten') + ' (M)';
      btn.setAttribute('aria-pressed', String(m));
      btn.classList.toggle('muted', m);
    };
    show(muted);
    muteListeners.add(show);
    btn.addEventListener('click', () => setMuted(!muted));
    return btn;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'm' && e.key !== 'M') return;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    setMuted(!muted);
  });

  // --- Töne ------------------------------------------------------------------

  let ctx = null;
  let master = null;

  function audio() {
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      ctx = new Ctx();
      master = ctx.createGain();
      master.gain.value = 0.45;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // Browser geben Ton erst nach der ersten Eingabe frei (Kiosk: siehe kiosk.sh).
  const unlock = () => audio();
  ['pointerdown', 'keydown'].forEach((type) => document.addEventListener(type, unlock, { once: true, capture: true }));

  function tone(freq, dur, { type = 'sine', vol = 0.3, delay = 0, slide = null, attack = 0.005 } = {}) {
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function noise(dur, { vol = 0.2, delay = 0, from = 400, to = 3000, q = 1.2 } = {}) {
    const t = ctx.currentTime + delay;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(to, t + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + dur * 0.3);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(gain).connect(master);
    src.start(t);
  }

  const SOUNDS = {
    tick: () => tone(1500, 0.03, { type: 'triangle', vol: 0.12 }),
    spin: () => noise(0.7, { vol: 0.25, from: 300, to: 4000 }),
    win: () => {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, { type: 'square', vol: 0.09, delay: i * 0.1 }));
      [1047, 1319, 1568].forEach((f) => tone(f, 0.9, { type: 'triangle', vol: 0.12, delay: 0.42 }));
    },
    vote: () => { tone(660, 0.08, { vol: 0.2 }); tone(990, 0.14, { vol: 0.2, delay: 0.07 }); },
    unvote: () => { tone(990, 0.08, { vol: 0.15 }); tone(660, 0.14, { vol: 0.15, delay: 0.07 }); },
    pop: () => tone(420, 0.08, { vol: 0.2, slide: 900 }),
    remove: () => tone(700, 0.1, { type: 'triangle', vol: 0.12, slide: 250 }),
    coin: () => { tone(988, 0.07, { type: 'square', vol: 0.07 }); tone(1319, 0.3, { type: 'square', vol: 0.07, delay: 0.07 }); },
    chime: () => { tone(880, 1.2, { vol: 0.15 }); tone(1320, 1.4, { vol: 0.08, delay: 0.12 }); },
    up: () => { tone(523, 0.1, { type: 'triangle', vol: 0.15 }); tone(784, 0.25, { type: 'triangle', vol: 0.15, delay: 0.09 }); },
    down: () => { tone(392, 0.15, { type: 'sawtooth', vol: 0.06 }); tone(262, 0.35, { type: 'sawtooth', vol: 0.06, delay: 0.14 }); },
    error: () => { tone(180, 0.12, { type: 'square', vol: 0.08 }); tone(150, 0.18, { type: 'square', vol: 0.08, delay: 0.14 }); },
  };

  // Gleicher Ton höchstens alle paar Millisekunden (z.B. viele Stimmen auf einmal).
  const lastPlayed = {};
  function sound(name, { minGap = 40 } = {}) {
    if (muted || !SOUNDS[name]) return;
    const now = performance.now();
    if (now - (lastPlayed[name] || 0) < minGap) return;
    lastPlayed[name] = now;
    if (!audio() || ctx.state !== 'running') return;
    try { SOUNDS[name](); } catch {}
  }

  // --- Animationen -----------------------------------------------------------

  function bump(el, cls = 'fx-pop') {
    if (!el || reducedMotion) return;
    el.classList.remove(cls);
    void el.offsetWidth; // Animation neu starten
    el.classList.add(cls);
    el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
  }

  function floatText(el, text, cls = '') {
    if (!el || reducedMotion) return;
    // Im Element selbst, damit der Text mitwandert, falls es gerade umsortiert wird.
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    const span = document.createElement('span');
    span.className = `fx-float ${cls}`;
    span.textContent = text;
    el.appendChild(span);
    span.addEventListener('animationend', () => span.remove(), { once: true });
  }

  // FLIP: Positionen merken, neu rendern, Elemente von alt nach neu gleiten lassen.
  function flip(container, update) {
    const before = new Map();
    for (const el of container.querySelectorAll('[data-key]')) before.set(el.dataset.key, el.getBoundingClientRect());
    update();
    if (reducedMotion || !before.size) return;
    for (const el of container.querySelectorAll('[data-key]')) {
      const old = before.get(el.dataset.key);
      if (!old) continue;
      const now = el.getBoundingClientRect();
      const dy = old.top - now.top;
      if (Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 550, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }

  // Balken behalten beim Neu-Rendern ihre alte Breite und wachsen dann weich.
  function bars(container, update) {
    const before = new Map();
    for (const el of container.querySelectorAll('[data-key][data-w]')) before.set(el.dataset.key, el.dataset.w);
    update();
    const fresh = [];
    for (const el of container.querySelectorAll('[data-key][data-w]')) {
      const old = before.has(el.dataset.key) ? before.get(el.dataset.key) : (reducedMotion ? el.dataset.w : 0);
      if (String(old) === el.dataset.w) { el.style.width = `${el.dataset.w}%`; continue; }
      el.style.width = `${old}%`;
      fresh.push(el);
    }
    if (!fresh.length) return;
    void container.offsetWidth;
    for (const el of fresh) el.style.width = `${el.dataset.w}%`;
  }

  const tracked = new Map();
  function track(key, value) {
    const prev = tracked.get(key);
    tracked.set(key, value);
    return prev;
  }

  // --- Konfetti --------------------------------------------------------------

  const COLORS = ['#38e1ff', '#b16cff', '#ffc857', '#3ddc84', '#ff5c7a', '#5b8cff', '#ff9f43'];
  let canvas = null;
  let particles = [];
  let running = false;

  function confetti({ x = innerWidth / 2, y = innerHeight / 2, count = 140, spread = 1 } = {}) {
    if (reducedMotion) return;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'fx-confetti';
      document.body.appendChild(canvas);
    }
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (4 + Math.random() * 9) * spread;
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 6 * spread,
        size: 5 + Math.random() * 7,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.4,
        color: COLORS[i % COLORS.length],
        life: 0,
        max: 90 + Math.random() * 70,
      });
    }
    if (!running) {
      running = true;
      requestAnimationFrame(confettiFrame);
    }
  }

  function confettiFrame() {
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== innerWidth * dpr || canvas.height !== innerHeight * dpr) {
      canvas.width = innerWidth * dpr;
      canvas.height = innerHeight * dpr;
    }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, innerWidth, innerHeight);
    particles = particles.filter((p) => p.life < p.max && p.y < innerHeight + 40);
    for (const p of particles) {
      p.life++;
      p.vx *= 0.985;
      p.vy = p.vy * 0.985 + 0.32;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      c.save();
      c.globalAlpha = Math.min(1, (p.max - p.life) / 25);
      c.translate(p.x, p.y);
      c.rotate(p.rot);
      c.fillStyle = p.color;
      // Flattern: Breite schwankt mit der Drehung
      c.fillRect(-p.size / 2, -p.size / 4, p.size * Math.abs(Math.cos(p.rot * 2)) + 1, p.size / 2);
      c.restore();
    }
    if (particles.length) requestAnimationFrame(confettiFrame);
    else running = false;
  }

  function confettiAt(el, opts) {
    if (!el) return confetti(opts);
    const r = el.getBoundingClientRect();
    confetti({ x: r.left + r.width / 2, y: r.top + r.height / 2, ...opts });
  }

  return { sound, bump, floatText, flip, bars, track, confetti, confettiAt, muteButton, setMuted, get muted() { return muted; }, reducedMotion };
})();
