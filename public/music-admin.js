'use strict';

// Admin-Reiter „Musik“: Spotify verbinden, Wiedergabe steuern, Regeln festlegen.
// Nutzt $, authHeaders und esc aus admin.js bzw. common.js.

let musicConfig = null;
let musicConfigRequested = false;

async function musicAdminApi(method, url, body, errorEl = 'spotifyError') {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  $(errorEl).textContent = res.ok ? '' : data.error || 'Fehler';
  return res.ok ? data : null;
}

function renderMusicConfig() {
  const c = musicConfig;
  if (!c) return;
  $('redirectUri').textContent = c.redirectUri;
  const form = $('spotifyConfig');
  if (!form.contains(document.activeElement)) {
    form.elements.clientId.value = c.clientId;
    form.elements.clientId.disabled = c.clientIdFromEnv;
    form.elements.redirectUri.value = c.redirectUri.includes('/api/spotify/callback') && c.redirectUri.startsWith('http://127.0.0.1') ? '' : c.redirectUri;
  }
  $('spotifyStatus').innerHTML = c.connected
    ? `<span class="dot online"></span> Verbunden${c.account ? ` als <strong>${esc(c.account)}</strong>` : ''}`
    : `<span class="dot offline"></span> ${c.clientId ? 'Noch nicht verbunden' : 'Noch nicht eingerichtet'}`;
  $('spotifySetup').hidden = c.connected;
  $('spotifyConnect').hidden = c.connected;
  $('spotifyConnect').disabled = !c.clientId;
  $('spotifyDisconnect').hidden = !c.connected;
  if (c.connected) $('spotifyCode').hidden = true;
  else $('devices').innerHTML = '<li class="empty">Erst Spotify verbinden.</li>';
  const rules = $('musicRules');
  if (!rules.contains(document.activeElement)) {
    rules.elements.skipVotes.value = c.skipVotes;
    rules.elements.maxWishes.value = c.maxWishes;
    rules.elements.usersCanControl.checked = c.usersCanControl;
  }
}

async function loadMusicConfig() {
  const data = await musicAdminApi('GET', '/api/admin/music');
  if (data) {
    musicConfig = data;
    renderMusicConfig();
  }
}

// Wird von admin.js bei jedem neuen Zustand aufgerufen.
function renderMusicAdmin(m) {
  if (!m) return;
  if (!musicConfigRequested || (musicConfig && musicConfig.connected !== m.connected)) {
    musicConfigRequested = true;
    loadMusicConfig().then(() => musicConfig?.connected && loadDevices());
  }
  const t = m.track;
  $('adminNow').innerHTML = !m.connected
    ? '<p class="empty">Spotify ist nicht verbunden.</p>'
    : t
      ? `<ul class="queue"><li>${t.image ? `<img src="${esc(t.image)}" alt="">` : '<span class="ph">♪</span>'}<span class="grow"><strong>${esc(t.name)}</strong><small>${esc(t.artists)}${t.by ? ` · gewünscht von ${esc(t.by)}` : ''}</small></span><span class="badge ${m.playing ? '' : 'alt'}">${m.playing ? 'läuft' : 'pausiert'}</span></li></ul>
         <p class="muted">Gerät: ${m.device ? esc(m.device.name) : 'keins'} · ${m.queue.length} in der Warteschlange · Überspringen ${m.skip.votes}/${m.skip.needed}</p>`
      : '<p class="empty">Gerade läuft nichts.</p>';
  if (m.error) $('adminNow').insertAdjacentHTML('beforeend', `<p class="error">${esc(m.error)}</p>`);
  if (m.device && document.activeElement !== $('adminVolume')) $('adminVolume').value = m.device.volume ?? 50;
}

async function loadDevices() {
  const data = await musicAdminApi('GET', '/api/admin/music/devices', undefined, 'musicControlError');
  if (!data) return;
  $('devices').innerHTML = data.devices.length
    ? data.devices.map((d) => `<li><span class="grow"><strong>${esc(d.name)}</strong> <small>${esc(d.type)}</small></span>${d.active ? '<span class="badge">aktiv</span>' : `<button type="button" class="icon" data-device="${esc(d.id)}">Hier abspielen</button>`}</li>`).join('')
    : '<li class="empty">Kein Gerät gefunden. Starte Spotify auf dem Musik-PC.</li>';
}

$('spotifyConfig').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = { redirectUri: f.redirectUri.value };
  if (!f.clientId.disabled) body.clientId = f.clientId.value;
  const data = await musicAdminApi('PUT', '/api/admin/music', body);
  if (data) {
    musicConfig = data;
    document.activeElement.blur();
    renderMusicConfig();
  }
});

$('copyRedirect').addEventListener('click', async (e) => {
  try { await navigator.clipboard.writeText($('redirectUri').textContent); } catch {}
  e.target.textContent = 'Kopiert ✓';
  setTimeout(() => { e.target.textContent = 'Kopieren'; }, 1500);
});

$('spotifyConnect').addEventListener('click', async () => {
  // Fenster sofort öffnen, sonst blockiert der Popup-Blocker nach dem await.
  const win = window.open('about:blank', '_blank');
  const data = await musicAdminApi('POST', '/api/admin/music/connect');
  if (!data) {
    if (win) win.close();
    return;
  }
  if (win) win.location = data.url;
  else location.href = data.url;
  $('spotifyCode').hidden = false;
});

$('spotifyCode').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = await musicAdminApi('POST', '/api/admin/music/code', { url: e.target.elements.url.value });
  if (data) {
    musicConfig = data;
    e.target.reset();
    renderMusicConfig();
    loadDevices();
  }
});

$('spotifyDisconnect').addEventListener('click', async () => {
  if (!confirm('Verbindung zu Spotify trennen?')) return;
  const data = await musicAdminApi('POST', '/api/admin/music/disconnect');
  if (data) {
    musicConfig = data;
    renderMusicConfig();
  }
});

$('musicRules').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const data = await musicAdminApi('PUT', '/api/admin/music', {
    skipVotes: Number(f.skipVotes.value),
    maxWishes: Number(f.maxWishes.value),
    usersCanControl: f.usersCanControl.checked,
  });
  if (data) {
    musicConfig = data;
    document.activeElement.blur();
    renderMusicConfig();
  }
});

$('view-musik').addEventListener('click', (e) => {
  const control = e.target.closest('button[data-music]');
  if (control) musicAdminApi('POST', '/api/music/control', { action: control.dataset.music }, 'musicControlError');
  const device = e.target.closest('button[data-device]');
  if (device) musicAdminApi('PUT', '/api/admin/music/device', { id: device.dataset.device }, 'musicControlError').then(() => setTimeout(loadDevices, 1000));
});

$('adminVolume').addEventListener('change', (e) => {
  musicAdminApi('POST', '/api/music/control', { action: 'volume', value: Number(e.target.value) }, 'musicControlError');
});

$('loadDevices').addEventListener('click', loadDevices);

// Nach der Rückkehr von Spotify (#musik) direkt den Reiter öffnen.
if (location.hash === '#musik') {
  document.querySelector('#tabs button[data-view="musik"]').click();
  history.replaceState(null, '', '/admin');
}
