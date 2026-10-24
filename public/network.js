'use strict';

// Netzwerk-Monitoring im Dashboard und im Admin-Bereich: Ping-Kacheln,
// Internet-Durchsatz der FritzBox, Geräte-Liste, Verbindungstest mit Tacho
// und kleine Soundeffekte. Alles in einer Funktion, damit sich die Namen
// nicht mit display.js oder admin.js in die Quere kommen.

window.NetUI = (() => {
  const byId = (id) => document.getElementById(id);
  const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

  let password = null;
  try { password = sessionStorage.getItem('lanparty-admin'); } catch {}
  const auth = password ? { Authorization: 'Bearer ' + password } : {};

  // --- Formatierung --------------------------------------------------------------

  function mbitText(mbit) {
    if (mbit == null) return '–';
    return mbit >= 100 ? nf0.format(mbit) : nf1.format(mbit);
  }
  const rateMbit = (bytesPerSec) => (bytesPerSec == null ? null : (bytesPerSec * 8) / 1e6);
  const msText = (ms) => (ms == null ? '–' : ms < 10 ? nf1.format(ms) : nf0.format(ms));

  // Ampel: unter 30 ms gut, unter 80 ms geht so, darüber schlecht.
  function quality(t) {
    if (!t || t.ok === null) return 'unknown';
    if (!t.ok) return 'offline';
    if (t.latency == null) return 'online';
    return t.latency < 30 ? 'online' : t.latency < 80 ? 'warn' : 'slow';
  }

  function since(ts) {
    const min = Math.floor((Date.now() - ts) / 60000);
    if (min < 1) return 'gerade eben';
    if (min < 60) return `seit ${min} min`;
    return `seit ${Math.floor(min / 60)} h ${min % 60} min`;
  }

  // --- Soundeffekte (Web Audio, keine Dateien) -------------------------------------

  const sound = (() => {
    let ctx = null;
    let muted = false;
    try { muted = localStorage.getItem('lp-net-sound') === 'off'; } catch {}

    function ensure() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    // Browser erlauben Ton erst nach einer Eingabe; der Kiosk-Browser startet mit Freigabe.
    for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, ensure, { once: true, capture: true });
    try { ensure(); } catch {}

    function tone(freq, at, dur, { type = 'sine', gain = 0.12, to = null } = {}) {
      const c = ensure();
      if (!c || muted || c.state !== 'running') return;
      const t0 = c.currentTime + at;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    }

    return {
      up: () => { tone(660, 0, 0.12); tone(990, 0.1, 0.22); },
      down: () => { tone(440, 0, 0.18, { type: 'square', gain: 0.06 }); tone(300, 0.16, 0.35, { type: 'square', gain: 0.06, to: 180 }); },
      blip: () => tone(1400, 0, 0.04, { type: 'triangle', gain: 0.04 }),
      start: () => { tone(300, 0, 0.5, { type: 'sawtooth', gain: 0.04, to: 1200 }); },
      done: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.3, { type: 'triangle', gain: 0.1 })),
      get muted() { return muted; },
      toggle() {
        muted = !muted;
        try { localStorage.setItem('lp-net-sound', muted ? 'off' : 'on'); } catch {}
        if (!muted) this.up();
        return muted;
      },
    };
  })();

  // --- Zeichnen ----------------------------------------------------------------------

  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return null;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Latenzverlauf: Linie mit Verlauf darunter, Aussetzer als rote Striche.
  // shift (0..1) schiebt den Graphen beim Eintreffen neuer Werte weich nach links.
  function sparkline(canvas, history, { color = css('--accent'), shift = 0, points = 60 } = {}) {
    const fit = fitCanvas(canvas);
    if (!fit) return;
    const { ctx, w, h } = fit;
    const values = history.filter((v) => typeof v === 'number' && v >= 0);
    const max = Math.max(20, ...values) * 1.15;
    const step = w / (points - 1);
    const x0 = w - (history.length - 1 + shift) * step;
    const y = (v) => h - 2 - (v / max) * (h - 4);

    ctx.fillStyle = css('--bad');
    history.forEach((v, i) => {
      if (v === null) ctx.fillRect(x0 + i * step - 1, 0, 2, h);
    });

    ctx.beginPath();
    let open = false;
    history.forEach((v, i) => {
      if (typeof v !== 'number' || v < 0) { open = false; return; }
      const x = x0 + i * step;
      if (open) ctx.lineTo(x, y(v)); else ctx.moveTo(x, y(v));
      open = true;
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // Durchsatz-Diagramm: Download als Fläche, Upload als Linie.
  function rateChart(canvas, history, shift = 0) {
    const fit = fitCanvas(canvas);
    if (!fit) return;
    const { ctx, w, h } = fit;
    const points = 60;
    const step = w / (points - 1);
    const max = Math.max(1e5, ...history.flat()) * 1.15;
    const x0 = w - (history.length - 1 + shift) * step;
    const y = (v) => h - (v / max) * (h - 4);

    ctx.strokeStyle = css('--line');
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(0, (h / 4) * i);
      ctx.lineTo(w, (h / 4) * i);
      ctx.stroke();
    }
    if (history.length < 2) return;

    const accent = css('--accent');
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, accent + '88');
    grad.addColorStop(1, accent + '00');
    ctx.beginPath();
    ctx.moveTo(x0, h);
    history.forEach(([d], i) => ctx.lineTo(x0 + i * step, y(d)));
    ctx.lineTo(x0 + (history.length - 1) * step, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    history.forEach(([d], i) => (i ? ctx.lineTo(x0 + i * step, y(d)) : ctx.moveTo(x0, y(d))));
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    history.forEach(([, u], i) => (i ? ctx.lineTo(x0 + i * step, y(u)) : ctx.moveTo(x0, y(u))));
    ctx.strokeStyle = css('--accent-2');
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Zahl weich zum neuen Wert laufen lassen.
  function tween(el, to, format) {
    const from = Number(el.dataset.value);
    el.dataset.value = to == null ? '' : to;
    if (to == null || !Number.isFinite(from) || el.dataset.value === '') {
      el.textContent = format(to);
      return;
    }
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / 600);
      const e = 1 - Math.pow(1 - t, 3);
      el.textContent = format(from + (to - from) * e);
      if (t < 1 && el.dataset.value === String(to)) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // --- Dashboard-Karte -------------------------------------------------------------

  function initCard() {
    const card = byId('networkCard');
    if (!card) return;

    let snap = null;
    let prev = new Map();
    let lastEventAt = null;
    let shiftStart = 0;
    let me = null;
    let tests = [];

    const soundBtn = byId('netSound');
    const paintSound = () => {
      soundBtn.textContent = sound.muted ? '🔇' : '🔊';
      soundBtn.title = sound.muted ? 'Töne einschalten' : 'Töne ausschalten';
    };
    paintSound();
    soundBtn.addEventListener('click', () => { sound.toggle(); paintSound(); });

    function tileHtml(t) {
      const q = quality(t);
      const value = !t.ok ? (t.ok === null ? '…' : 'offline') : t.latency == null ? 'online' : null;
      return `<div class="net-tile ${q}" data-key="${esc(t.key)}">
        <div class="net-tile-head"><span class="pulse-dot"></span><span>${esc(t.name)}</span></div>
        <div class="net-tile-value">${value ? `<span class="v">${value}</span>` : `<span class="v" data-ms></span><small>ms</small>`}</div>
        <canvas class="spark"></canvas>
        <div class="net-tile-foot">${t.loss ? `<span class="loss">${t.loss}% Verlust</span>` : ''}${t.jitter != null ? `<span>±${msText(t.jitter)} ms</span>` : ''}</div>
      </div>`;
    }

    function deviceHtml(t) {
      const q = quality(t);
      const info = !t.ok ? (t.ok === null ? 'prüfe…' : `offline ${since(t.since)}`) : t.quiet ? 'online' : `${msText(t.latency)} ms`;
      return `<li class="net-dev ${q}" data-key="${esc(t.key)}" title="${t.quiet ? 'Antwortet nicht auf Ping, ist aber im Netz' : ''}">
        <span class="pulse-dot"></span>
        <span class="name">${esc(t.name)}</span>
        <canvas class="spark"></canvas>
        ${t.loss && t.ok ? `<span class="loss">${t.loss}%</span>` : ''}
        <span class="info">${info}</span>
      </li>`;
    }

    function render() {
      if (!snap) return;
      const core = ['internet', 'router', 'dns'].map((k) => snap.targets.find((t) => t.key === k)).filter(Boolean);
      byId('netTiles').innerHTML = core.map(tileHtml).join('');
      for (const t of core) {
        const el = card.querySelector(`.net-tile[data-key="${t.key}"] [data-ms]`);
        if (el) {
          const before = prev.get(t.key);
          el.dataset.value = before && before.latency != null ? before.latency : '';
          tween(el, t.latency, msText);
        }
      }

      const devices = snap.targets.filter((t) => t.kind === 'device');
      const offline = devices.filter((d) => d.ok === false).length;
      byId('netDevCount').textContent = devices.length ? `${devices.length - offline}/${devices.length} online` : '';
      byId('netDevices').innerHTML = devices.length
        ? devices.map(deviceHtml).join('')
        : '<li class="empty">Noch keine Geräte eingetragen</li>';

      const wan = snap.wan;
      byId('netWan').hidden = !wan.available;
      if (wan.available) {
        tween(byId('netDown'), rateMbit(wan.down), mbitText);
        tween(byId('netUp'), rateMbit(wan.up), mbitText);
        const useDown = wan.maxDown ? Math.min(100, (wan.down * 8 * 100) / wan.maxDown) : 0;
        const useUp = wan.maxUp ? Math.min(100, (wan.up * 8 * 100) / wan.maxUp) : 0;
        byId('netDownBar').style.width = useDown + '%';
        byId('netUpBar').style.width = useUp + '%';
        byId('netMax').textContent = wan.maxDown ? `Leitung ${mbitText(wan.maxDown / 1e6)} / ${mbitText(wan.maxUp / 1e6)} Mbit/s` : '';
      }

      renderSpeedtestBanner();
      shiftStart = performance.now();
      animate();
    }

    // Wechsel erkennen: Ton, Wackeln, Hinweis im Ticker der Karte.
    function react(next) {
      let wentDown = false;
      let wentUp = false;
      for (const t of next.targets) {
        const old = prev.get(t.key);
        if (old && old.ok !== null && t.ok !== null && old.ok !== t.ok) {
          if (t.ok) wentUp = true; else wentDown = true;
          requestAnimationFrame(() => {
            const el = card.querySelector(`[data-key="${CSS.escape(t.key)}"]`);
            if (el) {
              el.classList.add(t.ok ? 'flash-up' : 'flash-down');
              setTimeout(() => el.classList.remove('flash-up', 'flash-down'), 1600);
            }
          });
        }
      }
      if (wentDown) sound.down(); else if (wentUp) sound.up();

      const ev = next.events[0];
      if (ev && lastEventAt !== null && ev.at > lastEventAt) showEvent(ev);
      if (ev) lastEventAt = Math.max(lastEventAt || 0, ev.at);
      else lastEventAt = lastEventAt || 0;
    }

    function showEvent(ev) {
      const el = byId('netEvent');
      el.textContent = `${ev.type === 'down' ? '⚠' : '✓'} ${ev.text}`;
      el.className = `net-event ${ev.type} show`;
      clearTimeout(showEvent.timer);
      showEvent.timer = setTimeout(() => el.classList.remove('show'), 6000);
    }

    // Graphen laufen nach jeder Messung knapp eine Sekunde lang weich ein Stück
    // nach links und stehen danach still (schont die CPU des Pi).
    let animating = false;
    function frame(now) {
      const shift = Math.max(0, 1 - (now - shiftStart) / 900);
      for (const t of snap.targets) {
        const canvas = card.querySelector(`[data-key="${CSS.escape(t.key)}"] canvas.spark`);
        if (canvas) sparkline(canvas, t.history, { shift, color: t.ok === false ? css('--bad') : css('--accent') });
      }
      if (snap.wan.available) rateChart(byId('netChart'), snap.wan.history, shift);
      animating = shift > 0;
      if (animating) requestAnimationFrame(frame);
    }
    const animate = () => { if (snap && !animating) { animating = true; requestAnimationFrame(frame); } };
    window.addEventListener('resize', animate);

    window.addEventListener('lp:net', (e) => {
      const next = e.detail;
      if (snap) react(next);
      else lastEventAt = next.events[0]?.at || 0;
      snap = next;
      render();
      prev = new Map(next.targets.map((t) => [t.key, t]));
    });

    // --- Speed-Rangliste und Verbindungstest -------------------------------------

    function renderTests(list) {
      tests = list || [];
      const ranked = [...tests].sort((a, b) => b.down - a.down).slice(0, 6);
      byId('netTests').innerHTML = ranked.length
        ? ranked.map((t, i) => `<li><span class="rank">${i + 1}</span><span class="name">${esc(t.username)}</span><span class="down">↓ ${mbitText(t.down)}</span><span class="up">↑ ${mbitText(t.up)}</span><span class="ping">${msText(t.ping)} ms</span></li>`).join('')
        : '<li class="empty">Noch keine Verbindungstests</li>';
      byId('netTestsBox').hidden = !ranked.length && !(me && canTest());
    }

    function renderSpeedtestBanner() {
      const st = snap && snap.speedtest;
      const el = byId('netSpeedBanner');
      el.hidden = !st || (testing && st.username === me?.username);
      if (st) el.textContent = `⚡ ${st.username} testet gerade die Verbindung…`;
    }

    const canTest = () => me && (me.isAdmin || me.features.some((f) => f.key === 'netzwerk' && f.enabled));

    fetch('/api/me', { headers: auth }).then(async (res) => {
      if (!res.ok) return;
      me = await res.json();
      byId('netSpeed').hidden = !canTest();
      renderTests(tests);
    });

    // Tacho von 0 bis 1000 Mbit/s mit gestauchter Skala, damit auch WLAN-Werte gut lesbar sind.
    const TICKS = [0, 5, 10, 25, 50, 100, 250, 500, 1000];
    const toPos = (v) => {
      for (let i = 1; i < TICKS.length; i++) {
        if (v <= TICKS[i]) return (i - 1 + (v - TICKS[i - 1]) / (TICKS[i] - TICKS[i - 1])) / (TICKS.length - 1);
      }
      return 1;
    };
    let gaugeShown = 0;
    let gaugeTarget = 0;
    let gaugeColor = css('--accent');

    function drawGauge() {
      gaugeShown += (gaugeTarget - gaugeShown) * 0.12;
      const fit = fitCanvas(byId('netGauge'));
      const r = fit ? Math.min(fit.w / 2, fit.h) - 12 : 0;
      if (r > 20) {
        const { ctx, w, h } = fit;
        const cx = w / 2;
        const cy = h - 6;
        const a0 = Math.PI;
        const pos = toPos(gaugeShown);
        ctx.lineCap = 'round';
        ctx.lineWidth = 12;
        ctx.strokeStyle = css('--card-2');
        ctx.beginPath();
        ctx.arc(cx, cy, r, a0, 2 * Math.PI);
        ctx.stroke();
        const grad = ctx.createLinearGradient(cx - r, 0, cx + r, 0);
        grad.addColorStop(0, css('--accent'));
        grad.addColorStop(1, css('--accent-2'));
        ctx.strokeStyle = grad;
        ctx.shadowColor = gaugeColor;
        ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.arc(cx, cy, r, a0, a0 + Math.PI * pos);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = css('--muted');
        ctx.font = `${Math.max(9, r / 9)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        TICKS.forEach((t, i) => {
          const a = a0 + (Math.PI * i) / (TICKS.length - 1);
          ctx.fillText(String(t), cx + Math.cos(a) * (r - 24), cy + Math.sin(a) * (r - 24) + 4);
        });
        const a = a0 + Math.PI * pos;
        ctx.strokeStyle = css('--text');
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * (r - 8), cy + Math.sin(a) * (r - 8));
        ctx.stroke();
        ctx.fillStyle = css('--text');
        ctx.beginPath();
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.fill();
      }
      if (testing || Math.abs(gaugeTarget - gaugeShown) > 0.05) requestAnimationFrame(drawGauge);
    }

    let testing = false;

    function setPhase(label, value) {
      byId('netPhase').textContent = label;
      if (value !== undefined) {
        gaugeTarget = value;
        byId('netGaugeValue').textContent = mbitText(value);
      }
    }

    function setResult(key, text) {
      const el = card.querySelector(`[data-result="${key}"]`);
      el.textContent = text;
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
    }

    const speedApi = (path, opts = {}) => fetch('/api/net/speed/' + path, { ...opts, headers: { ...auth, ...(opts.headers || {}) } });

    async function measurePing() {
      const times = [];
      for (let i = 0; i < 16; i++) {
        const t0 = performance.now();
        await speedApi('ping?r=' + Math.random(), { cache: 'no-store' });
        if (i > 0) times.push(performance.now() - t0);
        sound.blip();
      }
      const sorted = [...times].sort((a, b) => a - b);
      let jitter = 0;
      for (let i = 1; i < times.length; i++) jitter += Math.abs(times[i] - times[i - 1]);
      return { ping: sorted[Math.floor(sorted.length / 2)], jitter: jitter / (times.length - 1) };
    }

    async function measureDown() {
      const ctrl = new AbortController();
      const res = await speedApi('down?r=' + Math.random(), { signal: ctrl.signal, cache: 'no-store' });
      const reader = res.body.getReader();
      const t0 = performance.now();
      let bytes = 0;
      // Die erste halbe Sekunde zählt nicht (TCP läuft erst warm).
      let base = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          const now = performance.now();
          if (base === null && now - t0 > 500) base = { bytes, at: now };
          if (base && now > base.at) setPhase('Download', ((bytes - base.bytes) * 8) / ((now - base.at) * 1000));
          if (now - t0 > 5500) break;
        }
      } catch {}
      ctrl.abort();
      const end = performance.now();
      if (!base || end <= base.at) return (bytes * 8) / ((end - t0) * 1000);
      return ((bytes - base.bytes) * 8) / ((end - base.at) * 1000);
    }

    async function measureUp() {
      const chunk = new Uint8Array(2 * 1024 * 1024);
      for (let i = 0; i < chunk.length; i += 65536) crypto.getRandomValues(chunk.subarray(i, i + 65536));
      const blob = new Blob([chunk]);
      const t0 = performance.now();
      let bytes = 0;
      const worker = async () => {
        while (performance.now() - t0 < 5000) {
          const res = await speedApi('up', { method: 'POST', body: blob });
          if (!res.ok) break;
          bytes += blob.size;
          setPhase('Upload', (bytes * 8) / ((performance.now() - t0) * 1000));
        }
      };
      await Promise.all([worker(), worker()]);
      return (bytes * 8) / ((performance.now() - t0) * 1000);
    }

    byId('netTestBtn').addEventListener('click', async () => {
      if (testing) return;
      const btn = byId('netTestBtn');
      byId('netTestError').textContent = '';
      const start = await speedApi('start', { method: 'POST' });
      if (!start.ok) {
        byId('netTestError').textContent = (await start.json().catch(() => ({}))).error || 'Test nicht möglich';
        return;
      }
      testing = true;
      btn.disabled = true;
      card.classList.add('testing');
      for (const el of card.querySelectorAll('[data-result]')) el.textContent = '–';
      sound.start();
      requestAnimationFrame(drawGauge);
      try {
        setPhase('Ping', 0);
        const { ping, jitter } = await measurePing();
        setResult('ping', `${msText(ping)} ms`);
        setResult('jitter', `±${msText(jitter)} ms`);
        const down = await measureDown();
        setResult('down', `${mbitText(down)} Mbit/s`);
        setPhase('Upload', 0);
        const up = await measureUp();
        setResult('up', `${mbitText(up)} Mbit/s`);
        setPhase('Fertig!', down);
        gaugeColor = css('--ok');
        sound.done();
        await speedApi('result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ping, jitter, down, up }),
        });
      } catch {
        byId('netTestError').textContent = 'Test abgebrochen, die Verbindung zum Pi ist weg.';
        speedApi('result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cancel: true }) }).catch(() => {});
      } finally {
        testing = false;
        btn.disabled = false;
        btn.textContent = 'Nochmal testen';
        card.classList.remove('testing');
        setTimeout(() => { gaugeColor = css('--accent'); }, 2000);
      }
    });

    return { renderTests };
  }

  const card = initCard();

  return {
    sound,
    sparkline,
    quality,
    since,
    msText,
    mbitText,
    rateMbit,
    // display.js reicht bei jeder Änderung die Liste der Verbindungstests durch.
    renderTests: (list) => card && card.renderTests(list),
  };
})();
