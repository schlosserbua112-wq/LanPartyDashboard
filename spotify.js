'use strict';

// Gemeinsame Musiksteuerung über die Spotify Web API.
//
// Der Admin verbindet einmal den Spotify-Account, auf dem die Party-Musik
// läuft (Authorization Code mit PKCE, es braucht nur die Client-ID). Der
// Server fragt danach regelmäßig ab, was gerade läuft, und schickt das an alle
// Anzeigen. Nutzer wünschen sich Songs (landen in der Spotify-Warteschlange)
// und stimmen fürs Überspringen ab. Zugangsdaten liegen in data/spotify.json,
// getrennt von state.json, damit sie nicht in jedem Backup landen.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ACCOUNTS_URL = process.env.SPOTIFY_ACCOUNTS_URL || 'https://accounts.spotify.com';
const API_URL = process.env.SPOTIFY_API_URL || 'https://api.spotify.com/v1';
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
const POLL_INTERVAL = (Number(process.env.SPOTIFY_POLL_INTERVAL) || 5) * 1000;
const QUEUE_EVERY = 3; // Warteschlange nur bei jeder dritten Abfrage (oder Songwechsel) holen
const WISH_GRACE = 20000; // so lange gilt ein Wunsch, auch wenn Spotify ihn noch nicht listet
const MAX_QUEUE_SHOWN = 10;

const DEFAULT_CONF = {
  clientId: '',
  redirectUri: '',
  refreshToken: '',
  accessToken: '',
  expiresAt: 0,
  account: '',
  skipVotes: 3,
  maxWishes: 3,
  usersCanControl: false,
};

const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

class SpotifyError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// fetch wirft ohne Netz nur "fetch failed"; das übersetzen wir.
async function request(url, options) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  } catch {
    throw new SpotifyError('Spotify ist nicht erreichbar. Hat der Pi Internet?', 504);
  }
}

function createSpotify({ dataDir, port, onChange }) {
  const file = path.join(dataDir, 'spotify.json');
  const conf = { ...DEFAULT_CONF };
  try {
    Object.assign(conf, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Konnte Spotify-Daten nicht laden:', err.message);
  }
  // Umgebungsvariablen haben Vorrang vor dem Admin-Formular.
  if (process.env.SPOTIFY_CLIENT_ID) conf.clientId = process.env.SPOTIFY_CLIENT_ID;
  if (process.env.SPOTIFY_REDIRECT_URI) conf.redirectUri = process.env.SPOTIFY_REDIRECT_URI;

  let pendingAuth = null; // { state, verifier, redirectUri, createdAt }
  let playback = null; // zuletzt gesehener Player-Zustand (bereinigt)
  let fetchedAt = 0;
  let queue = [];
  let wishes = []; // { uri, userId, by, name, at }
  let nowBy = null; // { uri, by }: wer den laufenden Song gewünscht hat
  let skip = { uri: null, voters: new Set() };
  let lastWish = null;
  let lastSkip = null;
  let error = '';
  let pollCount = 0;
  let backoffUntil = 0;
  let signature = '';
  let refreshing = null;

  const redirectUri = () => conf.redirectUri || `http://127.0.0.1:${port}/api/spotify/callback`;
  const connected = () => Boolean(conf.refreshToken);

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(conf, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function setError(message) {
    if (error === message) return;
    error = message;
    onChange();
  }

  // ------------------------------------------------------------- Anmeldung

  async function tokenRequest(params) {
    const res = await request(`${ACCOUNTS_URL}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: conf.clientId, ...params }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new SpotifyError(data.error_description || data.error || `Spotify-Anmeldung fehlgeschlagen (${res.status})`, res.status === 400 ? 400 : 502);
      err.code = data.error;
      throw err;
    }
    conf.accessToken = data.access_token;
    conf.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    // Spotify tauscht den Refresh-Token bei PKCE manchmal aus.
    if (data.refresh_token) conf.refreshToken = data.refresh_token;
    save();
  }

  async function accessToken() {
    if (!connected()) throw new SpotifyError('Spotify ist nicht verbunden', 409);
    if (conf.accessToken && conf.expiresAt - 60000 > Date.now()) return conf.accessToken;
    // Gleichzeitige Anfragen teilen sich eine Erneuerung.
    refreshing ||= tokenRequest({ grant_type: 'refresh_token', refresh_token: conf.refreshToken })
      .catch((err) => {
        if (err.code === 'invalid_grant' || err.code === 'invalid_client') {
          disconnect();
          setError('Die Verbindung zu Spotify ist abgelaufen. Bitte im Admin-Bereich neu verbinden.');
        }
        throw err;
      })
      .finally(() => { refreshing = null; });
    await refreshing;
    return conf.accessToken;
  }

  function startAuth() {
    if (!conf.clientId) throw new SpotifyError('Zuerst die Client-ID eintragen', 400);
    const verifier = crypto.randomBytes(64).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    pendingAuth = { state: crypto.randomBytes(16).toString('hex'), verifier, redirectUri: redirectUri(), createdAt: Date.now() };
    const params = new URLSearchParams({
      client_id: conf.clientId,
      response_type: 'code',
      redirect_uri: pendingAuth.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: SCOPES,
      state: pendingAuth.state,
    });
    return `${ACCOUNTS_URL}/authorize?${params}`;
  }

  // Nimmt die Rücksprung-Adresse von Spotify entgegen (direkt oder eingefügt).
  async function finishAuth(params) {
    if (params.get('error')) {
      throw new SpotifyError(params.get('error') === 'access_denied' ? 'Die Anmeldung bei Spotify wurde abgebrochen' : `Spotify meldet: ${params.get('error')}`, 400);
    }
    const code = params.get('code');
    if (!code) throw new SpotifyError('In der Adresse fehlt der Code von Spotify', 400);
    if (!pendingAuth || !params.get('state') || params.get('state') !== pendingAuth.state) {
      throw new SpotifyError('Die Adresse passt nicht zur letzten Anmeldung. Bitte nochmal auf „Mit Spotify verbinden“ klicken.', 400);
    }
    if (Date.now() - pendingAuth.createdAt > 10 * 60000) throw new SpotifyError('Die Anmeldung hat zu lange gedauert. Bitte nochmal verbinden.', 400);
    const { verifier, redirectUri: uri } = pendingAuth;
    pendingAuth = null;
    await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: uri, code_verifier: verifier });
    try {
      const me = await api('GET', '/me');
      conf.account = me.display_name || me.id || '';
    } catch {
      conf.account = '';
    }
    save();
    error = '';
    await poll(true);
    onChange();
  }

  function disconnect() {
    conf.refreshToken = '';
    conf.accessToken = '';
    conf.expiresAt = 0;
    conf.account = '';
    save();
    playback = null;
    queue = [];
    wishes = [];
    nowBy = null;
    skip = { uri: null, voters: new Set() };
    onChange();
  }

  // ---------------------------------------------------------------- Web API

  async function api(method, pathname, { query, body, retried } = {}) {
    if (Date.now() < backoffUntil) throw new SpotifyError('Spotify bremst gerade, gleich nochmal versuchen', 429);
    const url = `${API_URL}${pathname}${query ? '?' + new URLSearchParams(query) : ''}`;
    const res = await request(url, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) {
      conf.expiresAt = 0;
      return api(method, pathname, { query, body, retried: true });
    }
    if (res.status === 429) {
      backoffUntil = Date.now() + (Number(res.headers.get('retry-after')) || 5) * 1000;
      throw new SpotifyError('Spotify bremst gerade, gleich nochmal versuchen', 429);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) throw new SpotifyError(friendlyError(res.status, data), res.status === 404 || res.status === 403 ? 409 : 502);
    return data;
  }

  function friendlyError(status, data) {
    const reason = data?.error?.reason;
    const message = data?.error?.message || '';
    if (reason === 'NO_ACTIVE_DEVICE' || (status === 404 && /device/i.test(message))) {
      return 'Kein aktives Spotify-Gerät. Starte Spotify auf dem Musik-PC oder wähle im Admin-Bereich ein Gerät.';
    }
    if (reason === 'PREMIUM_REQUIRED') return 'Zum Steuern braucht der verbundene Spotify-Account Premium.';
    if (status === 403 && /user may not be registered|not registered/i.test(message)) {
      return 'Dieser Spotify-Account ist in der Spotify-App nicht als Nutzer eingetragen (Developer Dashboard → User Management).';
    }
    return message ? `Spotify: ${message}` : `Spotify antwortet mit Fehler ${status}`;
  }

  function imageOf(images, minSize = 0) {
    if (!Array.isArray(images) || !images.length) return '';
    const sorted = [...images].sort((a, b) => (a.width || 0) - (b.width || 0));
    return (sorted.find((i) => (i.width || 0) >= minSize) || sorted[sorted.length - 1]).url;
  }

  function trackView(item, minImage = 64) {
    if (!item) return null;
    // Podcasts: statt Künstlern die Sendung zeigen.
    const artists = item.artists ? item.artists.map((a) => a.name).join(', ') : item.show?.name || '';
    const images = item.album?.images || item.images || item.show?.images;
    return {
      uri: item.uri,
      name: item.name,
      artists,
      album: item.album?.name || '',
      image: imageOf(images, minImage),
      durationMs: item.duration_ms || 0,
      explicit: Boolean(item.explicit),
    };
  }

  // ------------------------------------------------------- Regelmäßige Abfrage

  async function poll(force = false) {
    if (!connected() || (!force && Date.now() < backoffUntil)) return;
    pollCount++;
    try {
      const data = await api('GET', '/me/player', { query: { additional_types: 'episode' } });
      const before = playback?.track?.uri;
      playback = data
        ? {
            playing: Boolean(data.is_playing),
            progressMs: data.progress_ms || 0,
            track: trackView(data.item, 300),
            device: data.device ? { id: data.device.id, name: data.device.name, type: data.device.type, volume: data.device.volume_percent } : null,
            shuffle: Boolean(data.shuffle_state),
            repeat: data.repeat_state || 'off',
          }
        : null;
      fetchedAt = Date.now();
      const uri = playback?.track?.uri || null;
      if (uri !== before || force || pollCount % QUEUE_EVERY === 0) await loadQueue();
      trackChanged(uri);
      if (error) error = '';
    } catch (err) {
      if (err.status !== 429) setError(err.message);
    }
    notifyIfChanged();
  }

  async function loadQueue() {
    const data = await api('GET', '/me/player/queue');
    queue = (data?.queue || []).map((item) => trackView(item)).filter(Boolean);
    const queued = new Set(queue.map((t) => t.uri));
    const now = Date.now();
    wishes = wishes.filter((w) => queued.has(w.uri) || now - w.at < WISH_GRACE);
  }

  function trackChanged(uri) {
    if (skip.uri !== uri) skip = { uri, voters: new Set() };
    if (!uri || nowBy?.uri === uri) return;
    // Läuft jetzt ein gewünschter Song, wandert der Name des Wünschenden mit.
    const index = wishes.findIndex((w) => w.uri === uri);
    nowBy = index === -1 ? null : { uri, by: wishes[index].by };
    if (index !== -1) wishes.splice(index, 1);
  }

  // Nur senden, wenn sich etwas Sichtbares geändert hat oder jemand gespult hat.
  let expected = null;
  function notifyIfChanged() {
    const view = publicView();
    const sig = JSON.stringify({ ...view, progressMs: 0, age: 0 });
    let jumped = false;
    if (playback && expected) {
      const predicted = expected.progressMs + (expected.playing ? fetchedAt - expected.at : 0);
      jumped = Math.abs(predicted - playback.progressMs) > 3000;
    }
    expected = playback ? { progressMs: playback.progressMs, playing: playback.playing, at: fetchedAt } : null;
    if (sig !== signature || jumped) {
      signature = sig;
      onChange();
    }
  }

  // ------------------------------------------------------------ Öffentlich

  function publicView() {
    const queueBy = new Map();
    for (const w of wishes) if (!queueBy.has(w.uri)) queueBy.set(w.uri, w.by);
    return {
      configured: Boolean(conf.clientId),
      connected: connected(),
      account: conf.account,
      error,
      playing: Boolean(playback?.playing),
      progressMs: playback?.progressMs || 0,
      age: playback ? Date.now() - fetchedAt : 0,
      track: playback?.track ? { ...playback.track, by: nowBy?.uri === playback.track.uri ? nowBy.by : null } : null,
      device: playback?.device ? { name: playback.device.name, type: playback.device.type, volume: playback.device.volume } : null,
      queue: queue.slice(0, MAX_QUEUE_SHOWN).map((t) => ({ ...t, by: queueBy.get(t.uri) || null })),
      skip: { votes: skip.voters.size, needed: conf.skipVotes, voterIds: [...skip.voters] },
      usersCanControl: conf.usersCanControl,
      maxWishes: conf.maxWishes,
      lastWish,
      lastSkip,
    };
  }

  // Für den Admin: Einstellungen ohne Token.
  function adminView() {
    return {
      clientId: conf.clientId,
      clientIdFromEnv: Boolean(process.env.SPOTIFY_CLIENT_ID),
      redirectUri: redirectUri(),
      connected: connected(),
      account: conf.account,
      skipVotes: conf.skipVotes,
      maxWishes: conf.maxWishes,
      usersCanControl: conf.usersCanControl,
    };
  }

  function updateConfig(body) {
    if ('clientId' in body && !process.env.SPOTIFY_CLIENT_ID) {
      const id = String(body.clientId || '').trim();
      if (id && !/^[0-9a-zA-Z]{16,64}$/.test(id)) throw new SpotifyError('Die Client-ID sieht nicht richtig aus (32 Zeichen aus Buchstaben und Ziffern)', 400);
      if (id !== conf.clientId && connected()) disconnect();
      conf.clientId = id;
    }
    if ('redirectUri' in body && !process.env.SPOTIFY_REDIRECT_URI) {
      const uri = String(body.redirectUri || '').trim();
      if (uri && !/^https?:\/\/\S+$/.test(uri)) throw new SpotifyError('Ungültige Redirect-URI', 400);
      conf.redirectUri = uri;
    }
    if ('skipVotes' in body) conf.skipVotes = clampInt(body.skipVotes, 1, 50, conf.skipVotes);
    if ('maxWishes' in body) conf.maxWishes = clampInt(body.maxWishes, 1, 50, conf.maxWishes);
    if ('usersCanControl' in body) conf.usersCanControl = Boolean(body.usersCanControl);
    save();
    notifyIfChanged();
    return adminView();
  }

  async function search(q) {
    const query = String(q || '').trim().slice(0, 100);
    if (!query) return [];
    const data = await api('GET', '/search', { query: { q: query, type: 'track', limit: '10' } });
    return (data?.tracks?.items || []).map((t) => trackView(t)).filter(Boolean);
  }

  async function wish(user, uri, name) {
    if (!/^spotify:(track|episode):[0-9A-Za-z]+$/.test(String(uri))) throw new SpotifyError('Unbekannter Song', 400);
    if (!user.isAdmin && wishes.filter((w) => w.userId === user.id).length >= conf.maxWishes) {
      throw new SpotifyError(`Du hast schon ${conf.maxWishes} Wünsche in der Warteschlange. Warte, bis einer davon läuft.`, 409);
    }
    if (playback?.track?.uri === uri) throw new SpotifyError('Der Song läuft gerade', 409);
    if (queue.some((t) => t.uri === uri) || wishes.some((w) => w.uri === uri)) {
      throw new SpotifyError('Der Song ist schon in der Warteschlange', 409);
    }
    await api('POST', '/me/player/queue', { query: { uri } });
    const title = String(name || '').slice(0, 200);
    wishes.push({ uri, userId: user.id, by: user.username, name: title, at: Date.now() });
    lastWish = { id: crypto.randomUUID(), by: user.username, name: title, at: Date.now() };
    try { await loadQueue(); } catch {}
    signature = '';
    notifyIfChanged();
  }

  async function voteSkip(user) {
    const uri = playback?.track?.uri;
    if (!uri) throw new SpotifyError('Gerade läuft nichts', 409);
    if (skip.uri !== uri) skip = { uri, voters: new Set() };
    // Nochmal klicken zieht die Stimme zurück.
    if (skip.voters.has(user.id)) skip.voters.delete(user.id);
    else skip.voters.add(user.id);
    if (skip.voters.size >= conf.skipVotes) {
      const name = playback.track.name;
      await api('POST', '/me/player/next');
      lastSkip = { id: crypto.randomUUID(), name, at: Date.now() };
      skip = { uri: null, voters: new Set() };
      setTimeout(() => poll(true), 700);
    }
    signature = '';
    notifyIfChanged();
  }

  async function control(action, value) {
    if (action === 'play') await api('PUT', '/me/player/play');
    else if (action === 'pause') await api('PUT', '/me/player/pause');
    else if (action === 'next') await api('POST', '/me/player/next');
    else if (action === 'previous') await api('POST', '/me/player/previous');
    else if (action === 'volume') await api('PUT', '/me/player/volume', { query: { volume_percent: String(clampInt(value, 0, 100, 50)) } });
    else throw new SpotifyError('Unbekannte Aktion', 400);
    // Spotify braucht einen Moment, bis der neue Zustand abrufbar ist.
    setTimeout(() => poll(true), 500);
  }

  async function devices() {
    const data = await api('GET', '/me/player/devices');
    return (data?.devices || []).map((d) => ({ id: d.id, name: d.name, type: d.type, active: d.is_active, volume: d.volume_percent }));
  }

  async function transfer(deviceId) {
    if (!deviceId) throw new SpotifyError('Kein Gerät gewählt', 400);
    await api('PUT', '/me/player', { body: { device_ids: [String(deviceId)], play: true } });
    setTimeout(() => poll(true), 800);
  }

  function forgetUser(userId) {
    wishes = wishes.filter((w) => w.userId !== userId);
    skip.voters.delete(userId);
  }

  const timer = setInterval(() => poll(), POLL_INTERVAL);
  timer.unref();
  if (connected()) poll(true);

  return {
    publicView, adminView, updateConfig, startAuth, finishAuth, disconnect,
    search, wish, voteSkip, control, devices, transfer, forgetUser,
  };
}

module.exports = { createSpotify, SpotifyError };
