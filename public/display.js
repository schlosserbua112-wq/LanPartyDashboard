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

function renderWheelStatus({ spinning, spin, lastResult, live }) {
  const el = $('wheelStatus');
  if (live) {
    FX.sound('win');
    FX.confettiAt($('wheel'), { count: 180 });
    setTimeout(() => FX.bump(el, 'fx-pop'), 0);
  }
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
  const runningId = running >= 0 ? items[running].id : null;
  const prevRunning = FX.track('schedule-running', runningId);
  $('schedule').innerHTML = items.length
    ? items.map((item, i) => {
        const cls = i === running ? 'now' : i < running ? 'past' : i === running + 1 ? 'next' : '';
        const badge = i === running ? '<span class="badge">läuft</span>' : i === running + 1 ? '<span class="badge alt">als Nächstes</span>' : '';
        return `<li class="${cls}"><time>${formatTime(item.time)}</time><div><strong>${esc(item.title)}</strong>${badge}${item.note ? `<p>${esc(item.note)}</p>` : ''}</div></li>`;
      }).join('')
    : '<li class="empty">Noch kein Zeitplan</li>';
  if (prevRunning !== undefined && runningId && prevRunning !== runningId) {
    FX.sound('chime');
    FX.bump($('schedule').querySelector('.now'), 'fx-glow');
  }
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

  renderLeaderboard(state.players);

  renderPolls(state.polls);
  if (me && hasFeature('abstimmungen')) loadMyVotes();

  renderServers(state.servers);
}

function renderLeaderboard(players) {
  const ranked = [...players].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name)).slice(0, 12);
  FX.flip($('leaderboard'), () => {
    $('leaderboard').innerHTML = ranked.length
      ? ranked.map((p, i) => `<li data-key="${esc(p.id)}"><span class="rank">${i + 1}</span><span class="name">${esc(p.name)}${p.seat ? ` <small>Platz ${esc(p.seat)}</small>` : ''}</span><span class="points">${p.points}</span></li>`).join('')
      : '<li class="empty">Noch keine Spieler</li>';
  });
  // Punkte, die sich geändert haben, hüpfen und zeigen die Differenz.
  let gained = false;
  for (const p of ranked) {
    const prev = FX.track('points-' + p.id, p.points);
    if (prev === undefined || prev === p.points) continue;
    const li = $('leaderboard').querySelector(`[data-key="${CSS.escape(p.id)}"]`);
    const pts = li && li.querySelector('.points');
    FX.bump(pts, 'fx-pop');
    FX.floatText(pts, `${p.points > prev ? '+' : ''}${p.points - prev}`, p.points > prev ? 'good' : 'bad');
    if (p.points > prev) gained = true;
  }
  if (gained) FX.sound('coin');
  const leader = ranked[0] && ranked[0].points > 0 ? ranked[0].id : null;
  const prevLeader = FX.track('leader', leader);
  if (prevLeader !== undefined && leader && prevLeader !== leader) {
    FX.bump($('leaderboard').firstElementChild, 'fx-glow');
    FX.sound('up');
  }
}

function renderServers(servers) {
  $('servers').innerHTML = servers.length
    ? servers.map((srv) => {
        const st = srv.status;
        const cls = !st ? 'unknown' : st.online ? 'online' : 'offline';
        const info = !st ? 'prüfe…' : st.online ? `${st.latency} ms` : 'offline';
        return `<li class="${cls}" data-key="${esc(srv.id)}"><span class="dot"></span><span class="name">${esc(srv.name)}</span><span class="addr">${esc(srv.host)}:${srv.port}</span><span class="info">${info}</span></li>`;
      }).join('')
    : '<li class="empty">Keine Server eingetragen</li>';
  // Server geht online/offline: kurz aufblinken lassen.
  for (const srv of servers) {
    const online = srv.status ? srv.status.online : null;
    const prev = FX.track('server-' + srv.id, online);
    if (prev === undefined || prev === null || online === null || prev === online) continue;
    FX.bump($('servers').querySelector(`[data-key="${CSS.escape(srv.id)}"]`), online ? 'fx-flash-ok' : 'fx-flash-bad');
    FX.sound(online ? 'up' : 'down');
  }
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
  FX.bars($('polls'), () => {
  $('polls').innerHTML = shown.length
    ? shown.map((p) => {
        const max = Math.max(1, ...p.options.map((o) => o.votes));
        const top = Math.max(...p.options.map((o) => o.votes));
        const voting = canVote && p.open;
        const options = p.options.map((o) => {
          const chosen = myVotes[p.id] === o.id;
          const won = !p.open && top > 0 && o.votes === top;
          const inner = `<span class="name">${won ? '👑 ' : chosen ? '✓ ' : ''}${esc(o.text)}</span><span class="bar"><span data-key="${esc(p.id)}-${esc(o.id)}" data-w="${(o.votes / max) * 100}"></span></span><span class="count" data-count="${esc(p.id)}-${esc(o.id)}">${o.votes}</span>`;
          return voting
            ? `<li><button class="vote-option ${chosen ? 'chosen' : ''}" data-poll="${esc(p.id)}" data-option="${esc(o.id)}" title="${chosen ? 'Stimme zurückziehen' : 'Dafür stimmen'}">${inner}</button></li>`
            : `<li class="${won ? 'winner' : ''}">${inner}</li>`;
        }).join('');
        return `<div class="poll ${p.open ? '' : 'closed'}" data-poll-card="${esc(p.id)}">
          <h3>${esc(p.question)} <small>${p.open ? `${p.total} ${p.total === 1 ? 'Stimme' : 'Stimmen'}` : 'Ergebnis'}</small></h3>
          <ul class="votes">${options}</ul>
        </div>`;
      }).join('')
    : '<p class="empty">Gerade läuft keine Abstimmung</p>';
  });
  animatePollChanges(polls);
}

// Neue Abstimmung, neue Stimmen und Abstimmungsende hör- und sichtbar machen.
function animatePollChanges(polls) {
  const known = FX.track('poll-ids', polls.map((p) => p.id));
  for (const p of polls) {
    const card = $('polls').querySelector(`[data-poll-card="${CSS.escape(p.id)}"]`);
    const wasOpen = FX.track('poll-open-' + p.id, p.open);
    if (known && !known.includes(p.id)) {
      FX.bump(card, 'fx-enter');
      FX.sound('chime');
    } else if (wasOpen === true && !p.open && card) {
      FX.bump(card, 'fx-glow');
      FX.confettiAt(card.querySelector('.winner') || card, { count: 90, spread: 0.6 });
      FX.sound('win');
    }
    for (const o of p.options) {
      const prev = FX.track(`votes-${p.id}-${o.id}`, o.votes);
      if (prev !== undefined && prev !== o.votes) {
        FX.bump($('polls').querySelector(`[data-count="${CSS.escape(p.id + '-' + o.id)}"]`), 'fx-pop');
      }
    }
  }
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
  FX.bump(btn, 'fx-press');
  FX.sound(optionId ? 'vote' : 'unvote');
  const res = await fetch(`/api/polls/${poll}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ optionId }),
  });
  if (res.ok) loadMyVotes();
  else FX.sound('error');
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
  const known = FX.track('entry-ids', w.entries.map((e) => e.id));
  $('entries').innerHTML = w.entries.length
    ? w.entries.map((e) => {
        const canDelete = me.isAdmin || (hasFeature('gluecksrad') && e.ownerId === me.id && w.open);
        return `<li data-key="${esc(e.id)}"><span class="grow">${esc(e.text)} <small>von ${esc(e.owner)}</small></span>${canDelete ? `<button class="icon danger" data-entry="${esc(e.id)}" title="Entfernen">✕</button>` : ''}</li>`;
      }).join('')
    : '<li class="empty">Noch keine Einträge</li>';
  if (!known) return;
  const added = w.entries.filter((e) => !known.includes(e.id));
  for (const e of added) FX.bump($('entries').querySelector(`[data-key="${CSS.escape(e.id)}"]`), 'fx-enter');
  if (added.length) FX.sound('pop');
  else if (w.entries.length < known.length) FX.sound('remove');
}

function enterUserMode(user) {
  me = user;
  document.body.classList.add('user-mode');
  $('userBar').hidden = false;
  $('username').textContent = me.username;
  $('modeSwitch').hidden = !me.isAdmin;
  $('wheelSide').hidden = false;
  if (me.master) {
    // Abmelden vom Admin-Passwort: zurück in die Admin-Anmeldung.
    $('logout').addEventListener('click', (e) => {
      e.preventDefault();
      try { sessionStorage.removeItem('lanparty-admin'); } catch {}
      location.href = '/admin';
    });
  }
  // Das Glücksrad ist schon im Dashboard; die übrigen Features sind Platzhalter.
  const others = me.features.filter((f) => f.enabled && f.key !== 'gluecksrad' && f.key !== 'abstimmungen');
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
  if (!res.ok) {
    FX.sound('error');
    FX.bump($('wheelError'), 'fx-shake');
  }
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
  FX.sound('error');
  setTimeout(() => { $('toast').hidden = true; }, 8000);
  history.replaceState(null, '', '/');
}

fetch('/api/me', { headers: auth }).then(async (res) => {
  if (res.ok) enterUserMode(await res.json());
});

$('clock').before(FX.muteButton());

renderClock();
setInterval(renderClock, 1000);
// "läuft"/"als Nächstes" auch ohne neue Daten weiterschalten.
setInterval(() => current && renderSchedule(current.schedule), 30000);

subscribe(render, (ok) => {
  $('conn').textContent = ok ? '' : 'Verbindung unterbrochen…';
});
