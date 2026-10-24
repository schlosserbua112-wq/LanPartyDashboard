'use strict';

const $ = (id) => document.getElementById(id);
let password = null;
try { password = sessionStorage.getItem('lanparty-admin'); } catch {}
let source = null;

async function api(method, url, body) {
  const res = await fetch('/api/admin/' + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + password },
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
  announcements: (a) => `<span class="grow">${esc(a.text)}</span>${del('announcements', a.id)}`,
  schedule: (s) => `<span class="time">${formatTime(s.time)}</span><span class="grow"><strong>${esc(s.title)}</strong> ${esc(s.note)}</span>${del('schedule', s.id)}`,
  players: (p) => `<span class="grow"><strong>${esc(p.name)}</strong> ${p.seat ? `<small>Platz ${esc(p.seat)}</small>` : ''}</span>
    <button class="icon" data-action="points" data-id="${esc(p.id)}" data-delta="-1">−</button>
    <span class="points">${p.points}</span>
    <button class="icon" data-action="points" data-id="${esc(p.id)}" data-delta="1">+</button>
    <button class="icon" data-action="points" data-id="${esc(p.id)}" data-delta="5">+5</button>
    ${del('players', p.id)}`,
  games: (g) => `<span class="grow">${esc(g.name)}</span><span class="points">${g.votes} Stimmen</span>${del('games', g.id)}`,
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
}

function logout() {
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

$('resetVotes').addEventListener('click', () => {
  if (confirm('Alle Stimmen zurücksetzen?')) api('POST', 'votes/reset');
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

if (password) {
  fetch('/api/admin/login', { method: 'POST', headers: { Authorization: 'Bearer ' + password } })
    .then((r) => (r.ok ? showAdmin() : logout()));
}
