# LAN-Party-Dashboard

Ein schlankes Dashboard für LAN-Partys, gebaut für den Raspberry Pi. Ein Bildschirm oder Beamer zeigt Zeitplan, Ankündigungen, Rangliste, die Abstimmung über das nächste Spiel und den Status der Spieleserver. Alles aktualisiert sich live, sobald jemand im Admin-Bereich etwas ändert.

| Seite | Wofür |
|---|---|
| `http://<pi>:8080/` | Anzeige für TV/Beamer (16:9, Vollbild) |
| `http://<pi>:8080/vote` | Abstimmung per Handy, eine Stimme pro Gerät |
| `http://<pi>:8080/admin` | Verwaltung (passwortgeschützt) |
| `http://<pi>:8080/me` | Persönlicher Bereich eines Nutzers |

## Nutzerverwaltung

Im Admin-Bereich gibt es den Reiter **Nutzer**. Dort legst du Nutzer mit Nutzernamen an und schickst ihnen ihren persönlichen Link (`/login?token=…`). Wer den Link öffnet, ist auf diesem Gerät angemeldet und landet auf `/me`.

- **Admin**: Nutzer mit Admin-Haken kommen ohne Passwort in `/admin`. Das Master-Passwort aus `ADMIN_PASSWORD` funktioniert weiterhin.
- **Features**: Pro Nutzer schaltest du Glücksrad, Essensbestellung und Wishlist frei. Die Features sind noch Platzhalter; der Server prüft aber schon die Berechtigung (`/api/features/<name>`).
- **Neuer Link** macht den alten Link ungültig und meldet den Nutzer überall ab. **Löschen** entfernt den Nutzer samt Zugang.

## Warum dieser Stack

- **Node.js ohne eine einzige npm-Abhängigkeit.** Kein `npm install`, keine nativen Module, die auf ARM kompiliert werden müssten. Läuft auf jedem Pi ab Modell 3 (arm64 und armv7) mit rund 50 MB RAM.
- **Eine JSON-Datei als Speicher** (`data/state.json`). Schreibzugriffe werden gebündelt, das schont die SD-Karte. Backup heißt: Datei kopieren.
- **Server-Sent Events** für Live-Updates. Kein WebSocket-Framework nötig, der Browser verbindet sich nach WLAN-Aussetzern selbst neu.
- **Reines HTML/CSS/JS** im Frontend, kein Build-Schritt.

## Installation auf dem Pi

Du hast zwei Möglichkeiten. Docker ist am einfachsten, systemd am sparsamsten.

### Variante A: Docker

```sh
curl -sSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # danach einmal ab- und wieder anmelden

git clone https://github.com/schlosserbua112-wq/LanPartyDashboard.git
cd LanPartyDashboard
echo "ADMIN_PASSWORD=dein-geheimes-passwort" > .env
docker compose up -d --build
```

Das Dashboard startet danach bei jedem Booten automatisch.

### Variante B: systemd (ohne Docker)

```sh
sudo apt update && sudo apt install -y nodejs git
node --version   # muss 18 oder neuer sein

sudo git clone https://github.com/schlosserbua112-wq/LanPartyDashboard.git /opt/lanparty-dashboard
sudo chown -R pi:pi /opt/lanparty-dashboard
echo "ADMIN_PASSWORD=dein-geheimes-passwort" | sudo tee /etc/lanparty-dashboard.env
sudo chmod 600 /etc/lanparty-dashboard.env

sudo cp /opt/lanparty-dashboard/deploy/lanparty-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lanparty-dashboard
```

Heißt dein Benutzer nicht `pi`, passe `User=` in der Service-Datei an. Logs siehst du mit `journalctl -u lanparty-dashboard -f`.

### Bildschirm am Pi im Kiosk-Modus

Wenn der Pi selbst den Fernseher ansteuert (Raspberry Pi OS mit Desktop):

```sh
mkdir -p ~/.config/autostart
cat > ~/.config/autostart/lanparty-kiosk.desktop <<EOT
[Desktop Entry]
Type=Application
Name=LAN-Party Kiosk
Exec=/opt/lanparty-dashboard/deploy/kiosk.sh http://localhost:8080/
EOT
```

Bei der Docker-Variante den Pfad zu `kiosk.sh` entsprechend anpassen. Unter Wayland (Raspberry Pi OS Bookworm) den Bildschirmschoner zusätzlich in `raspi-config` unter *Display Options → Screen Blanking* abschalten.

## Konfiguration

| Variable | Standard | Bedeutung |
|---|---|---|
| `ADMIN_PASSWORD` | `lanparty` | Passwort für `/admin`. Unbedingt ändern! |
| `PORT` | `8080` | HTTP-Port |
| `DATA_DIR` | `./data` | Ordner für `state.json` |
| `SERVER_CHECK_INTERVAL` | `30` | Sekunden zwischen den Server-Checks |

## Hinweise

- Der Server-Status prüft per **TCP**, ob ein Port offen ist. Reine UDP-Server lassen sich so nicht prüfen; trage dafür einen TCP-Port desselben Hosts ein (z.B. RCON).
- Die Zeitangaben im Zeitplan richten sich nach der Uhr des Browsers, der die Anzeige darstellt.
- Lokal entwickeln: `npm run dev` (Node 18+), dann http://localhost:8080 öffnen.
