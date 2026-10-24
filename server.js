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
  scores: [], // Punkte-Buchungen fürs globale Leaderboard
  polls: [],
  servers: [],
  users: [],
  tournaments: [],
  wheel: { open: true, entries: [], spinnerIds: [], spin: null },
};

// Features, die der Admin pro Nutzer freischalten kann. Noch Platzhalter.
const FEATURES = [
  { key: 'gluecksrad', label: 'Glücksrad' },
  { key: 'abstimmungen', label: 'Abstimmungen' },
  { key: 'turniere', label: 'Turniere' },
  { key: 'essen', label: 'Essensbestellung' },
  { key: 'wishlist', label: 'Wishlist' },
];
const FEATURE_KEYS = new Set(FEATURES.map((f) => f.key));
const SESSION_COOKIE = 'lp_session';

// Erlaubte Felder je Sammlung und wie sie bereinigt werden.
const COLLECTIONS = {
  schedule: { time: str(32), title: str(120), note: str(200) },
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
    if (Array.isArray(raw.tournaments)) state.tournaments = raw.tournaments;
    if (Array.isArray(raw.players)) state.players = raw.players;
    if (Array.isArray(raw.scores)) {
      state.scores = raw.scores;
    } else {
      migrateToLeaderboard(state);
    }
    if (raw.wheel && typeof raw.wheel === 'object') Object.assign(state.wheel, raw.wheel);
    return state;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Konnte Daten nicht laden, starte leer:', err.message);
    return structuredClone(DEFAULT_STATE);
  }
}

// Frühere Rangliste: Punkte standen direkt am Spieler. Sie werden zur ersten
// Buchung, und jeder Nutzer bekommt einen verknüpften Spieler.
function migrateToLeaderboard(s) {
  for (const p of s.players) {
    const points = num(p.points);
    delete p.points;
    p.userId = p.userId || null;
    if (points) s.scores.push(newScore(p.id, points, 'Startwert', '', 'manual', null, null));
  }
  for (const u of s.users) linkPlayer(s, u, true);
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
  const lb = leaderboardView();
  return {
    settings: state.settings,
    wheel: {
      open: state.wheel.open,
      entries: state.wheel.entries,
      spinnerIds: state.wheel.spinnerIds,
      spin: state.wheel.spin ? { ...state.wheel.spin, age: Date.now() - state.wheel.spin.startedAt } : null,
    },
    schedule: state.schedule,
    players: lb.rowsInRosterOrder,
    leaderboard: { rows: lb.rows, games: lb.games, recent: lb.recent },
    polls: state.polls.map(pollView),
    tournaments: state.tournaments.map(tournamentView),
    servers: state.servers.map((s) => ({ ...s, status: serverStatus[s.id] || null })),
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

  if (pathname.startsWith('/api/tournaments/')) return handleTournaments(req, res, method, pathname.split('/').slice(3));
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
  if (parts[0] === 'tournaments') return handleTournamentsAdmin(req, res, method, parts);
  if (parts[0] === 'players') return handlePlayersAdmin(req, res, method, parts);
  if (parts[0] === 'scores') return handleScoresAdmin(req, res, method, parts);

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
    linkPlayer(state, user, true);
    changed();
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
      const player = state.players.find((p) => p.userId === user.id);
      if (player) player.name = username;
    }
    if ('isAdmin' in body) user.isAdmin = Boolean(body.isAdmin);
    if ('features' in body) user.features = cleanFeatures({ ...user.features, ...body.features });
    changed();
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
    removeUserFromTournaments(user.id);
    // Der Spieler bleibt samt Punkten im Leaderboard, nur ohne Anmeldung.
    for (const p of state.players) if (p.userId === user.id) p.userId = null;
    changed();
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
// Globales Leaderboard
//
// Punkte stehen nicht direkt am Spieler, sondern als Buchungen in state.scores.
// So lässt sich jede Vergabe nachvollziehen und rückgängig machen, und spätere
// Features (Turniere, Achievements, …) buchen über awardPoints() mit eigener
// source und refId und können ihre Punkte per revokeScores(refId) zurücknehmen.

const MAX_SCORES = 20000;
const MAX_POINTS = 100000;
const RECENT_SCORES = 8;
const SCORE_SOURCES = new Set(['manual', 'tournament', 'achievement', 'game']);

function newScore(playerId, points, reason, game, source, refId, by) {
  return { id: crypto.randomUUID(), playerId, points, reason, game, source, refId, by, at: Date.now() };
}

// Sucht den Spieler eines Nutzers. Ein gleichnamiger Spieler ohne Nutzer wird
// verknüpft; mit create entsteht sonst ein neuer.
function linkPlayer(s, user, create) {
  let player = s.players.find((p) => p.userId === user.id);
  if (!player) {
    player = s.players.find((p) => !p.userId && p.name.toLowerCase() === user.username.toLowerCase());
    if (player) player.userId = user.id;
  }
  if (!player && create) {
    player = { id: crypto.randomUUID(), name: user.username, seat: '', userId: user.id };
    s.players.push(player);
  }
  return player || null;
}

// Gleiche Spielnamen in anderer Schreibweise zusammenführen ("cs2" -> "CS2").
function canonicalGame(name) {
  const game = str(40)(name);
  if (!game) return '';
  const lower = game.toLowerCase();
  return state.scores.find((s) => s.game && s.game.toLowerCase() === lower)?.game || game;
}

function scoreError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// Vergibt Punkte an einen Spieler (playerId) oder an den Spieler eines Nutzers
// (userId, wird bei Bedarf angelegt). Wirft Fehler mit status für die API.
function awardPoints({ playerId, userId, points, reason = '', game = '', source = 'manual', refId = null, by = null }) {
  let player = null;
  if (playerId) player = state.players.find((p) => p.id === playerId);
  else if (userId) {
    const user = state.users.find((u) => u.id === userId);
    if (user) player = linkPlayer(state, user, true);
  }
  if (!player) throw scoreError('Spieler nicht gefunden', 404);
  const value = num(points);
  if (!value) throw scoreError('Punkte fehlen');
  if (Math.abs(value) > MAX_POINTS) throw scoreError(`Höchstens ${MAX_POINTS} Punkte auf einmal`);
  if (state.scores.length >= MAX_SCORES) throw scoreError('Zu viele Buchungen, bitte Leaderboard zurücksetzen', 409);
  const entry = newScore(
    player.id, value, str(120)(reason), canonicalGame(game),
    SCORE_SOURCES.has(source) ? source : 'manual', refId ? String(refId) : null, by ? str(40)(by) : null
  );
  state.scores.push(entry);
  changed();
  return entry;
}

// Nimmt alle Buchungen mit dieser refId zurück, z.B. wenn ein Turnier gelöscht wird.
function revokeScores(refId) {
  const before = state.scores.length;
  state.scores = state.scores.filter((s) => s.refId !== String(refId));
  if (state.scores.length !== before) changed();
  return before - state.scores.length;
}

// Gleiche Punkte, gleicher Platz (1, 1, 3, …).
function assignRanks(rows) {
  rows.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'de'));
  rows.forEach((r, i) => { r.rank = i && rows[i - 1].points === r.points ? rows[i - 1].rank : i + 1; });
  return rows;
}

function leaderboardView() {
  const totals = new Map(state.players.map((p) => [p.id, { points: 0, count: 0, games: {}, lastAt: null }]));
  const games = new Set();
  for (const s of state.scores) {
    const t = totals.get(s.playerId);
    if (!t) continue;
    t.points += s.points;
    t.count++;
    t.lastAt = s.at;
    if (s.game) {
      t.games[s.game] = (t.games[s.game] || 0) + s.points;
      games.add(s.game);
    }
  }
  const rowsInRosterOrder = state.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat, userId: p.userId || null, ...totals.get(p.id) }));
  const names = new Map(state.players.map((p) => [p.id, p.name]));
  const recent = state.scores.slice(-RECENT_SCORES).reverse()
    .map(({ refId, ...s }) => ({ ...s, name: names.get(s.playerId) || '?' }));
  return { rows: assignRanks([...rowsInRosterOrder]), rowsInRosterOrder, games: [...games], recent };
}

const PLAYER_FIELDS = { name: str(60), seat: str(20) };

// userId: '' oder null trennt die Verknüpfung, sonst muss es den Nutzer geben.
function applyPlayerUser(player, userId) {
  if (!userId) {
    player.userId = null;
    return;
  }
  if (!state.users.some((u) => u.id === userId)) throw scoreError('Nutzer nicht gefunden', 404);
  // Ein Nutzer gehört zu genau einem Spieler.
  for (const p of state.players) if (p !== player && p.userId === userId) p.userId = null;
  player.userId = userId;
}

async function handlePlayersAdmin(req, res, method, parts) {
  if (method === 'POST' && parts.length === 1) {
    const body = await readBody(req);
    const fields = sanitize(PLAYER_FIELDS, body, false);
    if (!fields.name) return sendJson(res, 400, { error: 'Name fehlt' });
    const player = { id: crypto.randomUUID(), ...fields, userId: null };
    applyPlayerUser(player, body.userId);
    state.players.push(player);
    if (num(body.points)) awardPoints({ playerId: player.id, points: body.points, reason: 'Startwert', by: 'Admin' });
    changed();
    return sendJson(res, 201, player);
  }

  const player = state.players.find((p) => p.id === parts[1]);
  if (parts.length !== 2 || !player) return sendJson(res, 404, { error: 'Spieler nicht gefunden' });

  if (method === 'PATCH') {
    const body = await readBody(req);
    Object.assign(player, sanitize(PLAYER_FIELDS, body, true));
    if ('userId' in body) applyPlayerUser(player, body.userId);
    // Früher wurde der Punktestand direkt gesetzt: als Buchung der Differenz übernehmen.
    if ('points' in body) {
      const current = state.scores.reduce((sum, s) => sum + (s.playerId === player.id ? s.points : 0), 0);
      if (num(body.points) !== current) awardPoints({ playerId: player.id, points: num(body.points) - current, reason: 'Manuell angepasst', by: 'Admin' });
    }
    changed();
    return sendJson(res, 200, player);
  }

  if (method === 'DELETE') {
    state.players.splice(state.players.indexOf(player), 1);
    state.scores = state.scores.filter((s) => s.playerId !== player.id);
    changed();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { error: 'Methode nicht erlaubt' });
}

async function handleScoresAdmin(req, res, method, parts) {
  // Die letzten Buchungen mit Namen, für Verlauf und Rückgängig.
  if (method === 'GET' && parts.length === 1) {
    const names = new Map(state.players.map((p) => [p.id, p.name]));
    return sendJson(res, 200, state.scores.slice(-300).reverse().map((s) => ({ ...s, name: names.get(s.playerId) || '?' })));
  }

  // Mehrere Spieler auf einmal, z.B. das ganze Siegerteam.
  if (method === 'POST' && parts.length === 1) {
    const body = await readBody(req);
    const ids = [...new Set((Array.isArray(body.playerIds) ? body.playerIds : [body.playerId]).filter(Boolean).map(String))];
    if (!ids.length) return sendJson(res, 400, { error: 'Bitte mindestens einen Spieler wählen' });
    if (ids.some((id) => !state.players.some((p) => p.id === id))) return sendJson(res, 404, { error: 'Spieler nicht gefunden' });
    const by = viewer(req)?.username || 'Admin';
    const entries = ids.map((playerId) => awardPoints({ playerId, points: body.points, reason: body.reason, game: body.game, by }));
    return sendJson(res, 201, entries);
  }

  if (method === 'POST' && parts[1] === 'reset' && parts.length === 2) {
    state.scores = [];
    changed();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'DELETE' && parts.length === 2) {
    const index = state.scores.findIndex((s) => s.id === parts[1]);
    if (index === -1) return sendJson(res, 404, { error: 'Buchung nicht gefunden' });
    state.scores.splice(index, 1);
    changed();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { error: 'Methode nicht erlaubt' });
}

// ---------------------------------------------------------------------------
// Turniere

const MAX_TOURNAMENT_PARTICIPANTS = 64;
const MAX_SCORE = 9999;
const TOURNAMENT_FORMATS = { ko: 'K.-o.-System', liga: 'Jeder gegen jeden' };

function newMatch(a, b) {
  return { id: crypto.randomUUID(), a, b, done: false, winner: null, scoreA: null, scoreB: null };
}

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Bit-Umkehr-Reihenfolge: Freilose verteilen sich so gleichmäßig über den Turnierbaum.
function spreadOrder(n) {
  const bits = Math.log2(n);
  return [...Array(n).keys()].map((i) => {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    return r;
  });
}

function buildKo(t) {
  const ids = shuffle(t.participants.map((p) => p.id));
  const size = 2 ** Math.ceil(Math.log2(ids.length));
  const byeSlots = new Set(spreadOrder(size / 2).slice(0, size - ids.length));
  t.rounds = [];
  t.rounds.push([...Array(size / 2).keys()].map((i) => {
    if (!byeSlots.has(i)) return newMatch(ids.shift(), ids.shift());
    return { ...newMatch(ids.shift(), null), bye: true };
  }));
  for (let n = size / 4; n >= 1; n /= 2) t.rounds.push([...Array(n)].map(() => newMatch(null, null)));
  // Wer ein Freilos hat, ist direkt eine Runde weiter.
  t.rounds[0].forEach((m, i) => m.bye && setKoWinner(t, 0, i, m.a));
}

// Jeder gegen jeden nach dem Rundenturnier-Verfahren: Pro Runde spielt jeder höchstens einmal.
function buildLiga(t) {
  const ids = shuffle(t.participants.map((p) => p.id));
  if (ids.length % 2) ids.push(null);
  t.rounds = [];
  for (let r = 0; r < ids.length - 1; r++) {
    const round = [];
    for (let i = 0; i < ids.length / 2; i++) {
      const a = ids[i];
      const b = ids[ids.length - 1 - i];
      if (a && b) round.push(r % 2 ? newMatch(b, a) : newMatch(a, b));
    }
    t.rounds.push(round);
    ids.splice(1, 0, ids.pop());
  }
}

function finishTournament(t, winnerId) {
  t.winnerId = winnerId;
  t.status = 'beendet';
  t.finishedAt = Date.now();
}

function reopenTournament(t) {
  t.winnerId = null;
  t.status = 'laeuft';
  t.finishedAt = null;
}

// Nimmt ein K.-o.-Ergebnis zurück, samt allen Spielen, die darauf aufbauen.
function clearKo(t, r, i) {
  const m = t.rounds[r][i];
  if (!m.done) return;
  Object.assign(m, { done: false, winner: null, scoreA: null, scoreB: null });
  if (r + 1 < t.rounds.length) {
    clearKo(t, r + 1, i >> 1);
    t.rounds[r + 1][i >> 1][i % 2 ? 'b' : 'a'] = null;
  } else {
    reopenTournament(t);
  }
}

function setKoWinner(t, r, i, winner) {
  const m = t.rounds[r][i];
  if (m.winner !== winner) clearKo(t, r, i);
  Object.assign(m, { done: true, winner });
  if (r + 1 < t.rounds.length) t.rounds[r + 1][i >> 1][i % 2 ? 'b' : 'a'] = winner;
  else finishTournament(t, winner);
}

// Tabelle für "Jeder gegen jeden": Sieg 3 Punkte, Unentschieden 1.
function standings(t) {
  const rows = new Map(t.participants.map((p) => [p.id, { id: p.id, name: p.name, played: 0, won: 0, drawn: 0, lost: 0, scored: 0, conceded: 0, points: 0 }]));
  for (const m of t.rounds.flat()) {
    if (!m.done) continue;
    for (const [me, other, mine, theirs] of [[m.a, m.b, m.scoreA, m.scoreB], [m.b, m.a, m.scoreB, m.scoreA]]) {
      const row = rows.get(me);
      if (!row || !rows.has(other)) continue;
      row.played++;
      row.scored += mine;
      row.conceded += theirs;
      if (mine > theirs) { row.won++; row.points += 3; } else if (mine === theirs) { row.drawn++; row.points += 1; } else row.lost++;
    }
  }
  return [...rows.values()].sort((x, y) => y.points - x.points
    || (y.scored - y.conceded) - (x.scored - x.conceded)
    || y.scored - x.scored
    || x.name.localeCompare(y.name));
}

function updateLigaStatus(t) {
  const all = t.rounds.flat();
  if (all.length && all.every((m) => m.done)) {
    if (t.status !== 'beendet') finishTournament(t, standings(t)[0].id);
  } else if (t.status === 'beendet') {
    reopenTournament(t);
  }
}

// Platzierungen fürs globale Leaderboard: 1. und 2. Platz, dazu im K.-o.-System
// beide Halbfinal-Verlierer bzw. bei "Jeder gegen jeden" der Tabellendritte.
const TOURNAMENT_POINTS = { 1: 25, 2: 15, 3: 10 };

function placements(t) {
  if (t.status !== 'beendet') return [];
  if (t.format === 'liga') return standings(t).slice(0, 3).map((row, i) => ({ id: row.id, place: i + 1 }));
  const final = t.rounds[t.rounds.length - 1][0];
  const out = [{ id: final.winner, place: 1 }, { id: final.winner === final.a ? final.b : final.a, place: 2 }];
  if (t.rounds.length > 1) {
    for (const m of t.rounds[t.rounds.length - 2]) if (!m.bye && m.winner) out.push({ id: m.winner === m.a ? m.b : m.a, place: 3 });
  }
  return out.filter((x) => x.id);
}

// Bucht die Turnierpunkte neu, sobald sich das Endergebnis ändert. Teilnehmer
// ohne Nutzer bekommen Punkte nur, wenn es einen gleichnamigen Spieler gibt.
function syncTournamentScores(t) {
  const result = placements(t);
  const key = JSON.stringify(result);
  if (t.awarded === key) return;
  t.awarded = key;
  revokeScores(t.id);
  for (const { id, place } of result) {
    const p = t.participants.find((x) => x.id === id);
    if (!p) continue;
    const player = p.userId ? null : state.players.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
    if (!p.userId && !player) continue;
    try {
      awardPoints({
        userId: p.userId || undefined,
        playerId: player ? player.id : undefined,
        points: TOURNAMENT_POINTS[place],
        reason: `${t.name}: ${place}. Platz`,
        game: t.game,
        source: 'tournament',
        refId: t.id,
        by: 'Turnier',
      });
    } catch (err) {
      console.error('Turnierpunkte nicht gebucht:', err.message);
    }
  }
}

function tournamentView(t) {
  const { awarded, ...rest } = t;
  return {
    ...rest,
    points: TOURNAMENT_POINTS,
    formatLabel: TOURNAMENT_FORMATS[t.format],
    standings: t.format === 'liga' && t.status !== 'anmeldung' ? standings(t) : null,
  };
}

function findMatch(t, matchId) {
  for (let r = 0; r < t.rounds.length; r++) {
    const i = t.rounds[r].findIndex((m) => m.id === matchId);
    if (i !== -1) return { r, i, match: t.rounds[r][i] };
  }
  return null;
}

function score(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX_SCORE ? n : NaN;
}

function addParticipant(t, name, userId = null) {
  if (t.participants.length >= MAX_TOURNAMENT_PARTICIPANTS) return `Höchstens ${MAX_TOURNAMENT_PARTICIPANTS} Teilnehmer`;
  if (userId && t.participants.some((p) => p.userId === userId)) return 'Schon angemeldet';
  if (t.participants.some((p) => p.name.toLowerCase() === name.toLowerCase())) return `„${name}“ ist schon dabei`;
  t.participants.push({ id: crypto.randomUUID(), name, userId });
  return null;
}

function removeUserFromTournaments(userId) {
  for (const t of state.tournaments) {
    if (t.status === 'anmeldung') t.participants = t.participants.filter((p) => p.userId !== userId);
    // Laufende Turniere behalten den Namen, nur die Verknüpfung zum Nutzer fällt weg.
    for (const p of t.participants) if (p.userId === userId) p.userId = null;
  }
}

async function handleTournaments(req, res, method, parts) {
  const user = viewer(req);
  if (!user) return sendJson(res, 401, { error: 'Nicht angemeldet' });
  const t = state.tournaments.find((x) => x.id === parts[0]);
  if (!t) return sendJson(res, 404, { error: 'Turnier nicht gefunden' });
  const allowed = user.isAdmin || user.features.turniere;
  if (!allowed) return sendJson(res, 403, { error: 'Kein Zugriff auf Turniere' });

  if (method === 'POST' && (parts[1] === 'join' || parts[1] === 'leave') && parts.length === 2) {
    if (user.master) return sendJson(res, 400, { error: 'Mit dem Master-Passwort kannst du nicht mitspielen' });
    if (t.status !== 'anmeldung' || !t.open) return sendJson(res, 409, { error: 'Die Anmeldung ist geschlossen' });
    if (parts[1] === 'leave') {
      t.participants = t.participants.filter((p) => p.userId !== user.id);
    } else {
      const error = addParticipant(t, user.username, user.id);
      if (error) return sendJson(res, 409, { error });
    }
    changed();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && parts[1] === 'matches' && parts[3] === 'result' && parts.length === 4) {
    const found = findMatch(t, parts[2]);
    if (!found) return sendJson(res, 404, { error: 'Spiel nicht gefunden' });
    const { r, i, match } = found;
    const playerIds = t.participants.filter((p) => p.userId === user.id).map((p) => p.id);
    if (!user.isAdmin && !playerIds.some((id) => id === match.a || id === match.b)) {
      return sendJson(res, 403, { error: 'Ergebnisse tragen nur die Spieler dieses Spiels oder Admins ein' });
    }
    if (t.status === 'anmeldung') return sendJson(res, 409, { error: 'Das Turnier läuft noch nicht' });
    if (match.bye) return sendJson(res, 409, { error: 'Freilos' });
    if (!match.a || !match.b) return sendJson(res, 409, { error: 'Die Gegner stehen noch nicht fest' });
    const body = await readBody(req);

    if (body.clear) {
      if (!user.isAdmin) return sendJson(res, 403, { error: 'Nur Admins können Ergebnisse löschen' });
      if (t.format === 'ko') clearKo(t, r, i);
      else Object.assign(match, { done: false, winner: null, scoreA: null, scoreB: null });
    } else {
      const scoreA = score(body.scoreA);
      const scoreB = score(body.scoreB);
      if (Number.isNaN(scoreA) || Number.isNaN(scoreB)) return sendJson(res, 400, { error: 'Ungültiger Spielstand' });
      if ((scoreA === null) !== (scoreB === null)) return sendJson(res, 400, { error: 'Bitte beide Ergebnisse eintragen' });
      if (t.format === 'ko') {
        let winner = body.winner === match.a || body.winner === match.b ? body.winner : null;
        if (scoreA !== null && scoreA !== scoreB) {
          const byScore = scoreA > scoreB ? match.a : match.b;
          if (winner && winner !== byScore) return sendJson(res, 400, { error: 'Sieger passt nicht zum Spielstand' });
          winner = byScore;
        }
        if (!winner) return sendJson(res, 400, { error: 'Im K.-o.-System braucht es einen Sieger' });
        setKoWinner(t, r, i, winner);
        Object.assign(match, { scoreA, scoreB });
      } else {
        if (scoreA === null) return sendJson(res, 400, { error: 'Bitte den Spielstand eintragen' });
        const winner = scoreA > scoreB ? match.a : scoreB > scoreA ? match.b : null;
        Object.assign(match, { done: true, winner, scoreA, scoreB });
      }
    }
    if (t.format === 'liga') updateLigaStatus(t);
    syncTournamentScores(t);
    changed();
    return sendJson(res, 200, tournamentView(t));
  }

  return sendJson(res, 404, { error: 'Nicht gefunden' });
}

async function handleTournamentsAdmin(req, res, method, parts) {
  if (method === 'POST' && parts.length === 1) {
    const body = await readBody(req);
    const name = str(80)(body.name);
    if (!name) return sendJson(res, 400, { error: 'Name fehlt' });
    const format = body.format === 'liga' ? 'liga' : 'ko';
    const t = {
      id: crypto.randomUUID(),
      name,
      game: str(60)(body.game),
      format,
      status: 'anmeldung',
      open: Boolean(body.open),
      createdAt: Date.now(),
      participants: [],
      rounds: [],
      winnerId: null,
    };
    for (const id of Array.isArray(body.userIds) ? body.userIds : []) {
      const u = state.users.find((x) => x.id === id);
      if (u) addParticipant(t, u.username, u.id);
    }
    for (const n of (Array.isArray(body.names) ? body.names : []).map(str(40)).filter(Boolean)) addParticipant(t, n);
    state.tournaments.unshift(t);
    changed();
    return sendJson(res, 201, tournamentView(t));
  }

  const t = state.tournaments.find((x) => x.id === parts[1]);
  if (!t) return sendJson(res, 404, { error: 'Turnier nicht gefunden' });

  if (method === 'PATCH' && parts.length === 2) {
    const body = await readBody(req);
    if ('name' in body) t.name = str(80)(body.name) || t.name;
    if ('game' in body) t.game = str(60)(body.game);
    if ('open' in body) t.open = Boolean(body.open);
    if ('format' in body && t.status === 'anmeldung') t.format = body.format === 'liga' ? 'liga' : 'ko';
    changed();
    return sendJson(res, 200, tournamentView(t));
  }

  if (method === 'POST' && parts[2] === 'participants' && parts.length === 3) {
    if (t.status !== 'anmeldung') return sendJson(res, 409, { error: 'Das Turnier hat schon begonnen' });
    const body = await readBody(req);
    const u = body.userId ? state.users.find((x) => x.id === body.userId) : null;
    const name = u ? u.username : str(40)(body.name);
    if (!name) return sendJson(res, 400, { error: 'Name fehlt' });
    const error = addParticipant(t, name, u ? u.id : null);
    if (error) return sendJson(res, 409, { error });
    changed();
    return sendJson(res, 201, tournamentView(t));
  }

  if (method === 'DELETE' && parts[2] === 'participants' && parts.length === 4) {
    if (t.status !== 'anmeldung') return sendJson(res, 409, { error: 'Das Turnier hat schon begonnen' });
    t.participants = t.participants.filter((p) => p.id !== parts[3]);
    changed();
    return sendJson(res, 200, tournamentView(t));
  }

  if (method === 'POST' && parts[2] === 'start') {
    if (t.status !== 'anmeldung') return sendJson(res, 409, { error: 'Das Turnier läuft schon' });
    if (t.participants.length < 2) return sendJson(res, 400, { error: 'Mindestens zwei Teilnehmer nötig' });
    t.status = 'laeuft';
    t.open = false;
    t.startedAt = Date.now();
    if (t.format === 'ko') buildKo(t);
    else buildLiga(t);
    changed();
    return sendJson(res, 200, tournamentView(t));
  }

  // Zurück zur Anmeldung: Spielplan und Ergebnisse werden verworfen.
  if (method === 'POST' && parts[2] === 'reset') {
    Object.assign(t, { status: 'anmeldung', rounds: [], winnerId: null, startedAt: null, finishedAt: null });
    syncTournamentScores(t);
    changed();
    return sendJson(res, 200, tournamentView(t));
  }

  if (method === 'DELETE' && parts.length === 2) {
    state.tournaments.splice(state.tournaments.indexOf(t), 1);
    revokeScores(t.id);
    changed();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { error: 'Methode nicht erlaubt' });
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

function shutdown() {
  if (saveTimer) saveNow();
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
