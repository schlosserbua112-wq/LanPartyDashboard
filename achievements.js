'use strict';

// Achievement-System: feste Erfolge, die sich beim Mitmachen von selbst
// freischalten, dazu Erfolge, die der Admin von Hand vergibt (auch eigene).

const crypto = require('node:crypto');

const RARITIES = {
  common: { label: 'Gewöhnlich', points: 10 },
  rare: { label: 'Selten', points: 25 },
  epic: { label: 'Episch', points: 50 },
  legendary: { label: 'Legendär', points: 100 },
};

// stat + goal: schaltet frei, sobald der Zähler das Ziel erreicht.
const BUILTIN = [
  { id: 'eingecheckt', icon: '👋', name: 'Eingecheckt', description: 'Zum ersten Mal mit deinem Link angemeldet.', rarity: 'common' },
  { id: 'demokrat', icon: '🗳️', name: 'Demokrat', description: 'Bei einer Abstimmung mitgestimmt.', rarity: 'common', stat: 'polls', goal: 1 },
  { id: 'stimme-des-volkes', icon: '📢', name: 'Stimme des Volkes', description: 'Bei 5 Abstimmungen mitgestimmt.', rarity: 'rare', stat: 'polls', goal: 5 },
  { id: 'trendsetter', icon: '🎯', name: 'Trendsetter', description: 'Für die Gewinner-Antwort einer Abstimmung gestimmt.', rarity: 'rare' },
  { id: 'ideengeber', icon: '✍️', name: 'Ideengeber', description: 'Einen Eintrag aufs Glücksrad gesetzt.', rarity: 'common', stat: 'entries', goal: 1 },
  { id: 'wunschzettel', icon: '📝', name: 'Wunschzettel', description: '10 Einträge aufs Glücksrad gesetzt.', rarity: 'rare', stat: 'entries', goal: 10 },
  { id: 'schicksalsdreher', icon: '🎡', name: 'Schicksalsdreher', description: 'Das Glücksrad gedreht.', rarity: 'rare', stat: 'spins', goal: 1 },
  { id: 'glueckspilz', icon: '🍀', name: 'Glückspilz', description: 'Dein Eintrag hat beim Glücksrad gewonnen.', rarity: 'epic' },
  { id: 'nachteule', icon: '🦉', name: 'Nachteule', description: 'Zwischen 3 und 5 Uhr nachts noch dabei gewesen.', rarity: 'epic' },
  { id: 'sammler', icon: '🏆', name: 'Sammler', description: '5 andere Achievements freigeschaltet.', rarity: 'legendary', stat: 'unlocked', goal: 5 },
  // Vergibt der Admin von Hand.
  { id: 'mvp', icon: '⭐', name: 'MVP', description: 'Der wertvollste Spieler der Runde.', rarity: 'epic', manual: true },
  { id: 'clutch', icon: '🔥', name: 'Clutch-König', description: 'Die Runde im letzten Moment gedreht.', rarity: 'epic', manual: true },
  { id: 'turniersieger', icon: '👑', name: 'Turniersieger', description: 'Ein Turnier gewonnen.', rarity: 'legendary', manual: true },
  { id: 'teamplayer', icon: '🤝', name: 'Teamplayer', description: 'Hat dem Team den Rücken freigehalten.', rarity: 'rare', manual: true },
  { id: 'pizza-held', icon: '🍕', name: 'Pizza-Held', description: 'Hat für Essen gesorgt.', rarity: 'rare', manual: true },
  { id: 'rage-quit', icon: '💢', name: 'Rage Quit', description: 'Den Controller (fast) in die Ecke geworfen.', rarity: 'common', manual: true },
];

const NIGHT_HOURS = [3, 4]; // 3:00 bis 4:59 Uhr
const MAX_CUSTOM = 50;

function emptyAchievements() {
  return { custom: [], unlocks: [], stats: {} };
}

function str(max) {
  return (v) => String(v ?? '').trim().slice(0, max);
}

// onUnlock wird nach jeder Freischaltung aufgerufen (speichern und senden).
function createAchievements(getState, onUnlock) {
  const data = () => getState().achievements;

  function defs() {
    return [...BUILTIN, ...data().custom.map((c) => ({ ...c, manual: true, custom: true }))];
  }

  const findDef = (id) => defs().find((d) => d.id === id);

  function has(userId, achId) {
    return data().unlocks.some((u) => u.userId === userId && u.achId === achId);
  }

  function statsOf(userId) {
    const all = data().stats;
    if (!all[userId]) all[userId] = { polls: [], entries: 0, spins: 0 };
    return all[userId];
  }

  function statValue(userId, stat) {
    if (stat === 'unlocked') return data().unlocks.filter((u) => u.userId === userId && u.achId !== 'sammler').length;
    const s = data().stats[userId];
    if (!s) return 0;
    return stat === 'polls' ? s.polls.length : s[stat] || 0;
  }

  function unlock(user, achId, by) {
    if (!user || user.master || has(user.id, achId) || !findDef(achId)) return null;
    const entry = { id: crypto.randomUUID(), achId, userId: user.id, at: Date.now() };
    if (by) entry.by = by;
    data().unlocks.push(entry);
    // Zählt für den Sammler mit.
    if (achId !== 'sammler' && statValue(user.id, 'unlocked') >= 5) unlock(user, 'sammler');
    onUnlock(entry);
    return entry;
  }

  function checkGoals(user) {
    for (const def of BUILTIN) {
      if (def.stat && def.stat !== 'unlocked' && statValue(user.id, def.stat) >= def.goal) unlock(user, def.id);
    }
  }

  // Ereignisse aus dem Rest der App. Der Master-Admin sammelt nichts.
  function track(user, event, info = {}) {
    if (!user || user.master) return;
    const hour = new Date().getHours();
    if (NIGHT_HOURS.includes(hour)) unlock(user, 'nachteule');

    const stats = statsOf(user.id);
    // Erst beim Laden des Dashboards, damit das Popup dort zu sehen ist.
    if (event === 'visit') unlock(user, 'eingecheckt');
    if (event === 'vote' && !stats.polls.includes(info.pollId)) stats.polls.push(info.pollId);
    if (event === 'entry') stats.entries++;
    if (event === 'spin') stats.spins++;
    checkGoals(user);
  }

  // Beim Beenden einer Abstimmung: wer für die (geteilte) Spitze gestimmt hat.
  function pollClosed(poll, users) {
    const counts = {};
    for (const optionId of Object.values(poll.votes)) counts[optionId] = (counts[optionId] || 0) + 1;
    const max = Math.max(0, ...Object.values(counts));
    if (max === 0) return;
    for (const [userId, optionId] of Object.entries(poll.votes)) {
      if (counts[optionId] === max) unlock(users.find((u) => u.id === userId), 'trendsetter');
    }
  }

  function wheelWon(user) {
    unlock(user, 'glueckspilz');
  }

  function removeUser(userId) {
    const d = data();
    d.unlocks = d.unlocks.filter((u) => u.userId !== userId);
    delete d.stats[userId];
  }

  function pointsOf(userId) {
    return data().unlocks
      .filter((u) => u.userId === userId)
      .reduce((sum, u) => sum + (RARITIES[findDef(u.achId)?.rarity]?.points || 0), 0);
  }

  function defView(d) {
    return {
      id: d.id,
      icon: d.icon,
      name: d.name,
      description: d.description,
      rarity: d.rarity,
      points: RARITIES[d.rarity].points,
      manual: Boolean(d.manual),
      custom: Boolean(d.custom),
      goal: d.goal || null,
    };
  }

  // Für alle sichtbar: Erfolge, wer was hat, Punktestand.
  function publicView(users) {
    const names = Object.fromEntries(users.map((u) => [u.id, u.username]));
    const unlocks = data().unlocks
      .filter((u) => names[u.userId])
      .sort((a, b) => b.at - a.at)
      .map((u) => ({ ...u, username: names[u.userId] }));
    return {
      rarities: RARITIES,
      defs: defs().map(defView),
      unlocks,
      ranking: users
        .map((u) => ({ userId: u.id, username: u.username, points: pointsOf(u.id), count: unlocks.filter((x) => x.userId === u.id).length }))
        .filter((r) => r.count)
        .sort((a, b) => b.points - a.points || a.username.localeCompare(b.username)),
    };
  }

  // Fortschritt bei Erfolgen mit Ziel, nur für den Nutzer selbst.
  function progressOf(userId) {
    const out = {};
    for (const def of BUILTIN) if (def.goal) out[def.id] = Math.min(def.goal, statValue(userId, def.stat));
    return out;
  }

  function addCustom(body) {
    const name = str(40)(body.name);
    if (!name) throw Object.assign(new Error('Name fehlt'), { status: 400 });
    if (data().custom.length >= MAX_CUSTOM) throw Object.assign(new Error(`Höchstens ${MAX_CUSTOM} eigene Achievements`), { status: 409 });
    const def = {
      id: 'eigen-' + crypto.randomUUID(),
      icon: [...str(16)(body.icon)].slice(0, 2).join('') || '🏅',
      name,
      description: str(120)(body.description),
      rarity: RARITIES[body.rarity] ? body.rarity : 'common',
    };
    data().custom.push(def);
    return defView({ ...def, manual: true, custom: true });
  }

  function removeCustom(id) {
    const d = data();
    const index = d.custom.findIndex((c) => c.id === id);
    if (index === -1) return false;
    d.custom.splice(index, 1);
    d.unlocks = d.unlocks.filter((u) => u.achId !== id);
    return true;
  }

  function revoke(unlockId) {
    const d = data();
    const index = d.unlocks.findIndex((u) => u.id === unlockId);
    if (index === -1) return false;
    d.unlocks.splice(index, 1);
    return true;
  }

  return { track, unlock, pollClosed, wheelWon, removeUser, publicView, progressOf, findDef, addCustom, removeCustom, revoke };
}

module.exports = { createAchievements, emptyAchievements, RARITIES };
