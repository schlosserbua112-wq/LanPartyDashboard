'use strict';

// Globales Leaderboard im Dashboard: Rangliste über alle Spiele, Ansicht pro
// Spiel, Live-Feed der letzten Punkte. Zeilen werden wiederverwendet, damit
// Platzwechsel als Bewegung animiert werden können (FLIP).

const LB_SOURCES = {
  manual: { icon: '⭐', label: 'Admin' },
  tournament: { icon: '🏆', label: 'Turnier' },
  achievement: { icon: '🏅', label: 'Achievement' },
  game: { icon: '🎮', label: 'Spiel' },
};
const LB_ROTATE_MS = 12000;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// --- Soundeffekte (per Web Audio erzeugt, keine Dateien) ----------------------

const lbSound = (() => {
  let ctx = null;
  let enabled = true;
  try { enabled = localStorage.getItem('lanparty-sound') !== 'off'; } catch {}

  function audio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // Browser erlauben Ton erst nach einer Interaktion. Der Kiosk-Browser am TV
  // startet mit --autoplay-policy=no-user-gesture-required und braucht das nicht.
  for (const type of ['pointerdown', 'keydown']) {
    window.addEventListener(type, () => { if (enabled) audio(); }, { capture: true, passive: true });
  }

  function tone(ac, [freq, start, dur, type = 'triangle', vol = 0.16]) {
    const t = ac.currentTime + start;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  // [Frequenz, Start, Dauer, Wellenform, Lautstärke]
  const SOUNDS = {
    gain: [[659.25, 0, 0.12], [783.99, 0.07, 0.12], [1046.5, 0.14, 0.28]],
    bigGain: [[523.25, 0, 0.1], [659.25, 0.07, 0.1], [783.99, 0.14, 0.1], [1046.5, 0.21, 0.35], [1318.5, 0.21, 0.35, 'sine', 0.08]],
    loss: [[392, 0, 0.16, 'sawtooth', 0.06], [293.66, 0.13, 0.32, 'sawtooth', 0.06]],
    leader: [
      [523.25, 0, 0.13, 'square', 0.07], [523.25, 0.15, 0.1, 'square', 0.07], [659.25, 0.27, 0.13, 'square', 0.07],
      [783.99, 0.42, 0.6, 'square', 0.07], [1046.5, 0.42, 0.7, 'triangle', 0.14], [1568, 0.6, 0.5, 'sine', 0.06],
    ],
  };

  let last = 0;
  function play(name) {
    if (!enabled || !SOUNDS[name]) return;
    // Mehrere Buchungen auf einmal (ganzes Team) klingen einmal.
    if (Date.now() - last < 400) return;
    const ac = audio();
    if (!ac || ac.state !== 'running') return;
    last = Date.now();
    SOUNDS[name].forEach((t) => tone(ac, t));
  }

  function toggle() {
    enabled = !enabled;
    try { localStorage.setItem('lanparty-sound', enabled ? 'on' : 'off'); } catch {}
    if (enabled) {
      audio();
      setTimeout(() => play('gain'), 50);
    }
    return enabled;
  }

  return { play, toggle, get enabled() { return enabled; } };
})();

// --- Hilfen ------------------------------------------------------------------

function lbRank(rows) {
  rows.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'de'));
  rows.forEach((r, i) => { r.rank = i && rows[i - 1].points === r.points ? rows[i - 1].rank : i + 1; });
  return rows;
}

// Rangliste für eine Ansicht: '' = gesamt, sonst ein Spiel.
function lbRows(data, view) {
  if (!view) return data.rows;
  return lbRank(data.rows.filter((r) => view in r.games).map((r) => ({ ...r, points: r.games[view] })));
}

function lbAgo(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 45) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} Std.`;
  return new Date(at).toLocaleDateString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

const lbSigned = (n) => (n > 0 ? `+${n}` : `${n}`);

function lbCountUp(el, to) {
  const from = el._value ?? to;
  el._value = to;
  cancelAnimationFrame(el._raf);
  if (from === to || reducedMotion.matches) {
    el.textContent = to;
    return;
  }
  const start = performance.now();
  const dur = Math.min(1200, 300 + Math.abs(to - from) * 15);
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(from + (to - from) * eased);
    if (t < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

// Großes Overlay mit Konfetti, wenn jemand neu an der Spitze steht.
function lbCelebrate(name, points) {
  const el = document.createElement('div');
  el.className = 'lb-celebrate';
  const colors = ['#38e1ff', '#b16cff', '#ffc857', '#3ddc84', '#ff5c7a'];
  const confetti = reducedMotion.matches ? '' : Array.from({ length: 70 }, (_, i) => {
    const x = (Math.random() * 2 - 1) * 55;
    const y = 30 + Math.random() * 70;
    const style = `--x:${x}vw;--y:${y}vh;--r:${Math.round(Math.random() * 720 - 360)}deg;--d:${(1.6 + Math.random() * 1.6).toFixed(2)}s;--delay:${(Math.random() * 0.25).toFixed(2)}s;background:${colors[i % colors.length]}`;
    return `<i style="${style}"></i>`;
  }).join('');
  el.innerHTML = `<div class="lb-confetti">${confetti}</div>
    <div class="lb-celebrate-box"><span class="lb-crown">👑</span><small>Neue Führung</small><strong>${esc(name)}</strong><em>${points} Punkte</em></div>`;
  document.body.append(el);
  setTimeout(() => el.classList.add('out'), 3600);
  setTimeout(() => el.remove(), 4200);
}

// --- Leaderboard ---------------------------------------------------------------

// els: { list, tabs, feed, sound }
// opts: { limit, rotate (TV: Spiele durchwechseln), userId (eigene Zeile markieren) }
function createLeaderboard(els, opts = {}) {
  let data = null;
  let view = '';
  let rowEls = new Map();
  let seenScores = null;
  let rotateTimer = null;

  function setView(next, animate = true) {
    if (next === view) return;
    view = next;
    render(null, animate);
    scheduleRotate();
  }

  function scheduleRotate() {
    clearTimeout(rotateTimer);
    if (!opts.rotate || !data || !data.games.length) return;
    rotateTimer = setTimeout(() => {
      const views = ['', ...data.games];
      setView(views[(views.indexOf(view) + 1) % views.length]);
    }, LB_ROTATE_MS);
  }

  function renderTabs() {
    const views = data.games.length ? ['', ...data.games] : [];
    if (!views.includes(view)) view = '';
    els.tabs.hidden = !views.length;
    els.tabs.classList.toggle('rotating', Boolean(opts.rotate));
    els.tabs.style.setProperty('--rotate', `${LB_ROTATE_MS}ms`);
    els.tabs.innerHTML = views.map((v) => `<button type="button" class="${v === view ? 'active' : ''}" data-view="${esc(v)}">${v ? esc(v) : 'Gesamt'}</button>`).join('');
  }

  function makeRow() {
    const li = document.createElement('li');
    li.className = 'lb-row';
    li.innerHTML = '<span class="lb-rank"></span><span class="lb-name"></span><span class="lb-trend"></span><span class="lb-points"></span>';
    return li;
  }

  function pop(li, delta) {
    li.classList.remove('lb-gain', 'lb-loss');
    void li.offsetWidth;
    li.classList.add(delta > 0 ? 'lb-gain' : 'lb-loss');
    const chip = document.createElement('span');
    chip.className = `lb-chip ${delta > 0 ? 'up' : 'down'}`;
    chip.textContent = lbSigned(delta);
    li.append(chip);
    setTimeout(() => chip.remove(), 1800);
  }

  // old: vorheriger Stand (für Punkte- und Platzwechsel), null bei reinem Umschalten.
  function render(old, animate = true) {
    renderTabs();
    const list = lbRows(data, view);
    const before = old ? new Map(lbRows(old, view).map((r) => [r.id, r])) : null;

    if (!list.length) {
      els.list.innerHTML = `<li class="empty">${data.rows.length ? 'Noch keine Punkte in diesem Spiel' : 'Noch keine Spieler'}</li>`;
      rowEls = new Map();
      return;
    }

    const limit = opts.limit || 10;
    let shown = list.slice(0, limit);
    const mine = opts.userId && list.find((r) => r.userId === opts.userId);
    const mineOutside = mine && !shown.includes(mine);
    if (mineOutside) shown = [...shown.slice(0, limit - 1), mine];

    const firstTop = new Map();
    if (animate) for (const [id, el] of rowEls) firstTop.set(id, el.getBoundingClientRect().top);

    const best = Math.max(1, list[0].points);
    const next = new Map();
    const pops = [];
    els.list.querySelector('.empty')?.remove();
    for (const r of shown) {
      const li = rowEls.get(r.id) || makeRow();
      li.dataset.id = r.id;
      li.dataset.rank = r.rank;
      li.classList.toggle('lb-you', Boolean(opts.userId && r.userId === opts.userId));
      li.classList.toggle('lb-gap', Boolean(mineOutside && r === mine));
      li.classList.toggle('lb-leader', r.rank === 1 && r.points > 0);
      li.style.setProperty('--pct', `${Math.max(0, Math.min(100, (r.points / best) * 100)).toFixed(1)}%`);
      li.querySelector('.lb-rank').textContent = r.rank;
      li.querySelector('.lb-name').innerHTML = `${r.rank === 1 && r.points > 0 ? '<span class="lb-crown">👑</span>' : ''}${esc(r.name)}${opts.userId && r.userId === opts.userId ? ' <span class="lb-you-tag">Du</span>' : ''}${r.seat ? ` <small>Platz ${esc(r.seat)}</small>` : ''}`;
      lbCountUp(li.querySelector('.lb-points'), r.points);

      const prev = before && before.get(r.id);
      if (prev) {
        const moved = prev.rank - r.rank;
        if (moved) {
          const trend = li.querySelector('.lb-trend');
          trend.className = `lb-trend ${moved > 0 ? 'up' : 'down'}`;
          trend.textContent = `${moved > 0 ? '▲' : '▼'}${Math.abs(moved)}`;
          clearTimeout(trend._timer);
          trend._timer = setTimeout(() => { trend.className = 'lb-trend'; trend.textContent = ''; }, 20000);
        }
        if (r.points !== prev.points) pops.push([li, r.points - prev.points]);
      }
      els.list.append(li);
      next.set(r.id, li);
    }
    for (const [id, el] of rowEls) if (!next.has(id)) el.remove();
    rowEls = next;

    if (!animate || reducedMotion.matches) {
      pops.forEach(([li, d]) => pop(li, d));
      return;
    }
    // FLIP: Zeilen springen an den neuen Platz und gleiten von der alten Position dorthin.
    for (const [id, el] of rowEls) {
      const top = firstTop.get(id);
      if (top === undefined) {
        el.classList.remove('lb-enter');
        void el.offsetWidth;
        el.classList.add('lb-enter');
        continue;
      }
      const dy = top - el.getBoundingClientRect().top;
      if (!dy) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      el.classList.toggle('lb-moving', Math.abs(dy) > 4);
    }
    void els.list.offsetWidth;
    for (const el of rowEls.values()) {
      if (!el.style.transform) continue;
      el.style.transition = '';
      el.style.transform = '';
      setTimeout(() => el.classList.remove('lb-moving'), 900);
    }
    pops.forEach(([li, d]) => pop(li, d));
  }

  function renderFeed(fresh) {
    if (!els.feed) return;
    els.feed.innerHTML = data.recent.slice(0, opts.feed || 4).map((s) => {
      const src = LB_SOURCES[s.source] || LB_SOURCES.manual;
      const what = [s.reason, s.game].filter(Boolean).map(esc).join(' · ');
      return `<li class="${fresh.has(s.id) ? 'lb-new' : ''} ${s.points < 0 ? 'neg' : ''}" title="${esc(src.label)}">
        <span class="lb-feed-icon">${src.icon}</span>
        <span class="lb-feed-points">${lbSigned(s.points)}</span>
        <span class="lb-feed-text"><strong>${esc(s.name)}</strong>${what ? ` <small>${what}</small>` : ''}</span>
        <time>${lbAgo(s.at)}</time>
      </li>`;
    }).join('');
  }

  function update(next) {
    const old = data;
    data = next;
    const ids = new Set(next.recent.map((s) => s.id));
    const fresh = new Set(seenScores ? next.recent.filter((s) => !seenScores.has(s.id)).map((s) => s.id) : []);
    seenScores = ids;
    if (old && fresh.size && opts.rotate && view) {
      // Neue Punkte: zurück zur Gesamtansicht, damit alle die Änderung sehen.
      view = '';
      render(null, false);
    }
    render(old);
    renderFeed(fresh);
    scheduleRotate();
    if (!old) return;

    // Neue Führung feiern, sonst kurzer Sound je nach Richtung.
    const leader = (d) => (d.rows[0] && d.rows[0].points > 0 && !(d.rows[1] && d.rows[1].points === d.rows[0].points) ? d.rows[0] : null);
    const was = leader(old);
    const now = leader(next);
    if (now && now.id !== (was && was.id) && fresh.size) {
      lbSound.play('leader');
      lbCelebrate(now.name, now.points);
    } else if (fresh.size) {
      const sum = next.recent.filter((s) => fresh.has(s.id)).reduce((a, s) => a + s.points, 0);
      lbSound.play(sum < 0 ? 'loss' : sum >= 25 ? 'bigGain' : 'gain');
    }
  }

  // Angemeldet: eigene Zeile markieren, Spiele per Klick statt automatisch wechseln.
  function setUser(userId, more = {}) {
    Object.assign(opts, { userId }, more);
    scheduleRotate();
    if (data) render(null, false);
  }

  els.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (btn) setView(btn.dataset.view);
  });

  if (els.sound) {
    const showSound = () => {
      els.sound.textContent = lbSound.enabled ? '🔊' : '🔇';
      els.sound.title = lbSound.enabled ? 'Ton aus' : 'Ton an';
    };
    showSound();
    els.sound.addEventListener('click', () => {
      lbSound.toggle();
      showSound();
    });
  }

  // "vor x Min." aktuell halten.
  setInterval(() => data && renderFeed(new Set()), 30000);

  return { update, setUser };
}
