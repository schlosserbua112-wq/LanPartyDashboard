# LAN-Party-Dashboard

Ein schlankes Dashboard für LAN-Partys, gebaut für den Raspberry Pi. Ein Bildschirm oder Beamer zeigt Zeitplan, Glücksrad, das globale Leaderboard, laufende Abstimmungen und den Status der Spieleserver. Alles aktualisiert sich live, sobald jemand im Admin-Bereich etwas ändert.

| Seite | Wofür |
|---|---|
| `http://<pi>:8080/` | Dashboard: ohne Anmeldung TV-/Beamer-Anzeige, mit Anmeldung bedienen Nutzer hier ihre Features |
| `http://<pi>:8080/admin` | Verwaltung (passwortgeschützt) |

## Nutzerverwaltung

Im Admin-Bereich gibt es den Reiter **Nutzer**. Dort legst du Nutzer mit Nutzernamen an und schickst ihnen ihren persönlichen Link (`/login?token=…`). Wer den Link öffnet, ist auf diesem Gerät angemeldet und sieht im Dashboard seine Features.

- **Admin**: Nutzer mit Admin-Haken kommen ohne Passwort in `/admin`. Das Master-Passwort aus `ADMIN_PASSWORD` funktioniert weiterhin.
- **Features**: Pro Nutzer schaltest du Glücksrad, Abstimmungen, Turniere, Essensbestellung und Wishlist frei. Essensbestellung und Wishlist sind noch Platzhalter.

## Abstimmungen

- Im Admin-Reiter **Abstimmungen** legst du Umfragen mit Frage und Antworten an, beendest sie, öffnest sie wieder, setzt Stimmen zurück oder löschst sie.
- Nutzer mit dem Feature „Abstimmungen“ stimmen direkt im Dashboard ab: eine Stimme pro Umfrage, änderbar solange sie läuft. Nochmal auf die eigene Antwort klicken zieht die Stimme zurück.
- Die TV-Anzeige zeigt alle laufenden Umfragen und das Ergebnis der zuletzt beendeten. Wer wofür gestimmt hat, ist nicht öffentlich.

## Globales Leaderboard

- Eine Rangliste über alle Spiele der LAN-Party. Jeder Nutzer bekommt automatisch einen Spieler; Gäste ohne Anmeldung legst du im Admin-Reiter **Leaderboard** an und kannst sie später mit einem Nutzer verknüpfen.
- Punkte vergibst du dort an einen oder mehrere Spieler gleichzeitig (z.B. das ganze Siegerteam), mit Grund und optional einem Spiel. Jede Vergabe steht im **Verlauf** und lässt sich einzeln zurücknehmen. Gleiche Punktzahl heißt gleicher Platz.
- Mit Spielangabe gibt es zusätzlich eine Wertung pro Spiel. Die TV-Anzeige wechselt alle 12 Sekunden zwischen Gesamt und den einzelnen Spielen, angemeldete Nutzer wählen per Klick und sehen ihre eigene Zeile hervorgehoben.
- Animationen und Sounds: Plätze tauschen sichtbar die Position, Punkte zählen hoch, neue Vergaben erscheinen im Live-Feed, und eine neue Führung wird mit Konfetti und Fanfare gefeiert. Den Ton schaltet 🔊 im Leaderboard ab. Browser spielen Ton erst nach dem ersten Klick ab; der Kiosk-Modus (`deploy/kiosk.sh`) erlaubt ihn von Anfang an.
- Für spätere Features (Turniere, Achievements) gibt es im Server `awardPoints({ userId | playerId, points, reason, game, source, refId })` und `revokeScores(refId)`.

## Turniere

- Im Admin-Reiter **Turniere** legst du ein Turnier an: Name, Spiel und Modus (**K.-o.-System** oder **Jeder gegen jeden**). Teilnehmer trägst du als Nutzer oder als freie Namen bzw. Teams ein.
- Ist „Nutzer dürfen sich selbst anmelden“ an, melden sich Nutzer mit dem Feature „Turniere“ im Dashboard mit „Ich bin dabei!“ an.
- **Auslosen & starten** lost den Turnierbaum zufällig aus. Fehlen Spieler für einen vollen Baum, bekommen einzelne ein Freilos und sind direkt in der nächsten Runde.
- Ergebnisse tragen Admins und die beiden Spieler eines Spiels ein (Klick aufs Spiel). Im K.-o.-System reicht der Sieger, der Spielstand ist optional. Bei „Jeder gegen jeden“ gibt es 3 Punkte für einen Sieg und 1 für ein Unentschieden.
- Wird ein Ergebnis geändert, setzt das K.-o.-System alle darauf aufbauenden Spiele zurück. „Zurück zur Anmeldung“ verwirft den Spielplan.
- Ist ein Turnier beendet, bucht es Punkte ins globale Leaderboard: 25 für den Sieger, 15 für Platz 2 und 10 für Platz 3 (im K.-o.-System beide Halbfinal-Verlierer), mit dem Spiel des Turniers für die Wertung pro Spiel. Ändert sich das Ergebnis oder wird das Turnier gelöscht, werden die Punkte neu gebucht bzw. zurückgenommen. Freie Teilnehmer ohne Nutzer bekommen Punkte nur, wenn es im Leaderboard einen gleichnamigen Spieler gibt.
- TV-Anzeige und Dashboard zeigen laufende Turniere live, mehrere wechseln auf dem TV alle 20 Sekunden. Neue Ergebnisse leuchten auf, der Turniersieger wird mit Konfetti und Fanfare gefeiert. Der Ton lässt sich über 🔊 in der Turnierkarte abschalten.

## Glücksrad

- Nutzer mit dem Feature „Glücksrad“ tragen im Dashboard Einträge ein und entfernen ihre eigenen (max. 10 pro Nutzer, 60 insgesamt).
- Im Admin-Reiter **Glücksrad** stoppst du die Eingabe, legst fest, wer drehen darf, entfernst Einträge oder leerst das Rad. Admins dürfen immer drehen.
- Beim Drehen lost der Server den Gewinner aus. TV-Anzeige, Nutzerseiten und Admin-Seite drehen synchron und landen auf demselben Feld.
- **Umschalter Admin-Modus / Nutzermodus**: Admins wechseln oben zwischen `/admin` und dem Dashboard. Wer mit dem Master-Passwort angemeldet ist, sieht im Nutzermodus alle Features.
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
