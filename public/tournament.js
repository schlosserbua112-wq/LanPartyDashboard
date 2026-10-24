'use strict';

// Turniere: Turnierbaum bzw. Tabelle zeichnen, Ergebnisse eintragen und
// neue Ergebnisse mit Animationen und Sounds feiern. Wird von der TV-Anzeige,
// vom Dashboard und vom Admin-Bereich gemeinsam benutzt.

// --- Soundeffekte (mit WebAudio erzeugt, keine Dateien nötig) -----------------

const tournamentSfx = (() => {
  let ctx = null;
  // Stummschalten läuft zentral über FX.muteButton() (Taste M), siehe fx.js.

  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  // Browser erlauben Ton erst nach einer Interaktion: beim ersten Klick freischalten.
  document.addEventListener('pointerdown', () => !FX.muted && audio(), { once: true });

  function tone(ac, freq, at, dur, type = 'triangle', gain = 0.18, slideTo = null) {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(ac.destination);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  function noise(ac, at, dur, gain = 0.25) {
    const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ac.createBufferSource();
    const g = ac.createGain();
    g.gain.value = gain;
    src.buffer = buf;
    src.connect(g).connect(ac.destination);
    src.start(at);
  }

  const sounds = {
    join(ac, t) {
      tone(ac, 880, t, 0.08, 'sine', 0.15);
      tone(ac, 1320, t + 0.07, 0.12, 'sine', 0.12);
    },
    win(ac, t) {
      [523, 659, 784].forEach((f, i) => tone(ac, f, t + i * 0.08, 0.18, 'square', 0.06));
      tone(ac, 1047, t + 0.24, 0.35, 'triangle', 0.15);
    },
    start(ac, t) {
      tone(ac, 110, t, 0.6, 'sawtooth', 0.08, 880);
      noise(ac, t + 0.55, 0.25, 0.3);
      tone(ac, 65, t + 0.55, 0.4, 'sine', 0.4, 40);
    },
    champion(ac, t) {
      const notes = [[523, 0, 0.15], [523, 0.16, 0.15], [523, 0.32, 0.15], [659, 0.48, 0.5], [587, 1.0, 0.18], [659, 1.18, 0.18], [784, 1.36, 0.9]];
      for (const [f, at, d] of notes) {
        tone(ac, f, t + at, d, 'square', 0.07);
        tone(ac, f / 2, t + at, d, 'triangle', 0.12);
      }
      [523, 659, 784, 1047].forEach((f) => tone(ac, f, t + 1.36, 1.4, 'triangle', 0.08));
      noise(ac, t + 1.36, 0.6, 0.15);
    },
  };

  return {
    play(name) {
      if (FX.muted) return;
      const ac = audio();
      if (ac && sounds[name]) sounds[name](ac, ac.currentTime + 0.02);
    },
  };
})();

// --- Konfetti -----------------------------------------------------------------

function tournamentConfetti() {
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const w = (canvas.width = innerWidth);
  const h = (canvas.height = innerHeight);
  const colors = ['#38e1ff', '#b16cff', '#ffc857', '#3ddc84', '#ff5c7a', '#ffffff'];
  const parts = [...Array(220)].map((_, i) => ({
    x: i % 2 ? w * 0.15 : w * 0.85,
    y: h * 0.9,
    vx: (i % 2 ? 1 : -1) * (2 + Math.random() * 9),
    vy: -(12 + Math.random() * 14),
    size: 6 + Math.random() * 8,
    rot: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.4,
    color: colors[i % colors.length],
  }));
  const started = performance.now();
  (function frame(now) {
    const age = now - started;
    ctx.clearRect(0, 0, w, h);
    for (const p of parts) {
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.spin;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - age / 5000);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (age < 5000) requestAnimationFrame(frame);
    else canvas.remove();
  })(started);
}

// --- Darstellung --------------------------------------------------------------

const STATUS_LABELS = { anmeldung: 'Anmeldung', laeuft: 'läuft', beendet: 'beendet' };

function roundName(index, total) {
  const left = total - index;
  if (left === 1) return 'Finale';
  if (left === 2) return 'Halbfinale';
  if (left === 3) return 'Viertelfinale';
  if (left === 4) return 'Achtelfinale';
  return `Runde ${index + 1}`;
}

// opts: { canReport(t, m), canJoin(t), joined(t), fresh: Set mit neuen IDs, entering }
function tournamentHtml(t, opts) {
  const names = Object.fromEntries(t.participants.map((p) => [p.id, p.name]));
  const fresh = opts.fresh || new Set();
  const champion = t.status === 'beendet' && t.winnerId
    ? `<div class="t-champion ${fresh.has('champion') ? 'celebrate' : ''}"><span class="trophy">🏆</span><span><small>Turniersieger</small><strong>${esc(names[t.winnerId])}</strong></span></div>`
    : '';
  const head = `<div class="t-head">
      <div><strong class="t-name">${esc(t.name)}</strong>${t.game ? ` <span class="t-game">${esc(t.game)}</span>` : ''}</div>
      <span class="badge ${t.status === 'laeuft' ? '' : 'alt'}">${t.status === 'anmeldung' && t.open ? 'Anmeldung offen' : STATUS_LABELS[t.status]}</span>
      <small>${esc(t.formatLabel)} · ${t.participants.length} Teilnehmer</small>
      ${champion}
    </div>`;

  if (t.status === 'anmeldung') {
    const chips = t.participants.length
      ? t.participants.map((p) => `<li class="${fresh.has(p.id) ? 'pop' : ''}">${esc(p.name)}${opts.removable ? ` <button type="button" class="t-remove" data-t-remove="${esc(p.id)}" title="Entfernen">✕</button>` : ''}</li>`).join('')
      : '<li class="empty">Noch niemand angemeldet</li>';
    let action = '';
    if (opts.canJoin && opts.canJoin(t)) {
      action = opts.joined(t)
        ? '<button type="button" class="secondary" data-t-action="leave">Abmelden</button>'
        : '<button type="button" class="t-join" data-t-action="join">Ich bin dabei!</button>';
    }
    return `${head}<div class="t-signup"><ul class="t-chips">${chips}</ul>${action}<p class="muted">${t.open ? 'Der Turnierbaum wird ausgelost, sobald der Admin das Turnier startet.' : 'Der Admin stellt die Teilnehmer zusammen.'}</p></div>`;
  }

  const matchHtml = (m, i) => {
    const clickable = opts.canReport && opts.canReport(t, m);
    const side = (pid, sc) => {
      const cls = m.done && m.winner ? (m.winner === pid ? 'won' : 'lost') : '';
      return `<span class="t-side ${cls}"><span class="t-player">${pid ? esc(names[pid]) : m.bye ? '<em>Freilos</em>' : '<em>offen</em>'}</span><span class="t-score">${sc ?? ''}</span></span>`;
    };
    const cls = ['t-match', m.done ? 'done' : '', m.bye ? 'bye' : '', clickable ? 'clickable' : '', fresh.has(m.id) ? 'pop' : ''].join(' ');
    const attrs = clickable ? ` role="button" tabindex="0" data-match="${esc(m.id)}" title="Ergebnis eintragen"` : '';
    return `<div class="${cls}" style="--i:${i}"${attrs}>${side(m.a, m.scoreA)}${side(m.b, m.scoreB)}</div>`;
  };

  if (t.format === 'ko') {
    let n = 0;
    const rounds = t.rounds.map((round, r) => `<div class="t-round">
        <h4>${roundName(r, t.rounds.length)}</h4>
        <div class="t-slots">${round.map((m) => `<div class="t-slot ${m.done ? 'done' : ''}">${matchHtml(m, n++)}</div>`).join('')}</div>
      </div>`).join('');
    return `${head}<div class="t-bracket ${opts.entering ? 'entering' : ''}">${rounds}</div>`;
  }

  const table = `<table class="t-table">
      <thead><tr><th>#</th><th class="left">Name</th><th>Sp</th><th>S</th><th>U</th><th>N</th><th>Ergebnis</th><th>Pkt</th></tr></thead>
      <tbody>${t.standings.map((s, i) => `<tr class="${t.status === 'beendet' && i === 0 ? 'leader' : ''}"><td>${i + 1}</td><td class="left">${esc(s.name)}</td><td>${s.played}</td><td>${s.won}</td><td>${s.drawn}</td><td>${s.lost}</td><td>${s.scored}:${s.conceded}</td><td><strong>${s.points}</strong></td></tr>`).join('')}</tbody>
    </table>`;
  let n = 0;
  const rounds = t.rounds.map((round, r) => `<div class="t-liga-round"><h4>Runde ${r + 1}</h4>${round.map((m) => matchHtml(m, n++)).join('')}</div>`).join('');
  return `${head}<div class="t-liga ${opts.entering ? 'entering' : ''}">${table}<div class="t-liga-rounds">${rounds}</div></div>`;
}

// --- Komponente -----------------------------------------------------------------

// options: {
//   el: Container, mode: 'tv' | 'user' | 'admin',
//   headers: () => Auth-Header, getMe: () => { id, isAdmin, master, canPlay } | null,
//   onSelect: (turnier) => void
// }
function createTournaments(options) {
  const { el } = options;
  let mode = options.mode;
  let list = [];
  let selectedId = null;
  let lastJson = null;
  let prev = null; // Stand beim letzten Update, um Neues zu erkennen
  let rotateTimer = null;

  const me = () => (options.getMe ? options.getMe() : null);
  const myIds = (t) => {
    const user = me();
    return user ? t.participants.filter((p) => p.userId === user.id).map((p) => p.id) : [];
  };

  const opts = {
    canJoin: (t) => {
      const user = me();
      return mode === 'user' && user && !user.master && user.canPlay && t.open;
    },
    joined: (t) => myIds(t).length > 0,
    canReport: (t, m) => {
      if (t.status === 'anmeldung' || m.bye || !m.a || !m.b) return false;
      if (mode === 'admin') return true;
      const user = me();
      if (mode !== 'user' || !user) return false;
      if (user.isAdmin) return true;
      const ids = myIds(t);
      return user.canPlay && (ids.includes(m.a) || ids.includes(m.b));
    },
  };

  // Was gezeigt wird: Admin alles, sonst Anmeldungen, laufende und das zuletzt beendete Turnier.
  function visible(all) {
    if (mode === 'admin') return all;
    const active = all.filter((t) => t.status !== 'beendet');
    const finished = all.filter((t) => t.status === 'beendet').sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))[0];
    return finished ? [...active, finished] : active;
  }

  function render(fx = {}) {
    const t = list.find((x) => x.id === selectedId);
    if (!t) {
      el.innerHTML = '<p class="empty">Gerade läuft kein Turnier</p>';
      return;
    }
    const tabs = list.length > 1
      ? `<div class="t-tabs">${list.map((x) => `<button type="button" class="${x.id === t.id ? 'active' : ''}" data-t-select="${esc(x.id)}">${esc(x.name)}${x.status === 'laeuft' ? ' <span class="live"></span>' : ''}</button>`).join('')}</div>`
      : '';
    el.innerHTML = `<div class="t-top">${tabs}</div><div class="t-body ${fx.switching ? 'switching' : ''}">${tournamentHtml(t, { ...opts, removable: mode === 'admin', fresh: fx.fresh, entering: fx.entering })}</div>`;
  }

  function select(id, fx) {
    selectedId = id;
    render(fx);
    if (options.onSelect) options.onSelect(list.find((x) => x.id === id) || null);
  }

  // Neue Ergebnisse, Turnierstarts und Sieger erkennen und feiern.
  function effects(next) {
    const fx = { fresh: new Set() };
    if (!prev) return fx;
    let sound = null;
    const rank = { join: 1, win: 2, start: 3, champion: 4 };
    const want = (s) => { if (!sound || rank[s] > rank[sound]) sound = s; };
    for (const t of next) {
      const old = prev.get(t.id);
      if (!old) continue;
      if (old.status === 'anmeldung' && t.status === 'laeuft') {
        want('start');
        if (t.id === selectedId || !selectedId) { selectedId = t.id; fx.entering = true; }
      }
      if (t.status === 'anmeldung') {
        for (const p of t.participants) if (!old.participants.has(p.id)) { fx.fresh.add(p.id); want('join'); }
      }
      for (const m of t.rounds.flat()) {
        if (m.done && !m.bye && !old.done.has(m.id)) { fx.fresh.add(m.id); want('win'); }
      }
      if (old.status !== 'beendet' && t.status === 'beendet') {
        want('champion');
        fx.fresh.add('champion');
        fx.confetti = true;
        selectedId = t.id;
      }
    }
    if (sound) tournamentSfx.play(sound);
    return fx;
  }

  function snapshot(all) {
    return new Map(all.map((t) => [t.id, {
      status: t.status,
      participants: new Set(t.participants.map((p) => p.id)),
      done: new Set(t.rounds.flat().filter((m) => m.done).map((m) => m.id)),
    }]));
  }

  function update(all) {
    const json = JSON.stringify(all);
    if (json === lastJson) return; // Nichts Neues: nicht neu zeichnen (Animationen nicht wiederholen).
    lastJson = json;
    const fx = effects(all);
    prev = snapshot(all);
    list = visible(all);
    if (!list.some((t) => t.id === selectedId)) {
      const pick = list.find((t) => t.status === 'laeuft') || list[0];
      selectedId = pick ? pick.id : null;
    }
    select(selectedId, fx);
    if (fx.confetti) tournamentConfetti();
    if (mode === 'tv') scheduleRotation();
  }

  // Auf der TV-Anzeige wechseln mehrere Turniere automatisch durch.
  function scheduleRotation() {
    clearInterval(rotateTimer);
    if (list.length < 2) return;
    rotateTimer = setInterval(() => {
      const i = list.findIndex((t) => t.id === selectedId);
      select(list[(i + 1) % list.length].id, { switching: true });
    }, 20000);
  }

  async function post(path, body) {
    const res = await fetch('/api/tournaments/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(options.headers ? options.headers() : {}) },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? null : data.error || 'Fehler';
  }

  // --- Ergebnis-Dialog

  const dialog = document.createElement('dialog');
  dialog.className = 't-dialog';
  document.body.appendChild(dialog);
  let dialogMatch = null;

  function openDialog(matchId) {
    const t = list.find((x) => x.id === selectedId);
    const m = t && t.rounds.flat().find((x) => x.id === matchId);
    if (!m) return;
    dialogMatch = { t, m };
    const name = (pid) => esc(t.participants.find((p) => p.id === pid)?.name);
    const ko = t.format === 'ko';
    const admin = mode === 'admin' || me()?.isAdmin;
    dialog.innerHTML = `<form method="dialog" class="stack">
        <h3>Ergebnis eintragen</h3>
        <div class="t-score-row">
          <label>${name(m.a)} <input type="number" name="scoreA" min="0" max="9999" value="${m.scoreA ?? ''}"></label>
          <span class="vs">:</span>
          <label>${name(m.b)} <input type="number" name="scoreB" min="0" max="9999" value="${m.scoreB ?? ''}"></label>
        </div>
        ${ko ? `<p class="muted">Im K.-o.-System reicht ein Klick auf den Sieger, der Spielstand ist optional.</p>
        <div class="toggle-row">
          <button type="button" data-winner="${esc(m.a)}">🏆 ${name(m.a)} gewinnt</button>
          <button type="button" data-winner="${esc(m.b)}">🏆 ${name(m.b)} gewinnt</button>
        </div>` : ''}
        <p class="error" data-error></p>
        <div class="toggle-row">
          <button type="submit" value="save">Spielstand speichern</button>
          <button type="button" class="secondary" data-close>Abbrechen</button>
          ${admin && m.done ? '<button type="button" class="icon danger" data-clear>Ergebnis löschen</button>' : ''}
        </div>
      </form>`;
    dialog.showModal();
    dialog.querySelector('input').focus();
  }

  async function submitResult(body) {
    const { t, m } = dialogMatch;
    const error = await post(`${t.id}/matches/${m.id}/result`, body);
    if (error) dialog.querySelector('[data-error]').textContent = error;
    else dialog.close();
  }

  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-close]')) return dialog.close();
    const form = dialog.querySelector('form');
    const winnerBtn = e.target.closest('[data-winner]');
    if (winnerBtn) {
      const { scoreA, scoreB } = form.elements;
      submitResult({ winner: winnerBtn.dataset.winner, scoreA: scoreA.value, scoreB: scoreB.value });
    }
    if (e.target.closest('[data-clear]') && confirm('Ergebnis löschen? Darauf aufbauende Spiele werden ebenfalls zurückgesetzt.')) {
      submitResult({ clear: true });
    }
  });

  dialog.addEventListener('submit', (e) => {
    e.preventDefault();
    const { scoreA, scoreB } = e.target.elements;
    submitResult({ scoreA: scoreA.value, scoreB: scoreB.value });
  });

  // --- Klicks im Container

  el.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-t-select]');
    if (tab) {
      if (mode === 'tv') scheduleRotation();
      return select(tab.dataset.tSelect, { switching: true });
    }
    const match = e.target.closest('[data-match]');
    if (match) return openDialog(match.dataset.match);
    const action = e.target.closest('[data-t-action]')?.dataset.tAction;
    if (action === 'join' || action === 'leave') {
      const error = await post(`${selectedId}/${action}`);
      if (error) alert(error);
    }
  });

  el.addEventListener('keydown', (e) => {
    const match = e.target.closest('[data-match]');
    if (match && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openDialog(match.dataset.match);
    }
  });

  return {
    update,
    refresh: () => render(),
    // Das Dashboard wird zur Bedienoberfläche, sobald klar ist, wer angemeldet ist.
    setMode(next) {
      mode = next;
      clearInterval(rotateTimer);
      render();
    },
    selected: () => list.find((t) => t.id === selectedId) || null,
    select: (id) => select(id),
  };
}
