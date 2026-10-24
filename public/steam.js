'use strict';

// Spiele-Matrix im Dashboard: wer besitzt welches Steam-Spiel, wer hat es
// installiert und wer spielt gerade. Braucht $, esc und auth aus display.js.

const steamMatrix = (() => {
  const ROW_STEP = 150;
  let data = null;
  let rev = null;
  let filter = 'shared';
  let query = '';
  let limit = ROW_STEP;
  let animateRows = true;
  let loading = false;
  let started = false;
  let lastPlaying = {};

  // --- Soundeffekte (WebAudio, ohne Dateien) ---------------------------------

  // Stummschalten läuft zentral über FX.muteButton() (Taste M), siehe fx.js.
  let audio = null;

  function tone(freq, start, length, type = 'sine', gain = 0.08) {
    const t = audio.currentTime + start;
    const osc = audio.createOscillator();
    const amp = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(gain, t + 0.01);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(amp).connect(audio.destination);
    osc.start(t);
    osc.stop(t + length + 0.02);
  }

  // Browser spielen erst Töne, nachdem jemand auf der Seite geklickt hat.
  function sound(name) {
    if (FX.muted || !navigator.userActivation?.hasBeenActive) return;
    try {
      audio = audio || new AudioContext();
      if (audio.state === 'suspended') audio.resume();
    } catch { return; }
    if (name === 'install') { tone(523, 0, 0.12, 'triangle'); tone(784, 0.08, 0.2, 'triangle'); }
    if (name === 'uninstall') { tone(659, 0, 0.12, 'triangle'); tone(392, 0.08, 0.2, 'triangle'); }
    if (name === 'refresh') [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.07, 0.25, 'sine', 0.06));
    if (name === 'playing') { tone(880, 0, 0.15, 'square', 0.03); tone(1175, 0.12, 0.3, 'square', 0.03); }
    if (name === 'error') tone(180, 0, 0.3, 'sawtooth', 0.05);
  }

  // --- Daten -----------------------------------------------------------------

  async function api(method, url, body) {
    const res = await fetch('/api/steam/' + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...auth },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Fehler');
    return json;
  }

  async function load() {
    try {
      const next = await api('GET', 'matrix');
      announcePlaying(next);
      data = next;
      render();
    } catch (err) {
      $('steamError').textContent = err.message;
    }
  }

  // Ein kurzer Ton, wenn jemand ein Spiel startet.
  function announcePlaying(next) {
    const playing = Object.fromEntries(next.players.filter((p) => p.playing).map((p) => [p.id, p.playing.appid]));
    if (data && Object.entries(playing).some(([id, appid]) => lastPlaying[id] !== appid)) sound('playing');
    lastPlaying = playing;
  }

  // --- Darstellung -----------------------------------------------------------

  const iconUrl = (g) => g.icon ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.icon}.jpg` : '';
  const capsuleUrl = (g) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/capsule_184x69.jpg`;
  const hours = (minutes) => minutes >= 60 ? `${Math.round(minutes / 60)} h gespielt` : minutes ? `${minutes} min gespielt` : 'nie gespielt';

  function ago(ts) {
    if (!ts) return 'noch nie';
    const min = Math.round((Date.now() - ts) / 60000);
    return min < 1 ? 'gerade eben' : min < 60 ? `vor ${min} min` : `vor ${Math.round(min / 60)} h`;
  }

  function sortedGames() {
    const players = data.players.length;
    const q = query.trim().toLowerCase();
    return data.games
      .map((g) => ({
        ...g,
        installs: g.own.filter((o) => o[2]).length,
        playtime: g.own.reduce((sum, o) => sum + o[1], 0),
        playing: data.players.filter((p) => p.playing?.appid === g.appid).length,
      }))
      .filter((g) => !q || g.name.toLowerCase().includes(q))
      .filter((g) => filter === 'all' || (filter === 'shared' ? g.own.length >= 2 || players < 2 : g.own.length === players))
      .sort((a, b) => b.playing - a.playing || b.own.length - a.own.length || b.installs - a.installs || b.playtime - a.playtime || a.name.localeCompare(b.name));
  }

  function renderLink() {
    const { me, configured } = data;
    const p = me.profile;
    let html = '';
    if (!configured) {
      html = '<p class="muted">Der Admin muss noch einen Steam-API-Schlüssel eintragen.</p>';
    } else if (me.canLink && !p) {
      html = `<form class="row steam-link-form" id="steamLinkForm">
        <input name="profile" placeholder="Dein Steam-Profil-Link oder deine SteamID64" required>
        <button>Verknüpfen</button>
      </form>
      <p class="muted">Damit deine Spiele erscheinen, müssen in Steam unter <em>Profil → Privatsphäre</em> die „Spieldetails“ öffentlich sein.</p>`;
    } else if (p) {
      html = `<p class="steam-me">
        <span>Verknüpft als <strong>${esc(p.persona || p.steamId)}</strong> · ${p.gameCount} Spiele · aktualisiert ${ago(p.fetchedAt)}</span>
        <button type="button" class="icon" data-steam-action="refresh" title="Spieleliste neu laden">⟳ Aktualisieren</button>
        <button type="button" class="icon" data-steam-action="unlink" title="Anderes Profil verknüpfen">Ändern</button>
      </p>
      ${p.error ? `<p class="error">${esc(p.error)}</p>` : ''}`;
    }
    $('steamLink').innerHTML = html;
  }

  function renderCommon() {
    const everyone = data.players.length >= 2
      ? data.games.filter((g) => g.own.length === data.players.length)
        .sort((a, b) => b.own.filter((o) => o[2]).length - a.own.filter((o) => o[2]).length || a.name.localeCompare(b.name))
      : [];
    $('steamCommon').hidden = !everyone.length;
    $('steamCommon').innerHTML = everyone.length
      ? `<h3 class="side-title">Das können alle spielen <small>(${everyone.length})</small></h3>
        <ul class="steam-chips">${everyone.slice(0, 12).map((g, i) => {
          const ready = g.own.every((o) => o[2]);
          return `<li class="${ready ? 'ready' : ''}" style="--i:${i}" title="${ready ? 'Bei allen installiert' : `${g.own.filter((o) => o[2]).length} von ${g.own.length} haben es installiert`}">
            <img src="${capsuleUrl(g)}" alt="" loading="lazy" onerror="this.remove()">
            <span>${esc(g.name)}</span>${ready ? '<b>bereit</b>' : ''}
          </li>`;
        }).join('')}</ul>`
      : '';
  }

  function cell(g, own, player) {
    const mine = player.id === data.me.id;
    if (!own) return '<td class="cell none"><span>·</span></td>';
    const [, minutes, installed] = own;
    const playing = player.playing?.appid === g.appid;
    const cls = playing ? 'play' : installed ? 'inst' : 'own';
    const symbol = playing ? '▶' : installed ? '✓' : '○';
    const status = playing ? 'spielt gerade' : installed ? 'installiert' : 'besitzt es';
    const title = `${player.username}: ${status} · ${hours(minutes)}${mine ? ' · Klicken zum Umschalten „installiert“' : ''}`;
    return mine
      ? `<td class="cell ${cls}"><button type="button" data-install="${g.appid}" data-installed="${installed}" title="${esc(title)}">${symbol}</button></td>`
      : `<td class="cell ${cls}" title="${esc(title)}"><span>${symbol}</span></td>`;
  }

  function renderTable() {
    const { players, me } = data;
    const games = sortedGames();
    const shown = games.slice(0, limit);
    const myIndex = players.findIndex((p) => p.id === me.id);
    $('steamCount').textContent = players.length ? `${games.length} Spiele · ${players.length} Spieler` : '';

    if (!players.length) {
      $('steamMatrix').innerHTML = '';
      $('steamEmpty').textContent = 'Noch hat niemand sein Steam-Profil verknüpft.';
      $('steamMore').hidden = true;
      return;
    }
    $('steamEmpty').textContent = shown.length ? '' : 'Keine Spiele für diesen Filter.';

    const head = `<thead><tr><th class="game-col">Spiel</th>${players.map((p) => `
      <th class="player-col ${p.id === me.id ? 'me' : ''} ${p.playing ? 'is-playing' : ''}" title="${esc(p.persona ? `Steam: ${p.persona}` : p.username)}${p.error ? ` · ${esc(p.error)}` : ''}">
        ${p.avatar ? `<img src="${esc(p.avatar)}" alt="" loading="lazy" onerror="this.remove()">` : `<span class="avatar-fallback">${esc(p.username.slice(0, 1).toUpperCase())}</span>`}
        <span class="pname">${esc(p.username)}</span>
        ${p.playing ? `<span class="now">▶ ${esc(p.playing.name)}</span>` : p.error ? '<span class="warn">⚠</span>' : ''}
      </th>`).join('')}<th class="count-col">Haben</th><th></th></tr></thead>`;

    const rows = shown.map((g, i) => {
      const byPlayer = new Map(g.own.map((o) => [o[0], o]));
      const iOwn = byPlayer.has(myIndex);
      const icon = iconUrl(g);
      const delay = animateRows && i < 40 ? ` style="--i:${i}"` : '';
      const everyone = g.own.length === players.length && players.length > 1;
      return `<tr class="${animateRows ? 'enter' : ''} ${everyone ? 'everyone' : ''} ${g.playing ? 'playing' : ''}"${delay}>
        <th class="game-col"><div class="game-name">${icon ? `<img src="${icon}" alt="" loading="lazy" onerror="this.remove()">` : '<span class="icon-fallback">🎮</span>'}<span>${esc(g.name)}</span></div></th>
        ${players.map((p, idx) => cell(g, byPlayer.get(idx), p)).join('')}
        <td class="count-col"><span class="ratio"><span style="width:${(g.own.length / players.length) * 100}%"></span></span>${g.own.length}/${players.length}${g.installs ? ` <small>· ${g.installs}✓</small>` : ''}</td>
        <td class="launch">${iOwn
          ? `<a href="steam://run/${g.appid}" title="In Steam starten (installiert es, falls nötig)">Starten</a>`
          : `<a href="https://store.steampowered.com/app/${g.appid}/" target="_blank" rel="noopener" title="Im Steam-Shop öffnen">Shop</a>`}</td>
      </tr>`;
    }).join('');

    $('steamMatrix').innerHTML = head + `<tbody>${rows}</tbody>`;
    $('steamMore').hidden = games.length <= limit;
    $('steamMore').textContent = `${Math.min(ROW_STEP, games.length - limit)} weitere anzeigen`;
    animateRows = false;
  }

  function render() {
    if (!data) return;
    renderLink();
    renderCommon();
    renderTable();
    $('steamUnlinked').textContent = [
      data.unlinked.length ? `Noch nicht verknüpft: ${data.unlinked.join(', ')}.` : '',
      ...data.problems.map((p) => `${p.username}: ${p.error}.`),
    ].join(' ');
  }

  // --- Aktionen --------------------------------------------------------------

  async function run(action, button) {
    if (loading) return;
    loading = true;
    $('steamCard').classList.add('loading');
    if (button) button.disabled = true;
    $('steamError').textContent = '';
    try {
      await action();
      return true;
    } catch (err) {
      $('steamError').textContent = err.message;
      sound('error');
      return false;
    } finally {
      loading = false;
      $('steamCard').classList.remove('loading');
      if (button) button.disabled = false;
    }
  }

  function bind() {
    $('steamCard').addEventListener('submit', async (e) => {
      if (e.target.id !== 'steamLinkForm') return;
      e.preventDefault();
      const ok = await run(() => api('PUT', 'me', { profile: e.target.elements.profile.value }), e.target.querySelector('button'));
      if (ok) {
        animateRows = true;
        sound('refresh');
        load();
      }
    });

    $('steamCard').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.install) {
        const installed = btn.dataset.installed !== '1';
        btn.closest('td').classList.add('pop');
        sound(installed ? 'install' : 'uninstall');
        await run(() => api('PUT', `installed/${btn.dataset.install}`, { installed }));
        return;
      }
      if (btn.dataset.steamAction === 'refresh') {
        if (await run(() => api('POST', 'me/refresh'), btn)) sound('refresh');
      }
      if (btn.dataset.steamAction === 'unlink' && confirm('Steam-Profil trennen? Deine „installiert“-Haken gehen dabei verloren.')) {
        await run(() => api('PUT', 'me', { profile: '' }));
      }
      if (btn.dataset.filter) {
        filter = btn.dataset.filter;
        limit = ROW_STEP;
        animateRows = true;
        for (const b of $('steamFilters').querySelectorAll('button')) b.classList.toggle('active', b === btn);
        renderTable();
      }
      if (btn.id === 'steamMore') {
        limit += ROW_STEP;
        renderTable();
      }
    });

    $('steamSearch').addEventListener('input', (e) => {
      query = e.target.value;
      limit = ROW_STEP;
      renderTable();
    });
  }

  return {
    start() {
      if (started) return;
      started = true;
      $('steamCard').hidden = false;
      bind();
      load();
    },
    // Der Live-Stream meldet nur, dass sich etwas geändert hat; die Matrix ist nicht öffentlich.
    onRev(next) {
      if (!started || next === rev) return;
      const first = rev === null;
      rev = next;
      if (!first) load();
    },
  };
})();
