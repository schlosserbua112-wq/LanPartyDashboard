'use strict';

// Musik im Dashboard: "Läuft gerade" in der Kopfzeile (auch auf der TV-Anzeige),
// Einblendung bei neuen Wünschen und für Nutzer mit dem Feature „Musik“ eine
// Karte zum Suchen, Wünschen und Abstimmen fürs Überspringen.

function createMusic({ auth }) {
  const $ = (id) => document.getElementById(id);
  let music = null;
  let receivedAt = 0;
  let me = null;
  let canUse = false;
  let seenWish; // undefined bis zum ersten Zustand: alte Wünsche nicht einblenden
  let seenSkip;
  let nowKey = '';
  let results = [];
  const wished = new Set();

  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function position() {
    if (!music?.track) return 0;
    const elapsed = music.playing ? music.age + (Date.now() - receivedAt) : 0;
    return Math.min(music.track.durationMs, music.progressMs + elapsed);
  }

  // Kleiner Klang über WebAudio, nur im eigenen Browser (die Musik läuft ja schon).
  let audio = null;
  function chime(notes) {
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audio.currentTime;
      notes.forEach((freq, i) => {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        const t = t0 + i * 0.09;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
        osc.connect(gain).connect(audio.destination);
        osc.start(t);
        osc.stop(t + 0.3);
      });
    } catch {}
  }

  // --- Kopfzeile -------------------------------------------------------------

  function renderTopbar() {
    const show = Boolean(music?.connected && music.track);
    $('nowPlaying').hidden = !show;
    if (!show) return;
    const t = music.track;
    $('nowPlaying').classList.toggle('paused', !music.playing);
    if ($('npTitle').textContent !== t.name) {
      $('nowPlaying').classList.remove('swap');
      void $('nowPlaying').offsetWidth; // Animation neu starten
      $('nowPlaying').classList.add('swap');
    }
    $('npTitle').textContent = t.name;
    $('npArtist').textContent = t.artists + (t.by ? ` · gewünscht von ${t.by}` : '');
    if (t.image) $('npCover').src = t.image;
    $('npCover').hidden = !t.image;
  }

  function tick() {
    if (!music?.track) return;
    const pct = `${(position() / Math.max(1, music.track.durationMs)) * 100}%`;
    $('npProgress').style.width = pct;
    const bar = document.querySelector('#musicNow .progress span');
    if (bar) bar.style.width = pct;
    const time = document.querySelector('#musicNow .times');
    if (time) time.textContent = `${fmt(position())} / ${fmt(music.track.durationMs)}`;
  }
  setInterval(tick, 500);

  // --- Einblendungen -----------------------------------------------------------

  function toast(html) {
    const el = $('musicToast');
    el.innerHTML = `${html}<span class="notes" aria-hidden="true"><i>♪</i><i>♫</i><i>♪</i><i>♬</i></span>`;
    el.hidden = false;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 6000);
  }

  function announce() {
    const w = music.lastWish;
    const s = music.lastSkip;
    if (seenWish !== undefined && w && w.id !== seenWish) {
      toast(`🎵 <strong>${esc(w.by)}</strong> wünscht sich <strong>„${esc(w.name)}“</strong>`);
    }
    if (seenSkip !== undefined && s && s.id !== seenSkip) {
      toast(`⏭ <strong>„${esc(s.name)}“</strong> wurde weggestimmt`);
    }
    seenWish = w ? w.id : null;
    seenSkip = s ? s.id : null;
  }

  // --- Karte für Nutzer --------------------------------------------------------

  const canControl = () => me && (me.isAdmin || music?.usersCanControl);

  function renderNow() {
    const m = music;
    const t = m.track;
    // Nur neu aufbauen, wenn sich mehr als der Fortschritt geändert hat.
    const key = JSON.stringify([m.connected, m.error, t?.uri, t?.by, m.playing, m.skip.votes, m.skip.needed, m.skip.voterIds.includes(me.id), canControl(), m.device?.name]);
    if (key === nowKey) return;
    const trackChanged = !nowKey || JSON.parse(nowKey)[2] !== t?.uri;
    nowKey = key;

    if (!m.connected) {
      $('musicNow').innerHTML = '<p class="empty">Spotify ist noch nicht verbunden. Der Admin richtet das im Admin-Bereich unter „Musik“ ein.</p>';
      return;
    }
    if (!t) {
      $('musicNow').innerHTML = `<p class="empty">Gerade läuft nichts.${m.error ? `<br><small class="error">${esc(m.error)}</small>` : ''}</p>${controls()}`;
      return;
    }
    const voted = m.skip.voterIds.includes(me.id);
    $('musicNow').innerHTML = `
      <div class="now-cover ${trackChanged ? 'swap' : ''} ${m.playing ? 'spinning' : ''}">${t.image ? `<img src="${esc(t.image)}" alt="">` : '<span>♪</span>'}</div>
      <div class="now-info">
        <strong class="now-title">${esc(t.name)}</strong>
        <span>${esc(t.artists)}</span>
        ${t.by ? `<small class="by">gewünscht von ${esc(t.by)}</small>` : ''}
        <div class="progress"><span></span></div>
        <small class="times"></small>
        ${controls()}
        <button type="button" class="skip-btn ${voted ? 'voted' : ''}" data-music="skip" title="${voted ? 'Stimme zurückziehen' : 'Fürs Überspringen stimmen'}">
          ⏭ ${voted ? 'Du willst weiter' : 'Überspringen'} <span class="skip-count">${m.skip.votes}/${m.skip.needed}</span>
        </button>
        ${m.error ? `<small class="error">${esc(m.error)}</small>` : ''}
      </div>`;
    tick();
  }

  function controls() {
    if (!canControl()) return '';
    const vol = music.device?.volume;
    return `<div class="controls">
      <button type="button" class="icon" data-music="previous" title="Zurück">⏮</button>
      <button type="button" class="play" data-music="${music.playing ? 'pause' : 'play'}" title="${music.playing ? 'Pause' : 'Abspielen'}">${music.playing ? '⏸' : '▶'}</button>
      <button type="button" class="icon" data-music="next" title="Weiter">⏭</button>
      ${vol == null ? '' : `<label class="volume" title="Lautstärke">🔊 <input type="range" min="0" max="100" value="${vol}" id="musicVolume"></label>`}
      ${music.device ? `<small>${esc(music.device.name)}</small>` : ''}
    </div>`;
  }

  function renderQueue() {
    const q = music.connected ? music.queue : [];
    $('musicQueue').innerHTML = q.length
      ? q.map((t, i) => `<li style="--i:${i}">${t.image ? `<img src="${esc(t.image)}" alt="">` : '<span class="ph">♪</span>'}<span class="grow"><strong>${esc(t.name)}</strong><small>${esc(t.artists)}</small></span>${t.by ? `<span class="badge alt">${esc(t.by)}</span>` : ''}</li>`).join('')
      : '<li class="empty">Die Warteschlange ist leer. Wünsch dir was!</li>';
  }

  function renderResults() {
    const queued = new Set([music?.track?.uri, ...(music?.queue || []).map((t) => t.uri)]);
    $('musicResults').innerHTML = results.map((t) => {
      const done = wished.has(t.uri) || queued.has(t.uri);
      return `<li>${t.image ? `<img src="${esc(t.image)}" alt="">` : '<span class="ph">♪</span>'}
        <span class="grow"><strong>${t.explicit ? '<span class="explicit" title="Explicit">E</span> ' : ''}${esc(t.name)}</strong><small>${esc(t.artists)} · ${fmt(t.durationMs)}</small></span>
        <button type="button" class="${done ? 'secondary done' : ''}" data-wish="${esc(t.uri)}" ${done ? 'disabled' : ''}>${done ? '✓ In der Schlange' : '+ Wünschen'}</button></li>`;
    }).join('');
  }

  function renderCard() {
    $('musicAccount').textContent = music.connected && music.account ? `über ${music.account}` : '';
    $('wishHint').textContent = me.isAdmin ? '' : `(max. ${music.maxWishes} offen)`;
    $('musicSearch').querySelector('button').disabled = !music.connected;
    renderNow();
    renderQueue();
    if (results.length) renderResults();
  }

  async function call(method, url, body) {
    const res = await fetch('/api/music/' + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...auth },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    $('musicError').textContent = res.ok ? '' : data.error || 'Fehler';
    return res.ok ? data : null;
  }

  $('musicSearch').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = e.target.elements.q.value.trim();
    if (!q) return;
    $('musicResults').innerHTML = '<li class="empty">Suche…</li>';
    const data = await call('GET', 'search?q=' + encodeURIComponent(q));
    results = data ? data.tracks : [];
    if (data && !results.length) $('musicResults').innerHTML = '<li class="empty">Nichts gefunden</li>';
    else renderResults();
  });

  $('musicResults').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-wish]');
    if (!btn) return;
    const track = results.find((t) => t.uri === btn.dataset.wish);
    btn.disabled = true;
    if (await call('POST', 'queue', { uri: track.uri, name: `${track.name} – ${track.artists}` })) {
      wished.add(track.uri);
      chime([523, 659, 784]);
      btn.classList.add('pop');
    }
    renderResults();
  });

  $('musicNow').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-music]');
    if (!btn) return;
    const action = btn.dataset.music;
    if (action === 'skip') {
      if (await call('POST', 'skip')) chime([659, 523]);
      return;
    }
    call('POST', 'control', { action });
  });

  $('musicNow').addEventListener('change', (e) => {
    if (e.target.id === 'musicVolume') call('POST', 'control', { action: 'volume', value: Number(e.target.value) });
  });

  // --- Schnittstelle für display.js ------------------------------------------

  function render(next) {
    if (!next) return;
    music = next;
    receivedAt = Date.now();
    renderTopbar();
    announce();
    if (canUse) renderCard();
    tick();
  }

  function enterUserMode(user, allowed) {
    me = user;
    canUse = allowed;
    $('musicCard').hidden = !allowed;
    document.body.classList.toggle('has-music', allowed);
    if (allowed && music) renderCard();
  }

  return { render, enterUserMode };
}
