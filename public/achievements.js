'use strict';

// Achievements im Browser: Freischalt-Popup mit Konfetti und Sound, dazu die
// Kachelansicht für angemeldete Nutzer. Klänge entstehen per Web Audio, es
// gibt also keine Sounddateien.

const RARITY_COLORS = { common: '#a9b3cf', rare: '#38e1ff', epic: '#b16cff', legendary: '#ffc857' };

// --- Sound -------------------------------------------------------------------

const achievementSound = (() => {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('lanparty-sound') === 'aus'; } catch {}

  function context() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Browser erlauben Ton erst nach der ersten Interaktion.
  for (const type of ['pointerdown', 'keydown']) {
    document.addEventListener(type, () => context(), { once: true, capture: true });
  }

  function tone(ac, freq, start, length, type = 'triangle', volume = 0.18) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
    osc.connect(gain).connect(ac.destination);
    osc.start(start);
    osc.stop(start + length + 0.05);
  }

  // Aufsteigendes Arpeggio, je seltener desto länger und mit Glitzern.
  const MELODIES = {
    common: [523.25, 659.25, 783.99],
    rare: [523.25, 659.25, 783.99, 1046.5],
    epic: [392, 523.25, 659.25, 783.99, 1046.5],
    legendary: [392, 523.25, 659.25, 783.99, 1046.5, 1318.5, 1568],
  };

  function play(rarity = 'common', quiet = false) {
    if (muted) return;
    const ac = context();
    if (!ac || ac.state !== 'running') return;
    const now = ac.currentTime + 0.02;
    const notes = quiet ? [783.99, 1046.5] : MELODIES[rarity] || MELODIES.common;
    const step = rarity === 'legendary' ? 0.09 : 0.08;
    const volume = quiet ? 0.07 : 0.16;
    notes.forEach((f, i) => tone(ac, f, now + i * step, 0.35, 'triangle', volume));
    if (quiet) return;
    const end = now + notes.length * step;
    // Schlussakkord
    [1, 1.25, 1.5].forEach((m) => tone(ac, notes[notes.length - 1] * m / 2, end, rarity === 'legendary' ? 1.4 : 0.8, 'sine', 0.1));
    if (rarity === 'epic' || rarity === 'legendary') {
      for (let i = 0; i < 8; i++) tone(ac, 2000 + Math.random() * 2500, end + i * 0.06, 0.12, 'sine', 0.04);
    }
  }

  return {
    play,
    get muted() { return muted; },
    toggle() {
      muted = !muted;
      try { localStorage.setItem('lanparty-sound', muted ? 'aus' : 'an'); } catch {}
      if (!muted) play('common', true);
      return muted;
    },
  };
})();

// --- Konfetti ----------------------------------------------------------------

function confettiBurst(colors, amount = 140) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = innerWidth;
  const h = innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  const parts = Array.from({ length: amount }, (_, i) => {
    const fromLeft = i % 2 === 0;
    const angle = (fromLeft ? -60 : -120) * (Math.PI / 180) + (Math.random() - 0.5) * 0.9;
    const speed = 9 + Math.random() * 9;
    return {
      x: fromLeft ? 0 : w,
      y: h * 0.75,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 6 + Math.random() * 7,
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.4,
      color: colors[i % colors.length],
    };
  });

  const started = performance.now();
  (function frame(t) {
    const age = t - started;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = Math.max(0, 1 - Math.max(0, age - 2200) / 800);
    for (const p of parts) {
      p.vy += 0.32;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.spin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (age < 3000) requestAnimationFrame(frame);
    else canvas.remove();
  })(started);
}

// --- Freischalt-Meldungen ----------------------------------------------------

// Erkennt neue Freischaltungen im Live-Zustand und zeigt sie an.
// big(unlock) entscheidet, ob es das große Popup oder nur ein kleiner Hinweis wird.
function createAchievementNotifier({ big }) {
  let seen = null;
  const queue = [];
  let showing = false;

  const stage = document.createElement('div');
  stage.className = 'ach-stage';
  stage.setAttribute('aria-live', 'polite');
  const toasts = document.createElement('div');
  toasts.className = 'ach-toasts';
  document.body.append(stage, toasts);

  function showNext() {
    const item = queue.shift();
    if (!item) {
      showing = false;
      return;
    }
    showing = true;
    const { unlock, def } = item;
    const color = RARITY_COLORS[def.rarity];
    const el = document.createElement('div');
    el.className = `ach-popup rarity-${def.rarity}`;
    el.style.setProperty('--rarity', color);
    el.innerHTML = `
      <div class="ach-rays"></div>
      <div class="ach-icon">${esc(def.icon)}</div>
      <div class="ach-text">
        <small>${item.own ? 'Achievement freigeschaltet!' : `${esc(unlock.username)} hat ein Achievement!`}</small>
        <strong>${esc(def.name)}</strong>
        <p>${esc(def.description)}</p>
        <span class="ach-meta">${esc(item.rarityLabel)} · +${def.points} Punkte${unlock.by ? ` · von ${esc(unlock.by)}` : ''}</span>
      </div>`;
    stage.append(el);
    achievementSound.play(def.rarity);
    if (def.rarity !== 'common') confettiBurst([color, '#ffffff', '#38e1ff', '#b16cff', '#ffc857'], def.rarity === 'legendary' ? 220 : 120);
    const duration = def.rarity === 'legendary' ? 6500 : 5000;
    setTimeout(() => el.classList.add('leaving'), duration - 500);
    setTimeout(() => {
      el.remove();
      showNext();
    }, duration);
  }

  function toast(unlock, def) {
    const el = document.createElement('div');
    el.className = 'ach-toast';
    el.style.setProperty('--rarity', RARITY_COLORS[def.rarity]);
    el.innerHTML = `<span class="ach-toast-icon">${esc(def.icon)}</span><span><strong>${esc(unlock.username)}</strong> hat <strong>${esc(def.name)}</strong> freigeschaltet</span>`;
    toasts.append(el);
    achievementSound.play(def.rarity, true);
    setTimeout(() => el.classList.add('leaving'), 4500);
    setTimeout(() => el.remove(), 5000);
  }

  // Wird bei jedem neuen Zustand vom Server aufgerufen.
  function update(data) {
    if (!data) return;
    const ids = data.unlocks.map((u) => u.id);
    // Beim ersten Zustand nur merken, was schon da war.
    if (!seen) {
      seen = new Set(ids);
      return;
    }
    const fresh = data.unlocks.filter((u) => !seen.has(u.id)).reverse();
    for (const id of ids) seen.add(id);
    // Nur frische Meldungen; nach einem Verbindungsabbruch nicht alles nachholen.
    for (const unlock of fresh.filter((u) => Date.now() - u.at < 60000)) {
      const def = data.defs.find((d) => d.id === unlock.achId);
      if (!def) continue;
      const mode = big(unlock);
      if (mode === 'none') continue;
      if (mode === 'toast') {
        toast(unlock, def);
        continue;
      }
      queue.push({ unlock, def, own: mode === 'own', rarityLabel: data.rarities[def.rarity].label });
    }
    if (!showing) showNext();
  }

  return { update };
}

// --- Kacheln für angemeldete Nutzer -----------------------------------------

function renderAchievementTiles(data, userId, progress) {
  const mine = new Map(data.unlocks.filter((u) => u.userId === userId).map((u) => [u.achId, u]));
  const order = { legendary: 0, epic: 1, rare: 2, common: 3 };
  // Freigeschaltete zuerst, dann nach Seltenheit.
  const defs = [...data.defs].sort((a, b) => Number(mine.has(b.id)) - Number(mine.has(a.id)) || order[a.rarity] - order[b.rarity]);
  return defs.map((d) => {
    const got = mine.get(d.id);
    const value = progress[d.id];
    const bar = !got && d.goal && d.goal > 1
      ? `<span class="ach-progress"><span style="width:${(value / d.goal) * 100}%"></span></span><small>${value} / ${d.goal}</small>`
      : '';
    const hint = got
      ? `<small>${new Date(got.at).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</small>`
      : d.manual && !bar ? '<small>vergibt der Admin</small>' : '';
    const title = `${d.name}: ${d.description} (${data.rarities[d.rarity].label}, ${d.points} Punkte)`;
    return `<li class="ach-tile rarity-${d.rarity} ${got ? 'unlocked' : 'locked'}" style="--rarity:${RARITY_COLORS[d.rarity]}" title="${esc(title)}">
      <span class="ach-tile-icon">${esc(d.icon)}</span>
      <strong>${esc(d.name)}</strong>
      ${bar}${hint}
    </li>`;
  }).join('');
}
