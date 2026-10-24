#!/bin/sh
# Startet Chromium im Vollbild auf dem am Pi angeschlossenen Bildschirm.
# Aufruf aus dem Autostart der Desktop-Sitzung (siehe README).
URL="${1:-http://localhost:8080/}"

# Bildschirmschoner und Energiesparen abschalten (X11; unter Wayland wirkungslos)
xset s off 2>/dev/null
xset -dpms 2>/dev/null
xset s noblank 2>/dev/null

# Warten, bis das Dashboard antwortet
until wget -qO- "${URL%/}/api/health" >/dev/null 2>&1; do sleep 2; done

BROWSER=$(command -v chromium-browser || command -v chromium)
exec "$BROWSER" --kiosk --noerrdialogs --disable-infobars --incognito \
  --disable-session-crashed-bubble --autoplay-policy=no-user-gesture-required --check-for-update-interval=31536000 "$URL"
