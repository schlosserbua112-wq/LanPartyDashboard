'use strict';

const $ = (id) => document.getElementById(id);
let password = null;
try { password = sessionStorage.getItem('lanparty-admin'); } catch {}
let source = null;

// Ohne Passwort zählt das Cookie eines angemeldeten Admin-Nutzers.
function authHeaders() {
  return password ? { Authorization: 'Bearer ' + password } : {};
}

async function api(method, url, body) {
  const res = await fetch('/api/admin/' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    logout();
    throw new Error('Nicht angemeldet');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Fehler beim Speichern');
    throw new Error(err.error);
  }
  return res.json();
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// --- Darstellung -----------------------------------------------------------

const del = (collection, id) => `<button class="icon danger" data-action="delete" data-collection="${collection}" data-id="${esc(id)}" title="Löschen">✕</button>`;

const renderers = {
  schedule: (s) => `<span class="time">${formatTime(s.time)}</span><span class="grow"><strong>${esc(s.title)}</strong> ${esc(s.note)}</span>${del('schedule', s.id)}`,
  servers: (s) => {
    const st = s.status;
    const cls = !st ? 'unknown' : st.online ? 'online' : 'offline';
    return `<span class="dot ${cls}"></span><span class="grow"><strong>${esc(s.name)}</strong> <small>${esc(s.host)}:${s.port}</small></span>${del('servers', s.id)}`;
  },
};

let state = null;

function render(next) {
  state = next;
  for (const [collection, fn] of Object.entries(renderers)) {
    const items = state[collection];
    $('list-' + collection).innerHTML = items.length
      ? items.map((item) => `<li>${fn(item)}</li>`).join('')
      : '<li class="empty">Noch nichts eingetragen</li>';
  }
  renderWheelAdmin();
  renderPollsAdmin();
  renderLeaderboardAdmin();
  tournaments.update(state.tournaments);
  renderAchievementsAdmin();
  // Einstellungen nur befüllen, wenn gerade niemand darin tippt.
  const form = $('settingsForm');
  if (!form.contains(document.activeElement)) {
    for (const [key, value] of Object.entries(state.settings)) {
      if (form.elements[key]) form.elements[key].value = value;
    }
  }
}

// --- Anmeldung -------------------------------------------------------------

function showAdmin() {
  $('login').hidden = true;
  $('admin').hidden = false;
  if (!source) source = subscribe(render);
  loadUsers();
}

function logout() {
  // Über einen Nutzer-Link angemeldet: Cookie auf dem Server löschen lassen.
  if (!password) {
    location.href = '/logout';
    return;
  }
  password = null;
  try { sessionStorage.removeItem('lanparty-admin'); } catch {}
  if (source) source.close();
  source = null;
  $('admin').hidden = true;
  $('login').hidden = false;
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  password = e.target.elements.password.value;
  const res = await fetch('/api/admin/login', { method: 'POST', headers: { Authorization: 'Bearer ' + password } });
  if (!res.ok) {
    $('loginError').textContent = 'Falsches Passwort.';
    return;
  }
  try { sessionStorage.setItem('lanparty-admin', password); } catch {}
  $('loginError').textContent = '';
  e.target.reset();
  showAdmin();
});

$('logout').addEventListener('click', (e) => {
  e.preventDefault();
  logout();
});

// --- Aktionen --------------------------------------------------------------

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('PUT', 'settings', formData(e.target));
  document.activeElement.blur();
});

document.querySelectorAll('form[data-collection]').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('POST', form.dataset.collection, formData(form));
    form.reset();
    form.querySelector('input').focus();
  });
});

$('admin').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, collection, id } = btn.dataset;
  if (action === 'delete' && confirm('Wirklich löschen?')) api('DELETE', `${collection}/${id}`);
});

// --- Ansichten -------------------------------------------------------------

$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b === btn);
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== 'view-' + btn.dataset.view;
  if (btn.dataset.view === 'users' || btn.dataset.view === 'achievements') loadUsers();
  if (btn.dataset.view === 'leaderboard') {
    loadUsers();
    loadScoreHistory();
  }
  if (btn.dataset.view === 'tournaments') loadUsers();
  if (btn.dataset.view === 'wheel') {
    loadUsers();
    if (state) wheel.update(state.wheel);
  }
});

// --- Nutzerverwaltung ------------------------------------------------------

let features = [];
let users = [];

const inviteLink = (u) => `${location.origin}/login?token=${encodeURIComponent(u.token)}`;

function featureBoxes(selected, attrs = '') {
  return features.map((f) => `<label class="check"><input type="checkbox" data-feature="${esc(f.key)}" ${attrs} ${selected[f.key] ? 'checked' : ''}> ${esc(f.label)}</label>`).join('');
}

function renderUsers(users) {
  if (!$('newUserFeatures').querySelector('input')) {
    $('newUserFeatures').insertAdjacentHTML('beforeend', featureBoxes({}));
  }
  $('userList').innerHTML = users.length
    ? users.map((u) => `<li data-user="${esc(u.id)}">
        <div class="user-head">
          <strong>${esc(u.username)}</strong>
          ${u.isAdmin ? '<span class="badge">Admin</span>' : ''}
          <small>${u.lastLogin ? 'zuletzt angemeldet ' + new Date(u.lastLogin).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : 'noch nie angemeldet'}</small>
        </div>
        <div class="link-row">
          <input readonly value="${esc(inviteLink(u))}">
          <button type="button" data-user-action="copy">Link kopieren</button>
          <button type="button" class="secondary" data-user-action="regenerate">Neuer Link</button>
        </div>
        <div class="checks">
          <label class="check"><input type="checkbox" data-user-action="admin" ${u.isAdmin ? 'checked' : ''}> Admin</label>
          ${featureBoxes(u.features, 'data-user-action="feature"')}
          <button type="button" class="icon danger" data-user-action="delete" title="Nutzer löschen">✕ Löschen</button>
        </div>
      </li>`).join('')
    : '<li class="empty">Noch keine Nutzer angelegt</li>';
}

async function loadUsers() {
  const data = await api('GET', 'users');
  features = data.features;
  users = data.users;
  renderUsers(users);
  renderWheelAdmin();
  renderLeaderboardAdmin();
  renderTournamentUsers();
  renderTournamentActions(tournaments.selected());
  renderAchievementsAdmin();
}

$('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const selected = {};
  for (const box of form.querySelectorAll('[data-feature]')) selected[box.dataset.feature] = box.checked;
  await api('POST', 'users', { username: form.elements.username.value, isAdmin: form.elements.isAdmin.checked, features: selected });
  form.reset();
  loadUsers();
});

$('userList').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-user-action]');
  if (!el || el.tagName === 'INPUT') return;
  const li = el.closest('li[data-user]');
  const id = li.dataset.user;
  const name = li.querySelector('strong').textContent;
  const action = el.dataset.userAction;
  if (action === 'copy') {
    const input = li.querySelector('.link-row input');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    el.textContent = 'Kopiert ✓';
    setTimeout(() => { el.textContent = 'Link kopieren'; }, 1500);
    return;
  }
  if (action === 'regenerate' && confirm(`Neuen Link für ${name} erzeugen? Der alte Link funktioniert dann nicht mehr.`)) {
    await api('POST', `users/${id}/regenerate`);
    loadUsers();
  }
  if (action === 'delete' && confirm(`${name} wirklich löschen?`)) {
    await api('DELETE', `users/${id}`);
    loadUsers();
  }
});

$('userList').addEventListener('change', async (e) => {
  const box = e.target.closest('input[data-user-action]');
  if (!box) return;
  const id = box.closest('li[data-user]').dataset.user;
  const body = box.dataset.userAction === 'admin'
    ? { isAdmin: box.checked }
    : { features: { [box.dataset.feature]: box.checked } };
  await api('PATCH', `users/${id}`, body);
  loadUsers();
});

// --- Glücksrad ---------------------------------------------------------------

const wheel = createWheel($('wheel'), ({ spinning, spin, lastResult }) => {
  const el = $('wheelStatus');
  el.classList.toggle('result', Boolean(spin && !spinning));
  el.textContent = spinning ? `${spin.by} dreht…` : spin ? `🎉 ${spin.result}` : lastResult ? `Zuletzt: ${lastResult}` : '';
  $('spinBtn').disabled = spinning;
});

// Spieler-Aktionen am Rad laufen über dieselbe Schnittstelle wie bei Nutzern.
async function wheelApi(method, url, body) {
  const res = await fetch('/api/wheel/' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  $('wheelError').textContent = res.ok ? '' : data.error || 'Fehler';
  return res.ok;
}

function renderWheelAdmin() {
  if (!state) return;
  const w = state.wheel;
  $('wheelOpen').textContent = w.open ? 'Einträge offen' : 'Eingabe geschlossen';
  $('toggleOpen').textContent = w.open ? 'Eingabe stoppen' : 'Eingabe wieder öffnen';
  $('entryCount').textContent = `(${w.entries.length})`;
  $('wheelEntries').innerHTML = w.entries.length
    ? w.entries.map((e) => `<li><span class="grow">${esc(e.text)} <small>von ${esc(e.owner)}</small></span><button class="icon danger" data-entry="${esc(e.id)}" title="Entfernen">✕</button></li>`).join('')
    : '<li class="empty">Noch keine Einträge</li>';
  $('spinners').innerHTML = users.length
    ? users.map((u) => u.isAdmin
        ? `<label class="check"><input type="checkbox" checked disabled> ${esc(u.username)} <small>(Admin)</small></label>`
        : `<label class="check"><input type="checkbox" data-spinner="${esc(u.id)}" ${w.spinnerIds.includes(u.id) ? 'checked' : ''}> ${esc(u.username)}</label>`).join('')
    : '<span class="empty">Noch keine Nutzer angelegt</span>';
  if (!$('view-wheel').hidden) wheel.update(w);
}

$('toggleOpen').addEventListener('click', () => api('PUT', 'wheel', { open: !state.wheel.open }));

$('clearWheel').addEventListener('click', () => {
  if (confirm('Alle Einträge vom Rad entfernen?')) api('POST', 'wheel/clear');
});

$('spinBtn').addEventListener('click', () => wheelApi('POST', 'spin'));
onSpaceKey(() => !$('view-wheel').hidden && !$('spinBtn').disabled && $('spinBtn').click());

$('spinners').addEventListener('change', () => {
  const ids = [...$('spinners').querySelectorAll('input[data-spinner]:checked')].map((b) => b.dataset.spinner);
  api('PUT', 'wheel', { spinnerIds: ids });
});

$('wheelEntryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await wheelApi('POST', 'entries', { text: e.target.elements.text.value })) e.target.reset();
});

$('wheelEntries').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-entry]');
  if (btn) wheelApi('DELETE', 'entries/' + btn.dataset.entry);
});

// --- Abstimmungen ------------------------------------------------------------

function pollBars(poll) {
  const max = Math.max(1, ...poll.options.map((o) => o.votes));
  return poll.options.map((o) => `<li><span class="name">${esc(o.text)}</span><span class="bar"><span style="width:${(o.votes / max) * 100}%"></span></span><span class="count">${o.votes}</span></li>`).join('');
}

function renderPollsAdmin() {
  if (!state) return;
  $('pollList').innerHTML = state.polls.length
    ? state.polls.map((p) => `<li data-poll="${esc(p.id)}">
        <div class="poll-head">
          <strong>${esc(p.question)}</strong>
          <span class="badge ${p.open ? '' : 'alt'}">${p.open ? 'läuft' : 'beendet'}</span>
          <small>${p.total} ${p.total === 1 ? 'Stimme' : 'Stimmen'}</small>
        </div>
        <ul class="votes">${pollBars(p)}</ul>
        <div class="toggle-row">
          <button type="button" data-poll-action="toggle">${p.open ? 'Beenden' : 'Wieder öffnen'}</button>
          <button type="button" class="secondary" data-poll-action="reset">Stimmen zurücksetzen</button>
          <button type="button" class="icon danger" data-poll-action="delete">✕ Löschen</button>
        </div>
      </li>`).join('')
    : '<li class="empty">Noch keine Abstimmungen</li>';
}

$('pollForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const options = form.elements.options.value.split('\n').map((s) => s.trim()).filter(Boolean);
  const res = await fetch('/api/admin/polls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ question: form.elements.question.value, options }),
  });
  const data = await res.json().catch(() => ({}));
  $('pollError').textContent = res.ok ? '' : data.error || 'Fehler';
  if (res.ok) form.reset();
});

$('pollList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-poll-action]');
  if (!btn) return;
  const li = btn.closest('li[data-poll]');
  const id = li.dataset.poll;
  const poll = state.polls.find((p) => p.id === id);
  const action = btn.dataset.pollAction;
  if (action === 'toggle') api('PATCH', `polls/${id}`, { open: !poll.open });
  if (action === 'reset' && confirm(`Alle Stimmen für „${poll.question}“ zurücksetzen?`)) api('POST', `polls/${id}/reset`);
  if (action === 'delete' && confirm(`„${poll.question}“ löschen?`)) api('DELETE', `polls/${id}`);
});

// --- Leaderboard ---------------------------------------------------------------

const chosenPlayers = new Set();
const SOURCE_ICONS = { manual: '⭐', tournament: '🏆', achievement: '🏅', game: '🎮' };
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

function renderLeaderboardAdmin() {
  if (!state) return;
  const lb = state.leaderboard;
  for (const id of chosenPlayers) if (!state.players.some((p) => p.id === id)) chosenPlayers.delete(id);

  $('scorePlayers').innerHTML = state.players.length
    ? state.players.map((p) => `<button type="button" data-pick="${esc(p.id)}" class="${chosenPlayers.has(p.id) ? 'chosen' : ''}">${esc(p.name)}</button>`).join('')
    : '<span class="empty">Noch keine Spieler</span>';
  $('gameList').innerHTML = lb.games.map((g) => `<option value="${esc(g)}"></option>`).join('');

  const userOptions = (selected) => `<option value="">kein Nutzer</option>${users.map((u) => `<option value="${esc(u.id)}" ${u.id === selected ? 'selected' : ''}>${esc(u.username)}</option>`).join('')}`;
  $('list-players').innerHTML = state.players.length
    ? state.players.map((p) => `<li data-player="${esc(p.id)}">
        <span class="grow"><strong>${esc(p.name)}</strong> ${p.seat ? `<small>Platz ${esc(p.seat)}</small>` : ''}</span>
        <select data-player-action="link" title="Mit Nutzer verknüpfen">${userOptions(p.userId)}</select>
        <span class="lb-points-cell">${p.points}</span>
        <button class="icon danger" data-player-action="delete" title="Spieler löschen">✕</button>
      </li>`).join('')
    : '<li class="empty">Noch keine Spieler</li>';

  $('lbRanking').innerHTML = lb.rows.length
    ? lb.rows.map((r) => `<li><span class="time">${r.rank}.</span><span class="grow"><strong>${esc(r.name)}</strong> <small>${r.count} ${r.count === 1 ? 'Buchung' : 'Buchungen'}</small></span><span class="lb-points-cell">${r.points}</span></li>`).join('')
    : '<li class="empty">Noch keine Spieler</li>';

  if (!$('view-leaderboard').hidden) loadScoreHistory();
}

let historyTimer = null;
function loadScoreHistory() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(async () => {
    const scores = await api('GET', 'scores');
    $('scoreHistory').innerHTML = scores.length
      ? scores.map((s) => `<li>
          <span class="lb-points-cell ${s.points < 0 ? 'neg' : 'pos'}">${signed(s.points)}</span>
          <span class="grow">${SOURCE_ICONS[s.source] || '⭐'} <strong>${esc(s.name)}</strong> ${esc([s.reason, s.game].filter(Boolean).join(' · '))}
            <small>${new Date(s.at).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${s.by ? ` · ${esc(s.by)}` : ''}</small></span>
          <button class="icon danger" data-score="${esc(s.id)}" title="Rückgängig">✕</button>
        </li>`).join('')
      : '<li class="empty">Noch keine Punkte vergeben</li>';
  }, 150);
}

$('scorePlayers').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-pick]');
  if (!btn) return;
  const id = btn.dataset.pick;
  if (chosenPlayers.has(id)) chosenPlayers.delete(id);
  else chosenPlayers.add(id);
  btn.classList.toggle('chosen', chosenPlayers.has(id));
});

async function awardScore(points) {
  const form = $('scoreForm');
  const res = await fetch('/api/admin/scores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ playerIds: [...chosenPlayers], points, reason: form.elements.reason.value, game: form.elements.game.value }),
  });
  const data = await res.json().catch(() => ({}));
  $('scoreError').textContent = res.ok ? '' : data.error || 'Fehler';
  if (res.ok) form.elements.reason.value = '';
}

$('scoreForm').addEventListener('submit', (e) => {
  e.preventDefault();
  awardScore(Number(e.target.elements.points.value));
});

$('scoreQuick').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-points]');
  if (!btn) return;
  $('scoreForm').elements.points.value = btn.dataset.points;
  awardScore(Number(btn.dataset.points));
});

$('playerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('POST', 'players', formData(e.target));
  e.target.reset();
  e.target.elements.name.focus();
});

$('list-players').addEventListener('change', (e) => {
  const select = e.target.closest('select[data-player-action="link"]');
  if (select) api('PATCH', `players/${select.closest('li').dataset.player}`, { userId: select.value });
});

$('list-players').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-player-action="delete"]');
  if (!btn) return;
  const li = btn.closest('li');
  const name = li.querySelector('strong').textContent;
  if (confirm(`${name} samt allen Punkten löschen?`)) api('DELETE', `players/${li.dataset.player}`);
});

$('scoreHistory').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-score]');
  if (btn) api('DELETE', `scores/${btn.dataset.score}`);
});

$('resetScores').addEventListener('click', () => {
  if (confirm('Wirklich alle Punkte aller Spieler löschen? Die Spieler bleiben erhalten.')) api('POST', 'scores/reset');
});

// --- Turniere ----------------------------------------------------------------

const tournaments = createTournaments({
  el: $('tournamentAdmin'),
  mode: 'admin',
  headers: authHeaders,
  onSelect: (t) => renderTournamentActions(t),
});

function renderTournamentUsers() {
  const box = $('tournamentUsers');
  const checked = new Set([...box.querySelectorAll('input:checked')].map((b) => b.value));
  box.innerHTML = '<legend>Nutzer direkt eintragen</legend>' + (users.length
    ? users.map((u) => `<label class="check"><input type="checkbox" value="${esc(u.id)}" ${checked.has(u.id) ? 'checked' : ''}> ${esc(u.username)}</label>`).join('')
    : '<span class="empty">Noch keine Nutzer angelegt</span>');
}

function renderTournamentActions(t) {
  const box = $('tournamentActions');
  box.hidden = !t;
  if (!t) return;
  const free = users.filter((u) => !t.participants.some((p) => p.userId === u.id));
  const signup = t.status === 'anmeldung'
    ? `<form class="row" id="tParticipantForm">
        <input name="name" maxlength="40" placeholder="Teilnehmer oder Team hinzufügen">
        <select name="userId"><option value="">… oder Nutzer wählen</option>${free.map((u) => `<option value="${esc(u.id)}">${esc(u.username)}</option>`).join('')}</select>
        <button>Hinzufügen</button>
      </form>
      <div class="toggle-row">
        <button type="button" data-t-admin="start" class="spin-btn" style="width:auto">🎲 Auslosen &amp; starten</button>
        <label class="check"><input type="checkbox" data-t-admin="open" ${t.open ? 'checked' : ''}> Nutzer dürfen sich selbst anmelden</label>
      </div>`
    : `<p class="muted">Klick auf ein Spiel im Turnierbaum, um das Ergebnis einzutragen oder zu korrigieren.</p>`;
  box.innerHTML = `${signup}
    <div class="toggle-row">
      ${t.status !== 'anmeldung' ? '<button type="button" class="secondary" data-t-admin="reset">Zurück zur Anmeldung</button>' : ''}
      <button type="button" class="icon danger" data-t-admin="delete" style="margin-left:auto">✕ Turnier löschen</button>
    </div>`;
}

$('tournamentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {
    name: form.elements.name.value,
    game: form.elements.game.value,
    format: form.elements.format.value,
    open: form.elements.open.checked,
    userIds: [...$('tournamentUsers').querySelectorAll('input:checked')].map((b) => b.value),
    names: form.elements.names.value.split('\n').map((s) => s.trim()).filter(Boolean),
  };
  const res = await fetch('/api/admin/tournaments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  $('tournamentError').textContent = res.ok ? '' : data.error || 'Fehler';
  if (!res.ok) return;
  form.reset();
  renderTournamentUsers();
  // Das neue Turnier auswählen, sobald es über den Live-Stream da ist.
  setTimeout(() => tournaments.select(data.id), 300);
});

$('tournamentActions').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = tournaments.selected();
  const { name, userId } = e.target.elements;
  if (!name.value.trim() && !userId.value) return;
  await api('POST', `tournaments/${t.id}/participants`, userId.value ? { userId: userId.value } : { name: name.value });
  name.value = '';
});

$('tournamentActions').addEventListener('click', (e) => {
  const action = e.target.closest('button[data-t-admin]')?.dataset.tAdmin;
  const t = tournaments.selected();
  if (!action || !t) return;
  if (action === 'start') api('POST', `tournaments/${t.id}/start`);
  if (action === 'reset' && confirm(`„${t.name}“ zurück zur Anmeldung? Spielplan und Ergebnisse gehen verloren.`)) api('POST', `tournaments/${t.id}/reset`);
  if (action === 'delete' && confirm(`„${t.name}“ wirklich löschen?`)) api('DELETE', `tournaments/${t.id}`);
});

$('tournamentActions').addEventListener('change', (e) => {
  const box = e.target.closest('input[data-t-admin="open"]');
  if (box) api('PATCH', `tournaments/${tournaments.selected().id}`, { open: box.checked });
});

$('tournamentAdmin').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-t-remove]');
  if (btn) api('DELETE', `tournaments/${tournaments.selected().id}/participants/${btn.dataset.tRemove}`);
});

// --- Achievements ------------------------------------------------------------

function renderAchievementsAdmin() {
  if (!state) return;
  const a = state.achievements;
  // Auswahl nur neu aufbauen, wenn sich etwas geändert hat, sonst springt sie zurück.
  const userOptions = users.map((u) => `<option value="${esc(u.id)}">${esc(u.username)}</option>`).join('');
  if ($('awardUser').dataset.html !== userOptions) {
    const keep = $('awardUser').value;
    $('awardUser').innerHTML = userOptions || '<option value="">Noch keine Nutzer</option>';
    $('awardUser').dataset.html = userOptions;
    if (keep) $('awardUser').value = keep;
  }
  const manualFirst = [...a.defs].sort((x, y) => Number(y.manual) - Number(x.manual));
  const achOptions = manualFirst.map((d) => `<option value="${esc(d.id)}">${esc(d.icon)} ${esc(d.name)}${d.manual ? '' : ' (automatisch)'}</option>`).join('');
  if ($('awardAch').dataset.html !== achOptions) {
    const keep = $('awardAch').value;
    $('awardAch').innerHTML = achOptions;
    $('awardAch').dataset.html = achOptions;
    if (keep) $('awardAch').value = keep;
  }
  if (!$('customRarity').options.length) {
    $('customRarity').innerHTML = Object.entries(a.rarities).map(([key, r]) => `<option value="${key}">${esc(r.label)} (${r.points} Punkte)</option>`).join('');
  }

  $('achAdminRanking').innerHTML = a.ranking.length
    ? a.ranking.map((r, i) => `<li><span class="rank">${i + 1}</span><span class="name">${esc(r.username)} <small>${r.count} 🏅</small></span><span class="points">${r.points}</span></li>`).join('')
    : '<li class="empty">Noch niemand hat ein Achievement</li>';

  $('achAdminList').innerHTML = a.defs.map((d) => {
    const holders = a.unlocks.filter((u) => u.achId === d.id);
    return `<li style="--rarity:${RARITY_COLORS[d.rarity]}">
      <div class="ach-admin-head">
        <span class="ach-feed-icon">${esc(d.icon)}</span>
        <strong>${esc(d.name)}</strong>
        <small class="ach-rarity">${esc(a.rarities[d.rarity].label)} · ${d.points}</small>
        <small>${d.custom ? 'eigenes' : d.manual ? 'von Hand' : 'automatisch'}</small>
        ${d.custom ? `<button type="button" class="icon danger" data-ach-action="delete-def" data-id="${esc(d.id)}" title="Achievement löschen">✕</button>` : ''}
      </div>
      <p class="muted">${esc(d.description)}</p>
      ${holders.length ? `<div class="chips">${holders.map((h) => `<span class="chip">${esc(h.username)}<button type="button" data-ach-action="revoke" data-id="${esc(h.id)}" title="Wieder wegnehmen">✕</button></span>`).join('')}</div>` : ''}
    </li>`;
  }).join('');
}

$('awardForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/api/admin/achievements/award', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(formData(e.target)),
  });
  const data = await res.json().catch(() => ({}));
  $('awardError').textContent = res.ok ? '' : data.error || 'Fehler';
});

$('customAchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('POST', 'achievements/defs', formData(e.target));
  e.target.reset();
});

$('achAdminList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-ach-action]');
  if (!btn) return;
  const { achAction, id } = btn.dataset;
  if (achAction === 'revoke' && confirm('Achievement wieder wegnehmen?')) api('DELETE', `achievements/unlocks/${id}`);
  if (achAction === 'delete-def' && confirm('Eigenes Achievement löschen? Es verschwindet auch bei allen, die es haben.')) api('DELETE', `achievements/defs/${id}`);
});

// Beim Laden: gespeichertes Passwort oder Admin-Nutzer-Cookie prüfen.
fetch('/api/admin/login', { method: 'POST', headers: authHeaders() })
  .then((r) => {
    if (r.ok) showAdmin();
    else if (password) logout();
  });
