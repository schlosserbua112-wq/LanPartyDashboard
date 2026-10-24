'use strict';

// Netzwerk-Monitoring für das Dashboard, ohne externe Abhängigkeiten.
// Misst regelmäßig Ping zu Internet, Router und eingetragenen Geräten und liest,
// falls in der FritzBox freigegeben, den Internet-Durchsatz per UPnP aus.
// Gibt es kein nutzbares "ping" (z.B. im Docker-Container ohne Root), wird
// stattdessen die Zeit für einen TCP-Verbindungsaufbau gemessen.

const { execFile } = require('node:child_process');
const net = require('node:net');
const dns = require('node:dns');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

const HISTORY = 60; // Messpunkte pro Ziel (bei 10 s Abstand also 10 Minuten)
const LOSS_WINDOW = 20; // Verlust und Jitter über die letzten 20 Messungen
const MAX_EVENTS = 30;
const DNS_NAME = 'cloudflare.com';
const UPNP_PORT = 49000;
const WAN_SERVICE = 'urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1';
const WAN_PATH = '/igdupnp/control/WANCommonIFC1';

// Nur harmlose Hostnamen/IPs, damit nichts als Option bei "ping" landet.
const HOST_RE = /^[a-z0-9][a-z0-9.:-]{0,252}$/i;
const validHost = (host) => HOST_RE.test(String(host || ''));

const round = (n) => Math.round(n * 10) / 10;

// --- Messen --------------------------------------------------------------------

let pingMode = null; // 'ping' oder 'tcp', wird beim Start einmal ermittelt

function systemPing(host) {
  return new Promise((resolve) => {
    execFile('ping', ['-n', '-c', '1', '-W', '1', host], { timeout: 3000 }, (err, stdout) => {
      const m = /time[=<]\s*([\d.]+)\s*ms/.exec(stdout || '');
      resolve(m ? Math.max(0.1, Number(m[1])) : null);
    });
  });
}

// Antwortet der Host mit "Verbindung abgelehnt", ist er trotzdem erreichbar.
function tcpPing(host, port = 80) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok ? Number(process.hrtime.bigint() - started) / 1e6 : null);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', (err) => done(err.code === 'ECONNREFUSED'));
  });
}

async function detectPingMode() {
  pingMode = (await systemPing('127.0.0.1')) !== null ? 'ping' : 'tcp';
  return pingMode;
}

const lookupCache = new Map();

async function resolveIp(host) {
  if (net.isIP(host)) return host;
  const hit = lookupCache.get(host);
  if (hit && Date.now() - hit.at < 60000) return hit.ip;
  try {
    const { address } = await dns.promises.lookup(host, { family: 4 });
    lookupCache.set(host, { ip: address, at: Date.now() });
    return address;
  } catch {
    return null;
  }
}

// ARP-Tabelle des Pi: IP -> MAC aller Geräte, die zuletzt geantwortet haben.
function readArp() {
  const out = new Map();
  try {
    const lines = fs.readFileSync('/proc/net/arp', 'utf8').trim().split('\n').slice(1);
    for (const line of lines) {
      const [ip, , flags, mac] = line.trim().split(/\s+/);
      if (Number(flags) & 0x2) out.set(ip, mac);
    }
  } catch {}
  return out;
}

// Windows-PCs beantworten Ping oft nicht (Firewall). Ist das Gerät nach dem
// Versuch aber in der ARP-Tabelle, ist es im Netz: online, nur ohne Ping-Zeit.
async function probe(host, lan) {
  if (!validHost(host)) return { ok: false, latency: null };
  const ms = pingMode === 'ping' ? await systemPing(host) : await tcpPing(host);
  if (ms !== null) return { ok: true, latency: round(ms) };
  if (lan) {
    const ip = await resolveIp(host);
    if (ip && readArp().has(ip)) return { ok: true, latency: null, quiet: true };
  }
  return { ok: false, latency: null };
}

const resolver = new dns.promises.Resolver({ timeout: 2000, tries: 1 });

async function dnsProbe() {
  const started = process.hrtime.bigint();
  try {
    await resolver.resolve4(DNS_NAME);
    return { ok: true, latency: round(Number(process.hrtime.bigint() - started) / 1e6) };
  } catch {
    return { ok: false, latency: null };
  }
}

// Standard-Gateway aus der Routing-Tabelle, bei der FritzBox meist 192.168.178.1.
function defaultGateway() {
  try {
    for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols[1] === '00000000' && cols[2] && cols[2] !== '00000000') {
        const hex = cols[2];
        return [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join('.');
      }
    }
  } catch {}
  return 'fritz.box';
}

// --- FritzBox per UPnP (TR-064 ohne Anmeldung) ----------------------------------

function soap(host, action) {
  return new Promise((resolve) => {
    const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${WAN_SERVICE}"/></s:Body></s:Envelope>`;
    const req = http.request({
      host,
      port: UPNP_PORT,
      path: WAN_PATH,
      method: 'POST',
      timeout: 2500,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${WAN_SERVICE}#${action}"`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
        if (data.length > 65536) req.destroy();
      });
      res.on('end', () => resolve(res.statusCode === 200 ? data : null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

function tag(xml, name) {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return m ? m[1] : null;
}

// --- Monitor -------------------------------------------------------------------

function createNetMonitor({ getConfig, interval, onUpdate }) {
  const targets = new Map(); // key -> Messreihe
  const events = [];
  let wan = { available: null, down: null, up: null, maxDown: null, maxUp: null, linkUp: null, history: [] };
  let wanPrev = null;
  let wanFailures = 0;
  let wanNextTry = 0;
  let linkCheckedAt = 0;
  let checkedAt = null;
  let speedtest = null;
  let running = false;

  function addEvent(type, text) {
    events.unshift({ at: Date.now(), type, text });
    events.length = Math.min(events.length, MAX_EVENTS);
  }

  function record(key, meta, result) {
    let t = targets.get(key);
    if (!t) {
      t = { key, history: [], ok: null, since: Date.now() };
      targets.set(key, t);
    }
    Object.assign(t, meta);
    // Ein Ausreißer reicht nicht: offline erst nach zwei Fehlversuchen in Folge.
    const prevOk = t.ok;
    t.history.push(result.ok ? (result.quiet ? -1 : result.latency) : null);
    if (t.history.length > HISTORY) t.history.shift();
    const last2 = t.history.slice(-2);
    const ok = result.ok || (prevOk === true && last2.length === 2 && last2[0] !== null);
    if (prevOk !== null && prevOk !== ok) {
      t.since = Date.now();
      addEvent(ok ? 'up' : 'down', `${t.name} ${ok ? 'wieder erreichbar' : 'nicht erreichbar'}`);
    }
    t.ok = ok;
    t.latency = result.latency;
    t.quiet = Boolean(result.quiet);
  }

  function stats(t) {
    const recent = t.history.slice(-LOSS_WINDOW);
    const lost = recent.filter((v) => v === null).length;
    const values = recent.filter((v) => typeof v === 'number' && v >= 0);
    let jitter = null;
    if (values.length > 1) {
      let sum = 0;
      for (let i = 1; i < values.length; i++) sum += Math.abs(values[i] - values[i - 1]);
      jitter = round(sum / (values.length - 1));
    }
    const avg = values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null;
    return { loss: recent.length ? Math.round((lost / recent.length) * 100) : 0, jitter, avg };
  }

  async function checkWan(host) {
    if (Date.now() < wanNextTry) return;
    const xml = await soap(host, 'GetAddonInfos');
    if (!xml) {
      wanFailures++;
      // Nach drei Fehlschlägen nur noch alle 5 Minuten probieren.
      if (wanFailures >= 3) {
        wan = { ...wan, available: false, down: null, up: null };
        wanNextTry = Date.now() + 5 * 60000;
      }
      return;
    }
    wanFailures = 0;
    const now = Date.now();
    const rx = Number(tag(xml, 'NewX_AVM_DE_TotalBytesReceived64') ?? tag(xml, 'NewTotalBytesReceived'));
    const tx = Number(tag(xml, 'NewX_AVM_DE_TotalBytesSent64') ?? tag(xml, 'NewTotalBytesSent'));
    let down = Number(tag(xml, 'NewByteReceiveRate')) || 0;
    let up = Number(tag(xml, 'NewByteSendRate')) || 0;
    // Aus den Zählern über das ganze Intervall gemittelt ist genauer als die Momentwerte.
    if (wanPrev && rx >= wanPrev.rx && tx >= wanPrev.tx && now > wanPrev.at) {
      const secs = (now - wanPrev.at) / 1000;
      down = (rx - wanPrev.rx) / secs;
      up = (tx - wanPrev.tx) / secs;
    }
    if (Number.isFinite(rx) && Number.isFinite(tx)) wanPrev = { rx, tx, at: now };
    wan.available = true;
    wan.down = Math.round(down);
    wan.up = Math.round(up);
    wan.history.push([wan.down, wan.up]);
    if (wan.history.length > HISTORY) wan.history.shift();

    if (now - linkCheckedAt > 5 * 60000) {
      const link = await soap(host, 'GetCommonLinkProperties');
      if (link) {
        linkCheckedAt = now;
        const prevUp = wan.linkUp;
        wan.maxDown = Number(tag(link, 'NewLayer1DownstreamMaxBitRate')) || null;
        wan.maxUp = Number(tag(link, 'NewLayer1UpstreamMaxBitRate')) || null;
        wan.linkUp = tag(link, 'NewPhysicalLinkStatus') === 'Up';
        if (prevUp !== null && prevUp !== wan.linkUp) addEvent(wan.linkUp ? 'up' : 'down', wan.linkUp ? 'DSL-Verbindung steht wieder' : 'DSL-Verbindung getrennt');
      }
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const cfg = getConfig();
      const router = validHost(cfg.router) ? cfg.router : defaultGateway();
      const internet = validHost(cfg.internet) ? cfg.internet : '1.1.1.1';
      const devices = cfg.devices.filter((d) => d.host);

      const [inet, rtr, dnsResult, ...devResults] = await Promise.all([
        probe(internet, false),
        probe(router, true),
        dnsProbe(),
        ...devices.map((d) => probe(d.host, true)),
        checkWan(router),
      ]);
      record('internet', { kind: 'internet', name: 'Internet', host: internet }, inet);
      record('router', { kind: 'router', name: 'Router', host: router }, rtr);
      record('dns', { kind: 'dns', name: 'DNS', host: DNS_NAME }, dnsResult);
      const keep = new Set(['internet', 'router', 'dns']);
      devices.forEach((d, i) => {
        const key = 'dev:' + d.id;
        keep.add(key);
        record(key, { kind: 'device', name: d.name || d.host, host: d.host, id: d.id }, devResults[i]);
      });
      // Gelöschte Geräte vergessen.
      for (const key of targets.keys()) if (!keep.has(key)) targets.delete(key);
      checkedAt = Date.now();
    } catch (err) {
      console.error('Netzwerk-Check fehlgeschlagen:', err.message);
    } finally {
      running = false;
    }
    onUpdate(snapshot());
  }

  function snapshot() {
    return {
      checkedAt,
      interval,
      mode: pingMode,
      targets: [...targets.values()].map((t) => ({
        key: t.key,
        kind: t.kind,
        id: t.id,
        name: t.name,
        host: t.host,
        ok: t.ok,
        quiet: t.quiet,
        latency: t.latency,
        since: t.since,
        history: t.history,
        ...stats(t),
      })),
      wan: { ...wan, history: wan.history },
      events: events.slice(0, 10),
      speedtest,
    };
  }

  function setSpeedtest(info) {
    speedtest = info;
    onUpdate(snapshot());
  }

  async function start() {
    await detectPingMode();
    console.log(`Netzwerk-Monitoring aktiv (${pingMode === 'ping' ? 'Ping' : 'TCP-Verbindungstest'}, alle ${interval / 1000} s)`);
    tick();
    setInterval(tick, interval).unref();
  }

  return { start, snapshot, tick, setSpeedtest, events: () => events };
}

// --- Geräte im Netz finden --------------------------------------------------------

// Eigenes /24-Netz (bei der FritzBox 192.168.178.x).
function localSubnet() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) return { ip: a.address, prefix: a.address.split('.').slice(0, 3).join('.') };
    }
  }
  return null;
}

async function reverseName(ip) {
  try {
    const [name] = await Promise.race([
      dns.promises.reverse(ip),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ]);
    return name ? name.replace(/\.(fritz\.box|local|lan|home)$/i, '') : null;
  } catch {
    return null;
  }
}

let discovering = null;

// Klopft einmal bei allen Adressen des Subnetzes an und liest danach die ARP-Tabelle.
function discover() {
  if (discovering) return discovering;
  discovering = (async () => {
    const net24 = localSubnet();
    if (net24) {
      const ips = Array.from({ length: 254 }, (_, i) => `${net24.prefix}.${i + 1}`).filter((ip) => ip !== net24.ip);
      const queue = [...ips];
      const worker = async () => {
        while (queue.length) {
          const ip = queue.shift();
          if (pingMode === 'ping') await systemPing(ip);
          else await tcpPing(ip);
        }
      };
      await Promise.all(Array.from({ length: 32 }, worker));
    }
    const arp = readArp();
    const found = await Promise.all([...arp.entries()].map(async ([ip, mac]) => ({ ip, mac, name: await reverseName(ip) })));
    return found.sort((a, b) => a.ip.split('.').map(Number).reduce((x, y) => x * 256 + y, 0) - b.ip.split('.').map(Number).reduce((x, y) => x * 256 + y, 0));
  })().finally(() => { discovering = null; });
  return discovering;
}

// --- Verbindungstest für Nutzer (Browser <-> Pi) -----------------------------------

const MAX_TRANSFER = 64 * 1024 * 1024;
let noise = null;

// Liefert bis zu 64 MB Zufallsdaten. Der Browser bricht ab, sobald er genug gemessen hat.
function streamDownload(req, res) {
  noise ||= crypto.randomBytes(256 * 1024);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': MAX_TRANSFER });
  let sent = 0;
  let closed = false;
  req.on('close', () => { closed = true; });
  const pump = () => {
    while (!closed && sent < MAX_TRANSFER) {
      sent += noise.length;
      if (!res.write(noise)) return res.once('drain', pump);
    }
    if (!closed) res.end();
  };
  pump();
}

// Nimmt hochgeladene Daten entgegen und verwirft sie.
function receiveUpload(req) {
  return new Promise((resolve) => {
    let bytes = 0;
    const started = Date.now();
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_TRANSFER) req.destroy();
    });
    req.on('end', () => resolve({ bytes, ms: Date.now() - started }));
    req.on('error', () => resolve({ bytes, ms: Date.now() - started }));
    req.on('close', () => resolve({ bytes, ms: Date.now() - started }));
  });
}

module.exports = { createNetMonitor, discover, streamDownload, receiveUpload, validHost };
