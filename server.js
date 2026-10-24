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
  announcements: [],
  schedule: [],
  players: [],
  games: [],
  votes: {},
  servers: [],
};

// Erlaubte Felder je Sammlung und wie sie bereinigt werden.
const COLLECTIONS = {
  announcements: { text: str(500) },
  schedule: { time: str(32), title: str(120), note: str(200) },
  players: { name: str(60), seat: str(20), points: num },
  games: { name: str(80) },
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
    if (raw.votes && typeof raw.votes === 'object') state.votes = raw.votes;
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
  const tally = {};
  for (const gameId of Object.values(state.votes)) tally[gameId] = (tally[gameId] || 0) + 1;
  return {
    settings: state.settings,
    announcements: state.announcements,
    schedule: state.schedule,
    players: state.players,
    games: state.games.map((g) => ({ ...g, votes: tally[g.id] || 0 })),
    servers: state.servers.map((s) => ({ ...s, status: serverStatus[s.id] || null })),
    totalVotes: Object.keys(state.votes).length,
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

function isAdmin(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = crypto.createHash('sha256').update(token).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
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

const PAGES = { '/': 'index.html', '/admin': 'admin.html', '/vote': 'vote.html' };

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

  if (method === 'POST' && pathname === '/api/vote') {
    const body = await readBody(req);
    const clientId = String(body.clientId || '').slice(0, 64);
    if (!clientId) return sendJson(res, 400, { error: 'clientId fehlt' });
    if (body.gameId === null) {
      delete state.votes[clientId];
    } else {
      if (!state.games.some((g) => g.id === body.gameId)) return sendJson(res, 400, { error: 'Unbekanntes Spiel' });
      state.votes[clientId] = body.gameId;
    }
    changed();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/vote') {
    const clientId = new URL(req.url, 'http://x').searchParams.get('clientId') || '';
    return sendJson(res, 200, { gameId: state.votes[clientId] || null });
  }

  if (!pathname.startsWith('/api/admin/')) return sendJson(res, 404, { error: 'Nicht gefunden' });
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'Falsches Passwort' });

  const parts = pathname.split('/').slice(3); // nach /api/admin/

  if (method === 'POST' && parts[0] === 'login') return sendJson(res, 200, { ok: true });

  if (method === 'PUT' && parts[0] === 'settings') {
    Object.assign(state.settings, sanitize(SETTINGS_FIELDS, await readBody(req), true));
    changed();
    return sendJson(res, 200, state.settings);
  }

  if (method === 'POST' && parts[0] === 'votes' && parts[1] === 'reset') {
    state.votes = {};
    changed();
    return sendJson(res, 200, { ok: true });
  }

  const fields = COLLECTIONS[parts[0]];
  if (!fields) return sendJson(res, 404, { error: 'Nicht gefunden' });
  const list = state[parts[0]];

  if (method === 'POST' && parts.length === 1) {
    const item = { id: crypto.randomUUID(), ...sanitize(fields, await readBody(req), false) };
    if (parts[0] === 'announcements') {
      item.createdAt = Date.now();
      list.unshift(item);
    } else {
      list.push(item);
    }
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
    if (parts[0] === 'games') {
      for (const [client, gameId] of Object.entries(state.votes)) {
        if (gameId === removed.id) delete state.votes[client];
      }
    }
    if (parts[0] === 'servers') delete serverStatus[removed.id];
    changed();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { error: 'Methode nicht erlaubt' });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
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
