'use strict';

// Team-Generator: Auslosungs-Show mit Soundeffekten und die Team-Spalten.
// Wie beim Glücksrad rechnen alle Anzeigen aus denselben Server-Werten
// (Reihenfolge, Alter der Auslosung) und zeigen die Enthüllung synchron.

// --- Soundeffekte (Web Audio, ohne Dateien) ----------------------------------

const teamSfx = (() => {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('lanparty-mute') === '1'; } catch {}

  function audio() {
    if (muted) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx.state === 'running' ? ctx : null;
  }

  // Browser erlauben Ton erst nach einer Eingabe; beim ersten Klick freischalten.
  for (const type of ['pointerdown', 'keydown']) {
    document.addEventListener(type, () => { if (!muted) audio(); }, { once: true, capture: true });
  }

  function tone(freq, { at = 0, length = 0.12, type = 'sine', volume = 0.2, slide = 0 } = {}) {
    const ac = audio();
    if (!ac) return;
    const t = ac.currentTime + at;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(freq * slide, t + length);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + length + 0.02);
  }

  return {
    get muted() { return muted; },
    setMuted(value) {
      muted = value;
      try { localStorage.setItem('lanparty-mute', value ? '1' : '0'); } catch {}
      if (!muted) audio();
    },
    tick() { tone(1400 + Math.random() * 500, { length: 0.035, type: 'square', volume: 0.05 }); },
    whoosh() { tone(180, { length: 0.35, type: 'sawtooth', volume: 0.06, slide: 4 }); },
    // Je weiter die Enthüllung, desto höher der Ton.
    pop(step) {
      const f = 330 * Math.pow(2, (step % 12) / 12);
      tone(f, { length: 0.16, type: 'triangle', volume: 0.22, slide: 1.5 });
      tone(f * 2, { at: 0.03, length: 0.1, volume: 0.06 });
    },
    fanfare() {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.11, length: 0.22, type: 'triangle', volume: 0.2 }));
      tone(1047, { at: 0.48, length: 0.7, type: 'triangle', volume: 0.2 });
      tone(1319, { at: 0.48, length: 0.7, volume: 0.1 });
    },
  };
})();

// Knopf zum Stummschalten; aktualisiert sich selbst.
function teamSoundButton(btn) {
  const show = () => {
    btn.textContent = teamSfx.muted ? '🔇' : '🔊';
    btn.title = teamSfx.muted ? 'Sound einschalten' : 'Sound ausschalten';
  };
  btn.addEventListener('click', () => { teamSfx.setMuted(!teamSfx.muted); show(); });
  show();
}

// --- Team-Spalten --------------------------------------------------------------

// revealed: wie viele Einträge aus result.order schon sichtbar sind (Standard: alle).
function teamColumnsHtml(result, revealed = Infinity) {
  const visible = new Set(result.order.slice(0, revealed).map(([t, m]) => `${t}:${m}`));
  return result.teams.map((team, ti) => {
    const members = team.members.map((m, mi) => {
      const shown = visible.has(`${ti}:${mi}`);
      const pts = result.balanced && m.points !== null ? `<small>${m.points}</small>` : '';
      return `<li class="${shown ? '' : 'pending'}" data-slot="${ti}:${mi}">${shown ? `<span>${esc(m.name)}</span>${pts}` : '?'}</li>`;
    }).join('');
    const sum = team.points !== null ? `<small>${team.points} Pkt.</small>` : '';
    return `<div class="team-col" style="--team:${team.color}">
      <h3>${esc(team.name)} ${sum}</h3>
      <ol>${members}</ol>
    </div>`;
  }).join('');
}

// --- Auslosungs-Show als Overlay -----------------------------------------------

// hold: wie lange das Ergebnis danach stehen bleibt (ms, oder Funktion, die das liefert).
function createTeamReveal({ hold = 9000 } = {}) {
  const holdMs = () => (typeof hold === 'function' ? hold() : hold);
  const el = document.createElement('div');
  el.className = 'team-reveal';
  el.hidden = true;
  el.innerHTML = `
    <canvas class="confetti"></canvas>
    <div class="tr-inner">
      <p class="tr-kicker">Team-Generator</p>
      <h2 class="tr-title"></h2>
      <div class="tr-slot"></div>
      <div class="team-cols tr-teams"></div>
      <p class="tr-by"></p>
    </div>
    <button type="button" class="tr-close" title="Schließen (Esc)">✕</button>`;
  document.body.appendChild(el);
  const q = (sel) => el.querySelector(sel);

  let shownId = null;
  let run = null;

  function close() {
    if (!run) return;
    cancelAnimationFrame(run.raf);
    clearTimeout(run.closeTimer);
    run = null;
    el.classList.add('leaving');
    setTimeout(() => { el.hidden = true; el.classList.remove('leaving', 'done'); }, 400);
  }

  q('.tr-close').addEventListener('click', close);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  function frame() {
    const r = run.result;
    const elapsed = performance.now() - run.start;
    if (elapsed < r.shuffleMs) {
      // Namen rattern durch und werden zum Ende hin langsamer.
      const interval = 45 + (elapsed / r.shuffleMs) * 160;
      if (elapsed - run.lastTick >= interval) {
        run.lastTick = elapsed;
        const names = run.names;
        q('.tr-slot').textContent = names[Math.floor(Math.random() * names.length)];
        teamSfx.tick();
      }
    } else {
      if (!run.teamsShown) {
        run.teamsShown = true;
        el.classList.add('teams-in');
        q('.tr-slot').textContent = '';
        q('.tr-teams').innerHTML = teamColumnsHtml(r, 0);
        teamSfx.whoosh();
      }
      const revealed = Math.min(r.order.length, Math.floor((elapsed - r.shuffleMs) / r.stepMs) + 1);
      for (let i = run.revealed; i < revealed; i++) {
        const [ti, mi] = r.order[i];
        const m = r.teams[ti].members[mi];
        const li = q(`[data-slot="${ti}:${mi}"]`);
        li.className = 'pop';
        li.innerHTML = `<span>${esc(m.name)}</span>${r.balanced && m.points !== null ? `<small>${m.points}</small>` : ''}`;
        // Bei spätem Einstieg nur den aktuellen Schritt vertonen.
        if (i === revealed - 1 && !run.catchingUp) teamSfx.pop(i);
        q('.tr-slot').textContent = '';
      }
      run.revealed = revealed;
      if (revealed >= r.order.length && elapsed >= r.duration) {
        finish();
        return;
      }
    }
    run.catchingUp = false;
    run.raf = requestAnimationFrame(frame);
  }

  function finish() {
    el.classList.add('done');
    q('.tr-title').textContent = 'Die Teams stehen!';
    teamSfx.fanfare();
    confetti(q('.confetti'), run.result.teams.map((t) => t.color));
    run.closeTimer = setTimeout(close, holdMs());
  }

  // Wird bei jedem neuen Zustand vom Server aufgerufen.
  function update(result) {
    if (!result) {
      shownId = null;
      close();
      return;
    }
    if (result.id === shownId) return;
    const first = shownId === null && result.age > result.duration;
    shownId = result.id;
    // Beim Seitenaufruf keine alte Auslosung wiederholen.
    if (first || result.age > result.duration + holdMs()) return;
    if (run) { cancelAnimationFrame(run.raf); clearTimeout(run.closeTimer); }
    el.hidden = false;
    el.classList.remove('leaving', 'done', 'teams-in');
    q('.tr-title').textContent = 'Teams werden ausgelost…';
    q('.tr-by').textContent = `gelost von ${result.by}${result.balanced ? ' · nach Punkten ausgeglichen' : ''}`;
    q('.tr-teams').innerHTML = '';
    q('.tr-slot').textContent = '';
    run = {
      result,
      start: performance.now() - result.age,
      names: result.teams.flatMap((t) => t.members.map((m) => m.name)),
      lastTick: -Infinity,
      revealed: 0,
      teamsShown: false,
      catchingUp: result.age > result.shuffleMs,
    };
    if (result.age > result.duration) {
      // Mitten in der Haltezeit eingestiegen: gleich das Ergebnis.
      el.classList.add('teams-in', 'done');
      q('.tr-title').textContent = 'Die Teams stehen!';
      q('.tr-teams').innerHTML = teamColumnsHtml(result);
      run.closeTimer = setTimeout(close, Math.max(1000, result.duration + holdMs() - result.age));
      return;
    }
    run.raf = requestAnimationFrame(frame);
  }

  const isRunning = () => Boolean(run && !el.classList.contains('done'));
  return { update, isRunning };
}

// Kurzer Konfetti-Regen in den Teamfarben.
function confetti(canvas, colors) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const parts = Array.from({ length: 160 }, () => ({
    x: w / 2 + (Math.random() - 0.5) * w * 0.3,
    y: h * 0.45,
    vx: (Math.random() - 0.5) * 18,
    vy: -6 - Math.random() * 14,
    size: 5 + Math.random() * 7,
    rot: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.4,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  (function step(now) {
    const t = now - start;
    ctx.clearRect(0, 0, w, h);
    for (const p of parts) {
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.spin;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t / 3500);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (t < 3500) requestAnimationFrame(step);
    else ctx.clearRect(0, 0, w, h);
  })(start);
}
