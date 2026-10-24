'use strict';

// LAN-Party-Dashboard: kleiner HTTP-Server ohne externe Abhängigkeiten.
// Läuft mit Node.js >= 18 und braucht auf einem Raspberry Pi nur ca. 40 MB RAM.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'lanparty';
const SERVER_CHECK_INTERVAL = (Number(process.env.SERVER_CHECK_INTERVAL) || 30) * 1000;
const MAX_BODY = 64 * 1024;
const STEAM_API_KEY = process.env.STEAM_API_KEY || '';
const STEAM_API_BASE = process.env.STEAM_API_BASE || 'https://api.steampowered.com';
const STEAM_REFRESH = (Number(process.env.STEAM_REFRESH_MINUTES) || 60) * 60 * 1000;

if (!process.env.ADMIN_PASSWORD) {
  console.warn('WARNUNG: ADMIN_PASSWORD ist nicht gesetzt, Standardpasswort "lanparty" wird verwendet.');
}

// ---------------------------------------------------------------------------
// Datenhaltung (eine JSON-Datei, gebündelt geschrieben, um die SD-Karte zu schonen)

const DEFAULT_STATE = {
  settings: {
    eventName: 'LAN-Party',
    wifiSsid: '',
    wifiPassword: '',
    ticker: 'Willkommen! Bitte haltet die Kabelwege frei.',
  },
  schedule: [],
  players: [],
  polls: [],
  servers: [],
  users: [],
  wheel: { open: true, entries: [], spinnerIds: [], spin: null },
  // apiKey ist geheim und landet nie im öffentlichen Zustand.
  steam: { apiKey: '', profiles: {}, games: {} },
};

// Features, die der Admin pro Nutzer freischalten kann. Noch Platzhalter.
const FEATURES = [
  { key: 'gluecksrad', label: 'Glücksrad' },
  { key: 'abstimmungen', label: 'Abstimmungen' },
  { key: 'essen', label: 'Essensbestellung' },
  { key: 'wishlist', label: 'Wishlist' },
  { key: 'spiele', label: 'Spiele-Matrix' },
];
const FEATURE_KEYS = new Set(FEATURES.map((f) => f.key));
const SESSION_COOKIE = 'lp_session';

// Erlaubte Felder je Sammlung und wie sie bereinigt werden.
const COLLECTIONS = {
  schedule: { time: str(32), title: str(120), note: str(200) },
  players: { name: str(60), seat: str(20), points: num },
  servers: { name: str(60), host: str(255), port: num },
};

const SETTINGS_FIELDS = {
  eventName: str(80),
  wifiSsid: str(64),
  wifiPassword: str(64),
  ticker: str(300),
};

function str(max) {
  return (v) => String(v ?? '').trim().slice(0, max);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const state = structuredClone(DEFAULT_STATE);
    Object.assign(state.settings, raw.settings || {});
    for (const key of Object.keys(COLLECTIONS)) {
      if (Array.isArray(raw[key])) state[key] = raw[key];
    }
    if (Array.isArray(raw.polls)) {
      state.polls = raw.polls;
    } else if (Array.isArray(raw.games) && raw.games.length) {
      // Frühere Spiele-Abstimmung als erste Umfrage übernehmen (ohne die anonymen Stimmen).
      state.polls = [newPoll('Was spielen wir als Nächstes?', raw.games.map((g) => g.name))];
    }
    if (Array.isArray(raw.users)) state.users = raw.users;
    if (raw.wheel && typeof raw.wheel === 'object') Object.assign(state.wheel, raw.wheel);
    if (raw.steam && typeof raw.steam === 'object') Object.assign(state.steam, raw.steam);
    return state;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Konnte Daten nicht laden, starte leer:', err.message);
    return structuredClone(DEFAULT_STATE);
  }
}

let state = loadState();
let saveTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 1000);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------------------------------------------------------------------------
// Erreichbarkeit der Spieleserver (TCP-Verbindungstest)

const serverStatus = {};

function checkServer(srv) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host: srv.host, port: srv.port });
    const done = (online) => {
      socket.destroy();
      resolve({ online, latency: online ? Date.now() - started : null, checkedAt: Date.now() });
    };
    socket.setTimeout(2000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function checkAllServers() {
  const results = await Promise.all(
    state.servers.filter((s) => s.host && s.port).map(async (s) => [s.id, await checkServer(s)])
  );
  let changed = false;
  for (const [id, result] of results) {
    if (serverStatus[id]?.online !== result.online) changed = true;
    serverStatus[id] = result;
  }
  if (changed) broadcast();
}

// ---------------------------------------------------------------------------
// Öffentlicher Zustand + Live-Updates per Server-Sent Events

function publicState() {
  return {
    settings: state.settings,
    wheel: {
      open: state.wheel.open,
      entries: state.wheel.entries,
      spinnerIds: state.wheel.spinnerIds,
      spin: state.wheel.spin ? { ...state.wheel.spin, age: Date.now() - state.wheel.spin.startedAt } : null,
    },
    schedule: state.schedule,
    players: state.players,
    polls: state.polls.map(pollView),
    servers: state.servers.map((s) => ({ ...s, status: serverStatus[s.id] || null })),
    // Die Matrix selbst ist nicht öffentlich; ändert sich die Zahl, lädt das Dashboard sie neu.
    steamRev,
  };
}

const clients = new Set();

function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of clients) res.write(payload);
}

function changed() {
  scheduleSave();
  broadcast();
}

// Hält Verbindungen durch Proxies und WLAN-Router hindurch offen.
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000).unref();

// ---------------------------------------------------------------------------
// HTTP-Hilfsfunktionen

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Anfrage zu groß'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Ungültiges JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function safeEqual(x, y) {
  const a = crypto.createHash('sha256').update(String(x)).digest();
  const b = crypto.createHash('sha256').update(String(y)).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function findUserByToken(token) {
  if (!token) return null;
  return state.users.find((u) => safeEqual(u.token, token)) || null;
}

// Der angemeldete Nutzer (über das Cookie aus dem Einladungslink).
function currentUser(req) {
  return findUserByToken(parseCookies(req)[SESSION_COOKIE]);
}

function hasMasterPassword(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') && safeEqual(header.slice(7), ADMIN_PASSWORD);
}

// Admin ist, wer das Master-Passwort mitschickt oder als Admin-Nutzer angemeldet ist.
function isAdmin(req) {
  return hasMasterPassword(req) || Boolean(currentUser(req)?.isAdmin);
}

// Wer per Master-Passwort angemeldet ist, sieht im Nutzermodus alle Features.
const MASTER_USER = {
  id: 'master',
  username: 'Admin',
  isAdmin: true,
  master: true,
  features: Object.fromEntries(FEATURES.map((f) => [f.key, true])),
};

// Das Master-Passwort hat Vorrang: Hat dieser Browser zusätzlich das Cookie
// eines Nutzers (z.B. weil dessen Link hier geöffnet wurde), bleibt der Admin
// trotzdem der Admin und wird nicht zu diesem Nutzer.
function viewer(req) {
  return hasMasterPassword(req) ? MASTER_USER : currentUser(req);
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function cleanFeatures(input) {
  const out = {};
  for (const key of FEATURE_KEYS) out[key] = Boolean(input && input[key]);
  return out;
}

function userView(u) {
  return { id: u.id, username: u.username, isAdmin: u.isAdmin, features: u.features, token: u.token, createdAt: u.createdAt, lastLogin: u.lastLogin || null };
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

function sanitize(fields, input, partial) {
  const out = {};
  for (const [key, clean] of Object.entries(fields)) {
    if (partial && !(key in input)) continue;
    out[key] = clean(input[key]);
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const PAGES = { '/': 'index.html', '/admin': 'admin.html' };

function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || pathname.slice(1);
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Nicht gefunden' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Nicht gefunden' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Routen

async function handleApi(req, res, pathname) {
  const method = req.method;

  if (method === 'GET' && pathname === '/api/state') return sendJson(res, 200, publicState());

  if (method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (method === 'GET' && pathname === '/api/health') return sendJson(res, 200, { ok: true });

  if (pathname.startsWith('/api/polls/')) return handlePolls(req, res, method, pathname.split('/').slice(3));

  if (method === 'GET' && pathname === '/api/me') {
    const user = viewer(req);
    if (!user) return sendJson(res, 401, { error: 'Nicht angemeldet' });
    return sendJson(res, 200, {
      id: user.id,
      username: user.username,
      isAdmin: user.isAdmin,
      master: Boolean(user.master),
      features: FEATURES.map((f) => ({ ...f, enabled: Boolean(user.features[f.key]) })),
    });
  }

  // Platzhalter für die Features: prüft nur die Berechtigung.
  if (method === 'GET' && pathname.startsWith('/api/features/')) {
    const key = pathname.split('/')[3];
    if (!FEATURE_KEYS.has(key)) return sendJson(res, 404, { error: 'Unbekanntes Feature' });
    const user = viewer(req);
    if (!user) return sendJson(res, 401, { error: 'Nicht angemeldet' });
    if (!user.features[key]) return sendJson(res, 403, { error: 'Kein Zugriff auf dieses Feature' });
    return sendJson(res, 200, { feature: key, status: 'kommt bald' });
  }

  if (pathname.startsWith('/api/wheel/')) return handleWheel(req, res, method, pathname.split('/').slice(3));
  if (pathname.startsWith('/api/steam/')) return handleSteam(req, res, method, pathname.split('/').slice(3));

  if (!pathname.startsWith('/api/admin/')) return sendJson(res, 404, { error: 'Nicht gefunden' });
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'Falsches Passwort' });

  const parts = pathname.split('/').slice(3); // nach /api/admin/

  if (method === 'POST' && parts[0] === 'login') return sendJson(res, 200, { ok: true });

  if (method === 'PUT' && parts[0] === 'settings') {
    Object.assign(state.settings, sanitize(SETTINGS_FIELDS, await readBody(req), true));
    changed();
    return sendJson(res, 200, state.settings);
  }

  if (parts[0] === 'users') return handleUsers(req, res, method, parts);
  if (parts[0] === 'wheel') return handleWheelAdmin(req, res, method, parts);
  if (parts[0] === 'polls') return handlePollsAdmin(req, res, method, parts);
  if (parts[0] === 'steam') return handleSteamAdmin(req, res, method, parts);

  const fields = COLLECTIONS[parts[0]];
  if (!fields) return sendJson(res, 404, { error: 'Nicht gefunden' });
  const list = state[parts[0]];

  if (method === 'POST' && parts.length === 1) {
    const item = { id: crypto.randomUUID(), ...sanitize(fields, await readBody(req), false) };
    list.push(item);
    if (parts[0] === 'schedule') list.sort((a, b) => a.time.localeCompare(b.time));
    changed();
    if (parts[0] === 'servers') checkAllServers();
    return sendJson(res, 201, item);
  }

  const index = list.findIndex((i) => i.id === parts[1]);
  if (parts.length !== 2 || index === -1) return sendJson(res, 404, { error: 'Eintrag nicht gefunden' });

  if (method === 'PATCH') {
    Object.assign(list[index], sanitize(fields, await readBody(req), true));
    const item = list[index];
    if (parts[0] === 'schedule') list.sort((a, b) => a.time.localeCompare(b.time));
    changed();
    if (parts[0] === 'servers') checkAllServers();
    return sendJson(res, 200, item);
  }

  if (method === 'DELETE') {
    const [removed] = list.splice(index, 1);
    if (parts[0] === 'servers') delete serverStatus[removed.id];
    changed();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { error: 'Methode nicht erlaubt' });
}

async function handleUsers(req, res, method, parts) {
  const id = parts[1];

  if (method === 'GET' && !id) {
    return sendJson(res, 200, { users: state.users.map(userView), features: FEATURES });
  }

  if (method === 'POST' && !id) {
    const body = await readBody(req);
    const username = str(40)(body.username);
    if (!username) return sendJson(res, 400, { error: 'Nutzername fehlt' });
    if (state.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      return sendJson(res, 409, { error: 'Diesen Nutzernamen gibt es schon' });
    }
    const user = {
      id: crypto.randomUUID(),
      username,
      isAdmin: Boolean(body.isAdmin),
      features: cleanFeatures(body.features),
      token: newToken(),
      createdAt: Date.now(),
    };
    state.users.push(user);
    scheduleSave();
    return sendJson(res, 201, userView(user));
  }

  const user = state.users.find((u) => u.id === id);
  if (!user) return sendJson(res, 404, { error: 'Nutzer nicht gefunden' });

  if (method === 'PATCH' && parts.length === 2) {
    const body = await readBody(req);
    if ('username' in body) {
      const username = str(40)(body.username);
      if (!username) return sendJson(res, 400, { error: 'Nutzername fehlt' });
      if (state.users.some((u) => u !== user && u.username.toLowerCase() === username.toLowerCase())) {
        return sendJson(res, 409, { error: 'Diesen Nutzernamen gibt es schon' });
      }
      user.username = username;
    }
    if ('isAdmin' in body) user.isAdmin = Boolean(body.isAdmin);
    if ('features' in body) user.features = cleanFeatures({ ...user.features, ...body.features });
    scheduleSave();
    return sendJson(res, 200, userView(user));
  }

  // Neuer Link: der alte funktioniert danach nicht mehr, bestehende Anmeldungen enden.
  if (method === 'POST' && parts[2] === 'regenerate') {
    user.token = newToken();
    scheduleSave();
    return sendJson(res, 200, userView(user));
  }

  if (method === 'DELETE' && parts.length === 2) {
    state.users.splice(state.users.indexOf(user), 1);
    state.wheel.spinnerIds = state.wheel.spinnerIds.filter((uid) => uid !== user.id);
    for (const poll of state.polls) delete poll.votes[user.id];
    delete state.steam.profiles[user.id];
    delete nowPlaying[user.id];
    steamChanged();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { error: 'Methode nicht erlaubt' });
}

// ---------------------------------------------------------------------------
// Glücksrad

const SPIN_DURATION = 8000;
const MAX_WHEEL_ENTRIES = 60;
const MAX_ENTRIES_PER_USER = 10;

function isSpinning() {
  const spin = state.wheel.spin;
  return Boolean(spin && Date.now() - spin.startedAt < spin.duration);
}

async function handleWheel(req, res, method, parts) {
  const user = viewer(req);
  if (!user) return sendJson(res, 401, { error: 'Nicht angemeldet' });
  const wheel = state.wheel;
  const admin = user.isAdmin;

  if (method === 'POST' && parts[0] === 'entries' && parts.length === 1) {
    if (!admin && !user.features.gluecksrad) return sendJson(res, 403, { error: 'Kein Zugriff auf das Glücksrad' });
    if (!wheel.open && !admin) return sendJson(res, 409, { error: 'Die Eingabe ist geschlossen' });
    if (isSpinning()) return sendJson(res, 409, { error: 'Das Rad dreht gerade' });
    const text = str(40)((await readBody(req)).text);
    if (!text) return sendJson(res, 400, { error: 'Text fehlt' });
    if (wheel.entries.length >= MAX_WHEEL_ENTRIES) return sendJson(res, 409, { error: 'Das Rad ist voll' });
    if (!admin && wheel.entries.filter((e) => e.ownerId === user.id).length >= MAX_ENTRIES_PER_USER) {
      return sendJson(res, 409, { error: `Du hast schon ${MAX_ENTRIES_PER_USER} Einträge` });
    }
    const entry = { id: crypto.randomUUID(), text, ownerId: user.id, owner: user.username };
    wheel.entries.push(entry);
    changed();
    return sendJson(res, 201, entry);
  }

  if (method === 'DELETE' && parts[0] === 'entries' && parts.length === 2) {
    const index = wheel.entries.findIndex((e) => e.id === parts[1]);
    if (index === -1) return sendJson(res, 404, { error: 'Eintrag nicht gefunden' });
    const own = wheel.entries[index].ownerId === user.id;
    if (!admin && !(own && user.features.gluecksrad)) return sendJson(res, 403, { error: 'Das ist nicht dein Eintrag' });
    if (!admin && !wheel.open) return sendJson(res, 409, { error: 'Die Eingabe ist geschlossen' });
    if (isSpinning()) return sendJson(res, 409, { error: 'Das Rad dreht gerade' });
    wheel.entries.splice(index, 1);
    changed();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && parts[0] === 'spin' && parts.length === 1) {
    if (!admin && !wheel.spinnerIds.includes(user.id)) return sendJson(res, 403, { error: 'Du darfst nicht drehen' });
    if (isSpinning()) return sendJson(res, 409, { error: 'Das Rad dreht gerade' });
    if (!wheel.entries.length) return sendJson(res, 409, { error: 'Das Rad hat keine Einträge' });
    const winnerIndex = crypto.randomInt(wheel.entries.length);
    // Alle Anzeigen animieren aus denselben Werten und landen so auf demselben Feld.
    wheel.spin = {
      id: crypto.randomUUID(),
      startedAt: Date.now(),
      duration: SPIN_DURATION,
      entries: wheel.entries.map((e) => ({ id: e.id, text: e.text })),
      winnerIndex,
      offset: crypto.randomInt(-35, 36) / 100,
      result: wheel.entries[winnerIndex].text,
      by: user.username,
    };
    changed();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Nicht gefunden' });
}

async function handleWheelAdmin(req, res, method, parts) {
  const wheel = state.wheel;

  if (method === 'PUT' && parts.length === 1) {
    const body = await readBody(req);
    if ('open' in body) wheel.open = Boolean(body.open);
    if (Array.isArray(body.spinnerIds)) {
      const known = new Set(state.users.map((u) => u.id));
      wheel.spinnerIds = [...new Set(body.spinnerIds.map(String))].filter((id) => known.has(id));
    }
    changed();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && parts[1] === 'clear') {
    if (isSpinning()) return sendJson(res, 409, { error: 'Das Rad dreht gerade' });
    wheel.entries = [];
    wheel.spin = null;
    changed();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Nicht gefunden' });
}

// ---------------------------------------------------------------------------
// Abstimmungen

const MAX_POLL_OPTIONS = 12;

function newPoll(question, options) {
  return {
    id: crypto.randomUUID(),
    question,
    options: options.map((text) => ({ id: crypto.randomUUID(), text })),
    open: true,
    createdAt: Date.now(),
    votes: {}, // Nutzer-ID -> Antwort-ID
  };
}

// Öffentlich nur die Summen, nicht wer wofür gestimmt hat.
function pollView(poll) {
  const counts = {};
  for (const optionId of Object.values(poll.votes)) counts[optionId] = (counts[optionId] || 0) + 1;
  return {
    id: poll.id,
    question: poll.question,
    open: poll.open,
    createdAt: poll.createdAt,
    total: Object.keys(poll.votes).length,
    options: poll.options.map((o) => ({ id: o.id, text: o.text, votes: counts[o.id] || 0 })),
  };
}

async function handlePolls(req, res, method, parts) {
  const user = viewer(req);
  if (!user) return sendJson(res, 401, { error: 'Nicht angemeldet' });

  // Die eigenen Stimmen, damit das Dashboard die gewählte Antwort markieren kann.
  if (method === 'GET' && parts[0] === 'mine') {
    const mine = {};
    for (const poll of state.polls) if (poll.votes[user.id]) mine[poll.id] = poll.votes[user.id];
    return sendJson(res, 200, mine);
  }

  if (method === 'POST' && parts[1] === 'vote' && parts.length === 2) {
    if (!user.isAdmin && !user.features.abstimmungen) return sendJson(res, 403, { error: 'Kein Zugriff auf Abstimmungen' });
    const poll = state.polls.find((p) => p.id === parts[0]);
    if (!poll) return sendJson(res, 404, { error: 'Abstimmung nicht gefunden' });
    if (!poll.open) return sendJson(res, 409, { error: 'Diese Abstimmung ist beendet' });
    const { optionId } = await readBody(req);
    if (optionId === null) {
      delete poll.votes[user.id];
    } else {
      if (!poll.options.some((o) => o.id === optionId)) return sendJson(res, 400, { error: 'Unbekannte Antwort' });
      poll.votes[user.id] = optionId;
    }
    changed();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Nicht gefunden' });
}

async function handlePollsAdmin(req, res, method, parts) {
  if (method === 'POST' && parts.length === 1) {
    const body = await readBody(req);
    const question = str(150)(body.question);
    const options = [...new Set((Array.isArray(body.options) ? body.options : []).map(str(80)).filter(Boolean))];
    if (!question) return sendJson(res, 400, { error: 'Frage fehlt' });
    if (options.length < 2) return sendJson(res, 400, { error: 'Mindestens zwei Antworten nötig' });
    if (options.length > MAX_POLL_OPTIONS) return sendJson(res, 400, { error: `Höchstens ${MAX_POLL_OPTIONS} Antworten` });
    const poll = newPoll(question, options);
    state.polls.unshift(poll);
    changed();
    return sendJson(res, 201, pollView(poll));
  }

  const poll = state.polls.find((p) => p.id === parts[1]);
  if (!poll) return sendJson(res, 404, { error: 'Abstimmung nicht gefunden' });

  if (method === 'PATCH' && parts.length === 2) {
    const body = await readBody(req);
    if ('open' in body) poll.open = Boolean(body.open);
    changed();
    return sendJson(res, 200, pollView(poll));
  }

  if (method === 'POST' && parts[2] === 'reset') {
    poll.votes = {};
    changed();
    return sendJson(res, 200, pollView(poll));
  }

  if (method === 'DELETE' && parts.length === 2) {
    state.polls.splice(state.polls.indexOf(poll), 1);
    changed();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { error: 'Methode nicht erlaubt' });
}

// ---------------------------------------------------------------------------
// Steam-Spiele-Matrix
//
// Die Steam Web API verrät, welche Spiele jemand besitzt, wie lange er sie
// gespielt hat und was er gerade spielt, aber nicht, was installiert ist.
// "Installiert" haken die Nutzer deshalb selbst an.

let steamRev = 0;
const nowPlaying = {}; // Nutzer-ID -> { appid, name }
const steamRefreshAt = {}; // Nutzer-ID -> Zeitpunkt des letzten manuellen Aktualisierens

function steamChanged() {
  steamRev++;
  changed();
}

function steamKey() {
  return STEAM_API_KEY || state.steam.apiKey;
}

async function steamApi(endpoint, params) {
  const url = new URL(STEAM_API_BASE + endpoint);
  url.searchParams.set('key', steamKey());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // status 502: die Fehlermeldung geht so bis zum Browser durch.
  const fail = (message) => Object.assign(new Error(message), { status: 502 });
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  } catch {
    throw fail('Steam nicht erreichbar (Internet?)');
  }
  if (res.status === 401 || res.status === 403) throw fail('Steam-API-Schlüssel ungültig');
  if (res.status === 429) throw fail('Steam bremst gerade, später nochmal versuchen');
  if (!res.ok) throw fail(`Steam antwortet mit Fehler ${res.status}`);
  return (await res.json().catch(() => ({}))).response || {};
}

// Akzeptiert SteamID64, Profil-Link (/profiles/… oder /id/…) oder den Namen aus der Profil-URL.
async function resolveSteamId(input) {
  const text = String(input ?? '').trim();
  const direct = text.match(/(?:^|\/profiles\/)(7656\d{13})(?:\D|$)/);
  if (direct) return direct[1];
  const vanity = (text.match(/steamcommunity\.com\/id\/([^/?#\s]+)/) || [])[1]
    || (/^[A-Za-z0-9_-]{2,32}$/.test(text) ? text : null);
  if (!vanity) throw Object.assign(new Error('Das sieht nicht nach einem Steam-Profil aus'), { status: 400 });
  if (!steamKey()) throw Object.assign(new Error('Zuerst muss der Admin einen Steam-API-Schlüssel eintragen'), { status: 409 });
  const data = await steamApi('/ISteamUser/ResolveVanityURL/v1/', { vanityurl: vanity });
  if (data.success !== 1) throw Object.assign(new Error('Steam-Profil nicht gefunden'), { status: 404 });
  return data.steamid;
}

async function fetchSteamGames(userId) {
  const profile = state.steam.profiles[userId];
  if (!profile || !steamKey()) return;
  try {
    const data = await steamApi('/IPlayerService/GetOwnedGames/v1/', {
      steamid: profile.steamId,
      include_appinfo: 1,
      include_played_free_games: 1,
    });
    // Private Spieldetails liefern eine leere Antwort statt eines Fehlers.
    if (!Array.isArray(data.games)) {
      profile.error = 'Spieldetails im Steam-Profil sind privat';
    } else {
      for (const g of data.games) {
        state.steam.games[g.appid] = { name: str(120)(g.name), icon: /^[0-9a-f]{40}$/.test(g.img_icon_url) ? g.img_icon_url : '' };
      }
      profile.games = data.games.map((g) => [g.appid, num(g.playtime_forever)]);
      profile.error = null;
    }
  } catch (err) {
    profile.error = err.message; // Alte Spieleliste bleibt erhalten, falls das Internet weg ist.
  }
  profile.fetchedAt = Date.now();
  steamChanged();
}

async function refreshAllSteamGames() {
  for (const userId of Object.keys(state.steam.profiles)) await fetchSteamGames(userId);
}

// Name, Avatar und "spielt gerade" für alle verknüpften Profile, in einem Aufruf.
async function refreshSteamPlaying() {
  const entries = Object.entries(state.steam.profiles);
  if (!entries.length || !steamKey()) return;
  let players;
  try {
    players = (await steamApi('/ISteamUser/GetPlayerSummaries/v2/', {
      steamids: entries.map(([, p]) => p.steamId).slice(0, 100).join(','),
    })).players || [];
  } catch {
    return;
  }
  const bySteamId = new Map(players.map((p) => [p.steamid, p]));
  let dirty = false;
  for (const [userId, profile] of entries) {
    const p = bySteamId.get(profile.steamId);
    if (!p) continue;
    const persona = str(60)(p.personaname);
    const avatar = /^https:\/\/[\w.-]+\.(steamstatic|akamaihd)\.(com|net)\//.test(p.avatarmedium || '') ? p.avatarmedium : '';
    if (persona !== profile.persona || avatar !== profile.avatar) {
      Object.assign(profile, { persona, avatar });
      dirty = true;
    }
    const playing = p.gameid ? { appid: Number(p.gameid), name: str(120)(p.gameextrainfo) } : null;
    if (nowPlaying[userId]?.appid !== playing?.appid) dirty = true;
    if (playing) nowPlaying[userId] = playing;
    else delete nowPlaying[userId];
  }
  if (dirty) steamChanged();
}

async function linkSteam(userId, input) {
  if (!str(200)(input)) {
    delete state.steam.profiles[userId];
    delete nowPlaying[userId];
    steamChanged();
    return null;
  }
  const steamId = await resolveSteamId(input);
  const old = state.steam.profiles[userId];
  state.steam.profiles[userId] = old?.steamId === steamId
    ? old
    : { steamId, persona: '', avatar: '', games: [], installed: [], fetchedAt: null, error: null };
  await fetchSteamGames(userId);
  refreshSteamPlaying();
  return state.steam.profiles[userId];
}

function steamProfileView(profile) {
  if (!profile) return null;
  return {
    steamId: profile.steamId,
    persona: profile.persona,
    gameCount: profile.games.length,
    fetchedAt: profile.fetchedAt,
    error: profile.error,
  };
}

// Spalten = Nutzer mit verknüpftem Profil und Spielen, Zeilen = alle Spiele, die mindestens einer besitzt.
// Profile ohne Spiele (meist privat) zählen nicht mit, sonst hätte nie "jeder" ein Spiel.
function steamMatrix(user) {
  const linked = state.users.filter((u) => state.steam.profiles[u.id]);
  const players = linked
    .filter((u) => state.steam.profiles[u.id].games.length)
    .map((u) => {
      const p = state.steam.profiles[u.id];
      return { id: u.id, username: u.username, persona: p.persona, avatar: p.avatar, gameCount: p.games.length, error: p.error, playing: nowPlaying[u.id] || null };
    });
  const games = new Map();
  players.forEach((player, index) => {
    const profile = state.steam.profiles[player.id];
    const installed = new Set(profile.installed);
    for (const [appid, minutes] of profile.games) {
      if (!games.has(appid)) games.set(appid, { appid, ...(state.steam.games[appid] || { name: `App ${appid}`, icon: '' }), own: [] });
      games.get(appid).own.push([index, minutes, installed.has(appid) ? 1 : 0]);
    }
  });
  return {
    configured: Boolean(steamKey()),
    me: { id: user.id, canLink: !user.master, profile: steamProfileView(state.steam.profiles[user.id]) },
    unlinked: state.users.filter((u) => !state.steam.profiles[u.id] && (u.isAdmin || u.features.spiele)).map((u) => u.username),
    problems: linked
      .filter((u) => !state.steam.profiles[u.id].games.length)
      .map((u) => ({ username: u.username, error: state.steam.profiles[u.id].error || 'noch keine Spiele geladen' })),
    players,
    games: [...games.values()],
  };
}

async function handleSteam(req, res, method, parts) {
  const user = viewer(req);
  if (!user) return sendJson(res, 401, { error: 'Nicht angemeldet' });
  if (!user.isAdmin && !user.features.spiele) return sendJson(res, 403, { error: 'Kein Zugriff auf die Spiele-Matrix' });

  if (method === 'GET' && parts[0] === 'matrix') return sendJson(res, 200, steamMatrix(user));

  if (user.master) return sendJson(res, 409, { error: 'Mit dem Master-Passwort gibt es kein eigenes Steam-Profil' });

  if (method === 'PUT' && parts[0] === 'me' && parts.length === 1) {
    const profile = await linkSteam(user.id, (await readBody(req)).profile);
    return sendJson(res, 200, { profile: steamProfileView(profile) });
  }

  if (method === 'POST' && parts[0] === 'me' && parts[1] === 'refresh') {
    if (!state.steam.profiles[user.id]) return sendJson(res, 409, { error: 'Kein Steam-Profil verknüpft' });
    if (Date.now() - (steamRefreshAt[user.id] || 0) < 60000) return sendJson(res, 429, { error: 'Bitte eine Minute warten' });
    steamRefreshAt[user.id] = Date.now();
    await fetchSteamGames(user.id);
    return sendJson(res, 200, { profile: steamProfileView(state.steam.profiles[user.id]) });
  }

  // "Habe ich installiert" setzt jeder nur für sich und nur für Spiele, die er besitzt.
  if (method === 'PUT' && parts[0] === 'installed' && parts.length === 2) {
    const profile = state.steam.profiles[user.id];
    const appid = Number(parts[1]);
    if (!profile) return sendJson(res, 409, { error: 'Kein Steam-Profil verknüpft' });
    if (!profile.games.some(([id]) => id === appid)) return sendJson(res, 404, { error: 'Dieses Spiel besitzt du nicht' });
    const installed = new Set(profile.installed);
    if ((await readBody(req)).installed) installed.add(appid);
    else installed.delete(appid);
    profile.installed = [...installed];
    steamChanged();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Nicht gefunden' });
}

async function handleSteamAdmin(req, res, method, parts) {
  if (method === 'GET' && parts.length === 1) {
    return sendJson(res, 200, {
      keySource: STEAM_API_KEY ? 'env' : state.steam.apiKey ? 'admin' : null,
      users: state.users.map((u) => ({ id: u.id, username: u.username, profile: steamProfileView(state.steam.profiles[u.id]) })),
    });
  }

  if (method === 'PUT' && parts.length === 1) {
    state.steam.apiKey = str(64)((await readBody(req)).apiKey);
    steamChanged();
    if (steamKey()) refreshAllSteamGames().then(refreshSteamPlaying);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'PUT' && parts[1] === 'users' && parts.length === 3) {
    const user = state.users.find((u) => u.id === parts[2]);
    if (!user) return sendJson(res, 404, { error: 'Nutzer nicht gefunden' });
    const profile = await linkSteam(user.id, (await readBody(req)).profile);
    return sendJson(res, 200, { profile: steamProfileView(profile) });
  }

  if (method === 'POST' && parts[1] === 'refresh') {
    await refreshAllSteamGames();
    await refreshSteamPlaying();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Nicht gefunden' });
}

function handleLogin(req, res, url) {
  const user = findUserByToken(url.searchParams.get('token'));
  if (!user) return redirect(res, '/?ungueltig=1');
  user.lastLogin = Date.now();
  scheduleSave();
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(user.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
  redirect(res, '/', { 'Set-Cookie': cookie });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    if (req.method === 'GET' && pathname === '/login') return handleLogin(req, res, url);
    // Früherer Nutzerbereich: alles liegt jetzt im Dashboard.
    if (req.method === 'GET' && (pathname === '/me' || pathname === '/vote')) return redirect(res, '/');
    if (req.method === 'GET' && pathname === '/logout') {
      return redirect(res, '/', { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Methode nicht erlaubt' });
    serveStatic(req, res, pathname);
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Serverfehler' });
    if (!err.status) console.error(err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`LAN-Party-Dashboard läuft auf http://${HOST}:${PORT}`);
  console.log(`Daten werden gespeichert in ${DATA_FILE}`);
});

checkAllServers();
setInterval(checkAllServers, SERVER_CHECK_INTERVAL).unref();
refreshAllSteamGames().then(refreshSteamPlaying);
setInterval(refreshAllSteamGames, STEAM_REFRESH).unref();
setInterval(refreshSteamPlaying, 60 * 1000).unref();

function shutdown() {
  if (saveTimer) saveNow();
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
