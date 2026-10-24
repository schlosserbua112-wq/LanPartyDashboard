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
  // Netzwerk-Messwerte kommen als eigenes Ereignis, damit nicht jedes Mal alles neu gesendet wird.
  source.addEventListener('net', (e) => window.dispatchEvent(new CustomEvent('lp:net', { detail: JSON.parse(e.data) })));
  source.onopen = () => onStatus && onStatus(true);
  source.onerror = () => onStatus && onStatus(false);
  return source;
}

// Leertaste löst eine Aktion aus, außer jemand tippt gerade in ein Feld.
function onSpaceKey(action) {
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    if (e.target.closest('input, textarea, button, select')) return;
    e.preventDefault();
    action();
  });
}
