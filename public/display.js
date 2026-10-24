'use strict';

// TV-/Beamer-Ansicht: zeigt den Zustand an, ohne selbst etwas zu ändern.

const $ = (id) => document.getElementById(id);
let current = null;

function renderClock() {
  $('clock').textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function renderSchedule(items) {
  const now = Date.now();
  // Der letzte Eintrag, der schon begonnen hat, läuft gerade.
  let running = -1;
  items.forEach((item, i) => {
    const t = parseTime(item.time);
    if (t && t.getTime() <= now) running = i;
  });
  $('schedule').innerHTML = items.length
    ? items.map((item, i) => {
        const cls = i === running ? 'now' : i < running ? 'past' : i === running + 1 ? 'next' : '';
        const badge = i === running ? '<span class="badge">läuft</span>' : i === running + 1 ? '<span class="badge alt">als Nächstes</span>' : '';
        return `<li class="${cls}"><time>${formatTime(item.time)}</time><div><strong>${esc(item.title)}</strong>${badge}${item.note ? `<p>${esc(item.note)}</p>` : ''}</div></li>`;
      }).join('')
    : '<li class="empty">Noch kein Zeitplan</li>';
}

function render(state) {
  current = state;
  const s = state.settings;
  document.title = s.eventName || 'LAN-Party';
  $('eventName').textContent = s.eventName || 'LAN-Party';
  $('wifi').innerHTML = s.wifiSsid
    ? `WLAN <strong>${esc(s.wifiSsid)}</strong>${s.wifiPassword ? ` · Passwort <strong>${esc(s.wifiPassword)}</strong>` : ''}`
    : '';
  $('ticker').textContent = s.ticker || '';

  renderSchedule(state.schedule);

  $('announcements').innerHTML = state.announcements.length
    ? state.announcements.slice(0, 6).map((a, i) => `<li class="${i === 0 ? 'latest' : ''}"><time>${new Date(a.createdAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</time>${esc(a.text)}</li>`).join('')
    : '<li class="empty">Keine Ankündigungen</li>';

  const ranked = [...state.players].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  $('leaderboard').innerHTML = ranked.length
    ? ranked.slice(0, 12).map((p, i) => `<li><span class="rank">${i + 1}</span><span class="name">${esc(p.name)}${p.seat ? ` <small>Platz ${esc(p.seat)}</small>` : ''}</span><span class="points">${p.points}</span></li>`).join('')
    : '<li class="empty">Noch keine Spieler</li>';

  const maxVotes = Math.max(1, ...state.games.map((g) => g.votes));
  const games = [...state.games].sort((a, b) => b.votes - a.votes);
  $('voteHint').textContent = `abstimmen auf ${location.host}/vote`;
  $('votes').innerHTML = games.length
    ? games.map((g) => `<li><span class="name">${esc(g.name)}</span><span class="bar"><span style="width:${(g.votes / maxVotes) * 100}%"></span></span><span class="count">${g.votes}</span></li>`).join('')
    : '<li class="empty">Keine Spiele zur Wahl</li>';

  $('servers').innerHTML = state.servers.length
    ? state.servers.map((srv) => {
        const st = srv.status;
        const cls = !st ? 'unknown' : st.online ? 'online' : 'offline';
        const info = !st ? 'prüfe…' : st.online ? `${st.latency} ms` : 'offline';
        return `<li class="${cls}"><span class="dot"></span><span class="name">${esc(srv.name)}</span><span class="addr">${esc(srv.host)}:${srv.port}</span><span class="info">${info}</span></li>`;
      }).join('')
    : '<li class="empty">Keine Server eingetragen</li>';
}

renderClock();
setInterval(renderClock, 1000);
// "läuft"/"als Nächstes" auch ohne neue Daten weiterschalten.
setInterval(() => current && renderSchedule(current.schedule), 30000);

subscribe(render, (ok) => {
  $('conn').textContent = ok ? '' : 'Verbindung unterbrochen…';
});
