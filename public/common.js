'use strict';

// Gemeinsame Helfer für alle Seiten.

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Verbindet sich mit dem Live-Stream und ruft onState bei jeder Änderung auf.
// EventSource baut die Verbindung nach Abbrüchen selbst wieder auf.
function subscribe(onState, onStatus) {
  const source = new EventSource('/api/events');
  source.onmessage = (e) => onState(JSON.parse(e.data));
  source.onopen = () => onStatus && onStatus(true);
  source.onerror = () => onStatus && onStatus(false);
  return source;
}

// "2026-10-24T18:00" oder "18:00" -> Date (heute) bzw. null
function parseTime(value) {
  if (!value) return null;
  if (/^\d{1,2}:\d{2}$/.test(value)) {
    const [h, m] = value.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatTime(value) {
  const d = parseTime(value);
  if (!d) return esc(value);
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const today = new Date().toDateString() === d.toDateString();
  return today ? time : `${d.toLocaleDateString('de-DE', { weekday: 'short' })} ${time}`;
}
