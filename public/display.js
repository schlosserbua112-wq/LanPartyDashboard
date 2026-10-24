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
const music = createMusic({ auth });

// Ohne Anmeldung (TV) wechselt das Leaderboard selbst zwischen den Spielen.
const leaderboard = createLeaderboard(
  { list: $('leaderboard'), tabs: $('lbTabs'), feed: $('lbFeed') },
  { limit: 8, feed: 3, rotate: true },
);
const tournaments = createTournaments({
  el: $('tournament'),
  mode: 'tv',
  headers: () => auth,
  getMe: () => me && { id: me.id, isAdmin: me.isAdmin, master: me.master, canPlay: hasFeature('turniere') },
});

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

function render(state) {
  current = state;
  const s = state.settings;
  document.title = s.eventName || 'LAN-Party';
  $('eventName').textContent = s.eventName || 'LAN-Party';
  $('wifi').innerHTML = s.wifiSsid
    ? `WLAN <strong>${esc(s.wifiSsid)}</strong>${s.wifiPassword ? ` · Passwort <strong>${esc(s.wifiPassword)}</strong>` : ''}`
    : '';
  $('wheelOpen').textContent = state.wheel.open ? 'Einträge offen' : 'Eingabe geschlossen';
  if (me) renderWheelSide(state.wheel);
  wheel.update(state.wheel);

  leaderboard.update(state.leaderboard);

  NetUI.renderTests(state.netTests);
  renderPolls(state.polls);

  const hasTournament = state.tournaments.length > 0;
  $('tournamentCard').hidden = !hasTournament;
  document.body.classList.toggle('has-tournament', hasTournament);
  tournaments.update(state.tournaments);
  if (me && hasFeature('abstimmungen')) loadMyVotes();
  if (me && hasFeature('spiele')) steamMatrix.onRev(state.steamRev);

  achievementNotifier.update(state.achievements);
  if (me) loadAchievements();

  teamReveal.update(state.teams.result);
  if (me && hasFeature('teams')) renderTeams(state.teams);

  music.render(state.music);
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

// --- Achievements ------------------------------------------------------------

// TV-Anzeige: jede Freischaltung groß. Angemeldet: die eigenen groß, fremde klein.
const achievementNotifier = createAchievementNotifier({
  big: (unlock) => (!me ? 'big' : unlock.userId === me.id ? 'own' : 'toast'),
});
let achProgress = {};

function renderAchievements(data) {
  const mine = data.unlocks.filter((u) => u.userId === me.id);
  const points = data.ranking.find((r) => r.userId === me.id)?.points || 0;
  $('achSummary').textContent = `${mine.length} / ${data.defs.length} · ${points} Punkte`;
  $('achGrid').innerHTML = renderAchievementTiles(data, me.id, achProgress);
  $('achRanking').innerHTML = data.ranking.length
    ? data.ranking.slice(0, 8).map((r, i) => `<li class="${r.userId === me.id ? 'me' : ''}"><span class="rank">${i + 1}</span><span class="name">${esc(r.username)} <small>${r.count} 🏅</small></span><span class="points">${r.points}</span></li>`).join('')
    : '<li class="empty">Noch niemand</li>';
  $('achFeed').innerHTML = data.unlocks.length
    ? data.unlocks.slice(0, 6).map((u) => {
        const d = data.defs.find((x) => x.id === u.achId);
        return d ? `<li style="--rarity:${RARITY_COLORS[d.rarity]}"><span class="ach-feed-icon">${esc(d.icon)}</span><span class="grow"><strong>${esc(u.username)}</strong> · ${esc(d.name)}</span></li>` : '';
      }).join('')
    : '<li class="empty">Noch nichts freigeschaltet</li>';
}

async function loadAchievements() {
  const res = await fetch('/api/achievements/mine', { headers: auth });
  if (!res.ok) return;
  achProgress = (await res.json()).progress;
  if (current) renderAchievements(current.achievements);
}

// --- Team-Generator ----------------------------------------------------------

// Auf dem Fernseher bleibt das Ergebnis länger stehen.
const teamReveal = createTeamReveal({ hold: () => (me ? 9000 : 30000) });
$('teamForm').elements.teamCount.innerHTML = [2, 3, 4, 5, 6, 7, 8].map((n) => `<option>${n}</option>`).join('');

function renderTeams(t) {
  const inPool = t.pool.some((p) => p.userId === me.id);
  const canGenerate = me.isAdmin || t.usersCanGenerate;
  $('teamPoolCount').textContent = `(${t.pool.length} dabei)`;
  $('teamJoin').hidden = me.master;
  $('teamJoin').textContent = inPool ? 'Ich bin raus' : 'Ich bin dabei!';
  $('teamJoin').className = inPool ? 'secondary' : '';
  $('teamPool').innerHTML = t.pool.length
    ? t.pool.map((p) => `<li class="${p.userId === me.id ? 'me' : ''}">${esc(p.name)}</li>`).join('')
    : '<li class="empty">Noch niemand dabei</li>';
  const form = $('teamForm');
  form.hidden = !canGenerate;
  $('teamLocked').hidden = canGenerate;
  // Nicht überschreiben, während jemand die Auswahl ändert.
  if (!form.contains(document.activeElement)) {
    form.elements.teamCount.value = String(t.teamCount);
    form.elements.balanced.checked = t.balanced;
  }
  $('teamGenerate').disabled = t.pool.length < 2 || teamReveal.isRunning();
  const r = t.result;
  $('teamResult').innerHTML = !r
    ? '<p class="empty">Noch keine Teams ausgelost</p>'
    : r.age < r.duration
      ? '<p class="empty">Die Teams werden gerade ausgelost…</p>'
      : teamColumnsHtml(r);
  // Nach der Show das fertige Ergebnis zeigen.
  clearTimeout(renderTeams.timer);
  if (r && r.age < r.duration) renderTeams.timer = setTimeout(() => current && renderTeams(current.teams), r.duration - r.age + 50);
}

async function teamsApi(url, body) {
  const res = await fetch('/api/teams/' + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  $('teamError').textContent = res.ok ? '' : data.error || 'Fehler';
}

$('teamJoin').addEventListener('click', () => {
  const inPool = current.teams.pool.some((p) => p.userId === me.id);
  teamsApi(inPool ? 'leave' : 'join');
});

$('teamForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.elements;
  teamsApi('generate', { teamCount: Number(f.teamCount.value), balanced: f.balanced.checked });
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
  leaderboard.setUser(me.master ? null : me.id, { rotate: false, limit: 12, feed: 5 });
  $('achievementsCard').hidden = me.master;
  $('teamsCard').hidden = !hasFeature('teams');
  if (me.master) {
    // Abmelden vom Admin-Passwort: zurück in die Admin-Anmeldung.
    $('logout').addEventListener('click', (e) => {
      e.preventDefault();
      try { sessionStorage.removeItem('lanparty-admin'); } catch {}
      location.href = '/admin';
    });
  }
  // Das Glücksrad ist schon im Dashboard; die übrigen Features sind Platzhalter.
  music.enterUserMode(me, hasFeature('musik'));
  const others = me.features.filter((f) => f.enabled && !['gluecksrad', 'abstimmungen', 'turniere', 'teams', 'musik', 'spiele', 'netzwerk'].includes(f.key));
  $('featuresCard').hidden = !others.length;
  document.body.classList.toggle('no-features', !others.length);
  $('features').innerHTML = others.map((f) => `<li><strong>${esc(f.label)}</strong><small>kommt bald</small></li>`).join('');
  tournaments.setMode('user');
  if (hasFeature('spiele')) steamMatrix.start();
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

subscribe(render, (ok) => {
  $('conn').textContent = ok ? '' : 'Verbindung unterbrochen…';
});
