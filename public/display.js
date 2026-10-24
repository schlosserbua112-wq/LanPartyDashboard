'use strict';

// Dashboard. Ohne Anmeldung ist es die TV-/Beamer-Anzeige. Wer per Link
// (oder mit dem Admin-Passwort) angemeldet ist, bedient hier seine Features.

const $ = (id) => document.getElementById(id);
let current = null;
let me = null;

// Mit dem Admin-Passwort angemeldet (aus dem Admin-Modus): mitschicken.
let password = null;
try { password = sessionStorage.getItem('lanparty-admin'); } catch {}
const auth = password ? { Authorization: 'Bearer ' + password } : {};

const wheel = createWheel($('wheel'), renderWheelStatus);

function renderWheelStatus({ spinning, spin, lastResult }) {
  const el = $('wheelStatus');
  el.classList.toggle('result', Boolean(spin && !spinning));
  if (spinning) el.textContent = `${spin.by} dreht…`;
  else if (spin) el.textContent = `🎉 ${spin.result}`;
  else if (lastResult) el.textContent = `Zuletzt: ${lastResult}`;
  else el.textContent = '';
  $('spinBtn').disabled = spinning;
}

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

  $('wheelOpen').textContent = state.wheel.open ? 'Einträge offen' : 'Eingabe geschlossen';
  if (me) renderWheelSide(state.wheel);
  wheel.update(state.wheel);

  const ranked = [...state.players].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  $('leaderboard').innerHTML = ranked.length
    ? ranked.slice(0, 12).map((p, i) => `<li><span class="rank">${i + 1}</span><span class="name">${esc(p.name)}${p.seat ? ` <small>Platz ${esc(p.seat)}</small>` : ''}</span><span class="points">${p.points}</span></li>`).join('')
    : '<li class="empty">Noch keine Spieler</li>';

  renderPolls(state.polls);
  if (me && hasFeature('abstimmungen')) loadMyVotes();

  teamReveal.update(state.teams.result);
  if (me && hasFeature('teams')) renderTeams(state.teams);

  $('servers').innerHTML = state.servers.length
    ? state.servers.map((srv) => {
        const st = srv.status;
        const cls = !st ? 'unknown' : st.online ? 'online' : 'offline';
        const info = !st ? 'prüfe…' : st.online ? `${st.latency} ms` : 'offline';
        return `<li class="${cls}"><span class="dot"></span><span class="name">${esc(srv.name)}</span><span class="addr">${esc(srv.host)}:${srv.port}</span><span class="info">${info}</span></li>`;
      }).join('')
    : '<li class="empty">Keine Server eingetragen</li>';
}

// --- Abstimmungen ------------------------------------------------------------

let myVotes = {};

// Laufende Abstimmungen zuerst, dazu die zuletzt beendete als Ergebnis.
function visiblePolls(polls) {
  const open = polls.filter((p) => p.open);
  const lastClosed = polls.find((p) => !p.open);
  return lastClosed ? [...open, lastClosed] : open;
}

function renderPolls(polls) {
  const canVote = me && hasFeature('abstimmungen');
  const shown = visiblePolls(polls);
  $('polls').innerHTML = shown.length
    ? shown.map((p) => {
        const max = Math.max(1, ...p.options.map((o) => o.votes));
        const voting = canVote && p.open;
        const options = p.options.map((o) => {
          const chosen = myVotes[p.id] === o.id;
          const inner = `<span class="name">${chosen ? '✓ ' : ''}${esc(o.text)}</span><span class="bar"><span style="width:${(o.votes / max) * 100}%"></span></span><span class="count">${o.votes}</span>`;
          return voting
            ? `<li><button class="vote-option ${chosen ? 'chosen' : ''}" data-poll="${esc(p.id)}" data-option="${esc(o.id)}" title="${chosen ? 'Stimme zurückziehen' : 'Dafür stimmen'}">${inner}</button></li>`
            : `<li>${inner}</li>`;
        }).join('');
        return `<div class="poll ${p.open ? '' : 'closed'}">
          <h3>${esc(p.question)} <small>${p.open ? `${p.total} ${p.total === 1 ? 'Stimme' : 'Stimmen'}` : 'Ergebnis'}</small></h3>
          <ul class="votes">${options}</ul>
        </div>`;
      }).join('')
    : '<p class="empty">Gerade läuft keine Abstimmung</p>';
}

async function loadMyVotes() {
  const res = await fetch('/api/polls/mine', { headers: auth });
  if (!res.ok) return;
  myVotes = await res.json();
  if (current) renderPolls(current.polls);
}

$('polls').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-option]');
  if (!btn) return;
  const { poll, option } = btn.dataset;
  // Nochmal auf die eigene Antwort klicken zieht die Stimme zurück.
  const optionId = myVotes[poll] === option ? null : option;
  const res = await fetch(`/api/polls/${poll}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ optionId }),
  });
  if (res.ok) loadMyVotes();
});

// --- Team-Generator ----------------------------------------------------------

// Auf dem Fernseher bleibt das Ergebnis länger stehen.
const teamReveal = createTeamReveal({ hold: () => (me ? 9000 : 30000) });
teamSoundButton($('teamSound'));
$('teamForm').elements.teamCount.innerHTML = [2, 3, 4, 5, 6, 7, 8].map((n) => `<option>${n}</option>`).join('');

function renderTeams(t) {
  const inPool = t.pool.some((p) => p.userId === me.id);
  const canGenerate = me.isAdmin || t.usersCanGenerate;
  $('teamPoolCount').textContent = `(${t.pool.length} dabei)`;
  $('teamJoin').hidden = me.master;
  $('teamJoin').textContent = inPool ? 'Ich bin raus' : 'Ich bin dabei!';
  $('teamJoin').className = inPool ? 'secondary' : '';
  $('teamPool').innerHTML = t.pool.length
    ? t.pool.map((p) => `<li class="${p.userId === me.id ? 'me' : ''}">${esc(p.name)}</li>`).join('')
    : '<li class="empty">Noch niemand dabei</li>';
  const form = $('teamForm');
  form.hidden = !canGenerate;
  $('teamLocked').hidden = canGenerate;
  // Nicht überschreiben, während jemand die Auswahl ändert.
  if (!form.contains(document.activeElement)) {
    form.elements.teamCount.value = String(t.teamCount);
    form.elements.balanced.checked = t.balanced;
  }
  $('teamGenerate').disabled = t.pool.length < 2 || teamReveal.isRunning();
  const r = t.result;
  $('teamResult').innerHTML = !r
    ? '<p class="empty">Noch keine Teams ausgelost</p>'
    : r.age < r.duration
      ? '<p class="empty">Die Teams werden gerade ausgelost…</p>'
      : teamColumnsHtml(r);
  // Nach der Show das fertige Ergebnis zeigen.
  clearTimeout(renderTeams.timer);
  if (r && r.age < r.duration) renderTeams.timer = setTimeout(() => current && renderTeams(current.teams), r.duration - r.age + 50);
}

async function teamsApi(url, body) {
  const res = await fetch('/api/teams/' + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  $('teamError').textContent = res.ok ? '' : data.error || 'Fehler';
}

$('teamJoin').addEventListener('click', () => {
  const inPool = current.teams.pool.some((p) => p.userId === me.id);
  teamsApi(inPool ? 'leave' : 'join');
});

$('teamForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.elements;
  teamsApi('generate', { teamCount: Number(f.teamCount.value), balanced: f.balanced.checked });
});

// --- Angemeldete Nutzer ------------------------------------------------------

const hasFeature = (key) => me.isAdmin || me.features.some((f) => f.key === key && f.enabled);

function renderWheelSide(w) {
  const canSpin = me.isAdmin || w.spinnerIds.includes(me.id);
  const canAdd = hasFeature('gluecksrad') && (w.open || me.isAdmin);
  $('spinBtn').hidden = !canSpin;
  $('entryForm').hidden = !canAdd;
  $('closedHint').hidden = canAdd || !hasFeature('gluecksrad');
  $('entryCount').textContent = `(${w.entries.length})`;
  $('entries').innerHTML = w.entries.length
    ? w.entries.map((e) => {
        const canDelete = me.isAdmin || (hasFeature('gluecksrad') && e.ownerId === me.id && w.open);
        return `<li><span class="grow">${esc(e.text)} <small>von ${esc(e.owner)}</small></span>${canDelete ? `<button class="icon danger" data-entry="${esc(e.id)}" title="Entfernen">✕</button>` : ''}</li>`;
      }).join('')
    : '<li class="empty">Noch keine Einträge</li>';
}

function enterUserMode(user) {
  me = user;
  document.body.classList.add('user-mode');
  $('userBar').hidden = false;
  $('username').textContent = me.username;
  $('modeSwitch').hidden = !me.isAdmin;
  $('wheelSide').hidden = false;
  $('teamsCard').hidden = !hasFeature('teams');
  if (me.master) {
    // Abmelden vom Admin-Passwort: zurück in die Admin-Anmeldung.
    $('logout').addEventListener('click', (e) => {
      e.preventDefault();
      try { sessionStorage.removeItem('lanparty-admin'); } catch {}
      location.href = '/admin';
    });
  }
  // Das Glücksrad ist schon im Dashboard; die übrigen Features sind Platzhalter.
  const others = me.features.filter((f) => f.enabled && !['gluecksrad', 'abstimmungen', 'teams'].includes(f.key));
  $('featuresCard').hidden = !others.length;
  document.body.classList.toggle('no-features', !others.length);
  $('features').innerHTML = others.map((f) => `<li><strong>${esc(f.label)}</strong><small>kommt bald</small></li>`).join('');
  if (current) render(current);
}

async function wheelApi(method, url, body) {
  const res = await fetch('/api/wheel/' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...auth },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  $('wheelError').textContent = res.ok ? '' : data.error || 'Fehler';
  return res.ok;
}

$('entryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await wheelApi('POST', 'entries', { text: e.target.elements.text.value })) e.target.reset();
});

$('entries').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-entry]');
  if (btn) wheelApi('DELETE', 'entries/' + btn.dataset.entry);
});

$('spinBtn').addEventListener('click', () => wheelApi('POST', 'spin'));
onSpaceKey(() => me && !$('spinBtn').hidden && !$('spinBtn').disabled && $('spinBtn').click());

if (new URLSearchParams(location.search).has('ungueltig')) {
  $('toast').textContent = 'Dieser Link ist ungültig oder wurde ersetzt. Frag den Admin nach einem neuen.';
  $('toast').hidden = false;
  setTimeout(() => { $('toast').hidden = true; }, 8000);
  history.replaceState(null, '', '/');
}

fetch('/api/me', { headers: auth }).then(async (res) => {
  if (res.ok) enterUserMode(await res.json());
});

renderClock();
setInterval(renderClock, 1000);
// "läuft"/"als Nächstes" auch ohne neue Daten weiterschalten.
setInterval(() => current && renderSchedule(current.schedule), 30000);

subscribe(render, (ok) => {
  $('conn').textContent = ok ? '' : 'Verbindung unterbrochen…';
});
