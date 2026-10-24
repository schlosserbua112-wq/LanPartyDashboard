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
  players: (p) => `<span class="grow"><strong>${esc(p.name)}</strong> ${p.seat ? `<small>Platz ${esc(p.seat)}</small>` : ''}</span>
    <button class="icon" data-action="points" data-id="${esc(p.id)}" data-delta="-1">−</button>
    <span class="points">${p.points}</span>
    <button class="icon" data-action="points" data-id="${esc(p.id)}" data-delta="1">+</button>
    <button class="icon" data-action="points" data-id="${esc(p.id)}" data-delta="5">+5</button>
    ${del('players', p.id)}`,
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
  const { action, collection, id, delta } = btn.dataset;
  if (action === 'delete' && confirm('Wirklich löschen?')) api('DELETE', `${collection}/${id}`);
  if (action === 'points') {
    const player = state.players.find((p) => p.id === id);
    if (player) api('PATCH', `players/${id}`, { points: player.points + Number(delta) });
  }
});

// --- Ansichten -------------------------------------------------------------

$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b === btn);
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== 'view-' + btn.dataset.view;
  if (btn.dataset.view === 'users') loadUsers();
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

// Beim Laden: gespeichertes Passwort oder Admin-Nutzer-Cookie prüfen.
fetch('/api/admin/login', { method: 'POST', headers: authHeaders() })
  .then((r) => {
    if (r.ok) showAdmin();
    else if (password) logout();
  });
