'use strict';

// Zeichnet das Glücksrad auf ein <canvas> und spielt Drehungen ab.
// Jede Anzeige rechnet die Animation aus denselben Server-Werten (Gewinner,
// Versatz, Alter der Drehung) und landet deshalb auf demselben Feld.

const WHEEL_COLORS = ['#38e1ff', '#b16cff', '#ffc857', '#3ddc84', '#ff5c7a', '#5b8cff', '#ff9f43', '#2ee6c5'];
const FULL_TURNS = 8;

function createWheel(canvas, onStatus) {
  let entries = [];
  let rotation = 0;
  let anim = null;
  let shownSpinId = null;

  const easeOut = (t) => 1 - Math.pow(1 - t, 4);

  function targetRotation(spin) {
    const seg = (Math.PI * 2) / spin.entries.length;
    // Mitte des Gewinnerfelds (plus Versatz) soll unter dem Zeiger oben stehen.
    const angle = -Math.PI / 2 - (spin.winnerIndex + 0.5 + spin.offset) * seg;
    const norm = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return FULL_TURNS * Math.PI * 2 + norm;
  }

  function fitText(ctx, text, max) {
    if (ctx.measureText(text).width <= max) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
    return t + '…';
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const size = Math.floor(Math.min(w, h));
    if (!size) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // Das Rad sitzt mittig im Canvas.
    ctx.translate((w - size) / 2, (h - size) / 2);
    const c = size / 2;
    const r = c - Math.max(10, size * 0.05);

    ctx.save();
    ctx.translate(c, c);
    if (!entries.length) {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = '#1c2440';
      ctx.fill();
      ctx.fillStyle = '#8a94b3';
      ctx.font = `${Math.max(12, size * 0.05)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Noch keine Einträge', 0, 0);
    } else {
      const seg = (Math.PI * 2) / entries.length;
      ctx.rotate(rotation);
      const fontSize = Math.max(10, Math.min(size * 0.055, (seg * r) / 2.2));
      ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
      entries.forEach((entry, i) => {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, r, i * seg, (i + 1) * seg);
        ctx.closePath();
        // Bei ungerader Anzahl würden erstes und letztes Feld gleich gefärbt.
        let color = WHEEL_COLORS[i % WHEEL_COLORS.length];
        if (i === entries.length - 1 && i % WHEEL_COLORS.length === 0 && i > 0) color = WHEEL_COLORS[3];
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#0b0f1a';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.save();
        ctx.rotate((i + 0.5) * seg);
        ctx.fillStyle = '#0b0f1a';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        // Etwas Abstand zum Rand, damit der Zeiger den Text nicht verdeckt.
        const inset = Math.max(14, size * 0.075);
        ctx.fillText(fitText(ctx, entry.text, r - inset - size * 0.08), r - inset, 0);
        ctx.restore();
      });
    }
    ctx.restore();

    // Nabe
    ctx.beginPath();
    ctx.arc(c, c, Math.max(8, size * 0.06), 0, Math.PI * 2);
    ctx.fillStyle = '#0b0f1a';
    ctx.fill();
    ctx.strokeStyle = '#e8ecf8';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Zeiger oben
    const p = Math.max(10, size * 0.045);
    ctx.beginPath();
    ctx.moveTo(c - p, c - r - p * 0.9);
    ctx.lineTo(c + p, c - r - p * 0.9);
    ctx.lineTo(c, c - r + p * 1.2);
    ctx.closePath();
    ctx.fillStyle = '#e8ecf8';
    ctx.fill();
    ctx.strokeStyle = '#0b0f1a';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function frame() {
    if (!anim) return;
    const t = Math.min(1, (performance.now() - anim.start) / anim.duration);
    rotation = anim.target * easeOut(t);
    draw();
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      const spin = anim.spin;
      anim = null;
      onStatus && onStatus({ spinning: false, spin });
    }
  }

  function sameEntries(a, b) {
    return a.length === b.length && a.every((e, i) => e.id === b[i].id);
  }

  // Wird bei jedem neuen Zustand vom Server aufgerufen.
  function update(wheel) {
    const spin = wheel.spin;
    if (anim) return; // Laufende Drehung nicht unterbrechen.
    if (spin && sameEntries(spin.entries, wheel.entries)) {
      entries = spin.entries;
      if (spin.id !== shownSpinId && spin.age < spin.duration) {
        shownSpinId = spin.id;
        anim = { spin, target: targetRotation(spin), duration: spin.duration, start: performance.now() - spin.age };
        onStatus && onStatus({ spinning: true, spin });
        requestAnimationFrame(frame);
        return;
      }
      shownSpinId = spin.id;
      rotation = targetRotation(spin);
      onStatus && onStatus({ spinning: false, spin });
    } else {
      entries = wheel.entries;
      rotation = 0;
      onStatus && onStatus({ spinning: false, spin: null, lastResult: spin ? spin.result : null });
    }
    draw();
  }

  // Neu zeichnen, sobald sich die Größe ändert (Fenster, Reiterwechsel, Layout).
  if (window.ResizeObserver) new ResizeObserver(() => { if (!anim) draw(); }).observe(canvas);
  else window.addEventListener('resize', draw);
  return { update, redraw: draw };
}
