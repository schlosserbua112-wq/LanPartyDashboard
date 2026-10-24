# LAN-Party-Dashboard

Ein schlankes Dashboard für LAN-Partys, gebaut für den Raspberry Pi. Ein Bildschirm oder Beamer zeigt Glücksrad, das globale Leaderboard, laufende Abstimmungen und Turniere sowie den Zustand des Netzwerks. Alles aktualisiert sich live, sobald jemand im Admin-Bereich etwas ändert.

| Seite | Wofür |
|---|---|
| `http://<pi>:8080/` | Dashboard: ohne Anmeldung TV-/Beamer-Anzeige, mit Anmeldung bedienen Nutzer hier ihre Features |
| `http://<pi>:8080/admin` | Verwaltung (passwortgeschützt) |

## Nutzerverwaltung

Im Admin-Bereich gibt es den Reiter **Nutzer**. Dort legst du Nutzer mit Nutzernamen an und schickst ihnen ihren persönlichen Link (`/login?token=…`). Wer den Link öffnet, ist auf diesem Gerät angemeldet und sieht im Dashboard seine Features.

- **Admin**: Nutzer mit Admin-Haken kommen ohne Passwort in `/admin`. Das Master-Passwort aus `ADMIN_PASSWORD` funktioniert weiterhin.
- **Features**: Pro Nutzer schaltest du Glücksrad, Abstimmungen, Turniere, Team-Generator, Musik, Spiele-Matrix, Verbindungstest, Essensbestellung und Wishlist frei. Essensbestellung und Wishlist sind noch Platzhalter.

## Abstimmungen

- Im Admin-Reiter **Abstimmungen** legst du Umfragen mit Frage und Antworten an, beendest sie, öffnest sie wieder, setzt Stimmen zurück oder löschst sie.
- Nutzer mit dem Feature „Abstimmungen“ stimmen direkt im Dashboard ab: eine Stimme pro Umfrage, änderbar solange sie läuft. Nochmal auf die eigene Antwort klicken zieht die Stimme zurück.
- Die TV-Anzeige zeigt alle laufenden Umfragen und das Ergebnis der zuletzt beendeten. Wer wofür gestimmt hat, ist nicht öffentlich.

## Globales Leaderboard

- Eine Rangliste über alle Spiele der LAN-Party. Jeder Nutzer bekommt automatisch einen Spieler; Gäste ohne Anmeldung legst du im Admin-Reiter **Leaderboard** an und kannst sie später mit einem Nutzer verknüpfen.
- Punkte vergibst du dort an einen oder mehrere Spieler gleichzeitig (z.B. das ganze Siegerteam), mit Grund und optional einem Spiel. Jede Vergabe steht im **Verlauf** und lässt sich einzeln zurücknehmen. Gleiche Punktzahl heißt gleicher Platz.
- Mit Spielangabe gibt es zusätzlich eine Wertung pro Spiel. Die TV-Anzeige wechselt alle 12 Sekunden zwischen Gesamt und den einzelnen Spielen, angemeldete Nutzer wählen per Klick und sehen ihre eigene Zeile hervorgehoben.
- Animationen und Sounds: Plätze tauschen sichtbar die Position, Punkte zählen hoch, neue Vergaben erscheinen im Live-Feed, und eine neue Führung wird mit Konfetti und Fanfare gefeiert. Den Ton schaltet der 🔊-Knopf oben (Taste **M**) für alle Effekte ab. Browser spielen Ton erst nach dem ersten Klick ab; der Kiosk-Modus (`deploy/kiosk.sh`) erlaubt ihn von Anfang an.
- Turniere und Achievements buchen ihre Punkte über `awardPoints({ userId | playerId, points, reason, game, source, refId })` im Server und nehmen sie mit `revokeScores(refId)` zurück.

## Turniere

- Im Admin-Reiter **Turniere** legst du ein Turnier an: Name, Spiel und Modus (**K.-o.-System** oder **Jeder gegen jeden**). Teilnehmer trägst du als Nutzer oder als freie Namen bzw. Teams ein.
- Ist „Nutzer dürfen sich selbst anmelden“ an, melden sich Nutzer mit dem Feature „Turniere“ im Dashboard mit „Ich bin dabei!“ an.
- **Auslosen & starten** lost den Turnierbaum zufällig aus. Fehlen Spieler für einen vollen Baum, bekommen einzelne ein Freilos und sind direkt in der nächsten Runde.
- Ergebnisse tragen Admins und die beiden Spieler eines Spiels ein (Klick aufs Spiel). Im K.-o.-System reicht der Sieger, der Spielstand ist optional. Bei „Jeder gegen jeden“ gibt es 3 Punkte für einen Sieg und 1 für ein Unentschieden.
- Wird ein Ergebnis geändert, setzt das K.-o.-System alle darauf aufbauenden Spiele zurück. „Zurück zur Anmeldung“ verwirft den Spielplan.
- Ist ein Turnier beendet, bucht es Punkte ins globale Leaderboard: 25 für den Sieger, 15 für Platz 2 und 10 für Platz 3 (im K.-o.-System beide Halbfinal-Verlierer), mit dem Spiel des Turniers für die Wertung pro Spiel. Ändert sich das Ergebnis oder wird das Turnier gelöscht, werden die Punkte neu gebucht bzw. zurückgenommen. Freie Teilnehmer ohne Nutzer bekommen Punkte nur, wenn es im Leaderboard einen gleichnamigen Spieler gibt.
- TV-Anzeige und Dashboard zeigen laufende Turniere live, mehrere wechseln auf dem TV alle 20 Sekunden. Neue Ergebnisse leuchten auf, der Turniersieger wird mit Konfetti und Fanfare gefeiert. Der Ton hängt am gemeinsamen 🔊-Knopf (Taste **M**).

## Achievements

- Alle angemeldeten Nutzer sammeln Achievements, ohne dass du etwas freischalten musst. Viele kommen von selbst: erste Anmeldung, Abstimmungen (mitstimmen, 5× mitstimmen, für die Gewinner-Antwort stimmen), Glücksrad (Einträge, drehen, eigener Eintrag gewinnt), nachts zwischen 3 und 5 Uhr dabei sein und 5 Achievements sammeln.
- Im Admin-Reiter **Achievements** vergibst du die übrigen von Hand (MVP, Clutch-König, Turniersieger, …), legst eigene mit Emoji, Beschreibung und Seltenheit an und nimmst Achievements wieder weg.
- Seltenheiten bringen Punkte: Gewöhnlich 10, Selten 25, Episch 50, Legendär 100. Im Dashboard sieht jeder seine Kacheln mit Fortschritt, das Achievement-Ranking und die letzten Freischaltungen. Die Punkte landen auch im globalen Leaderboard; wird ein Achievement weggenommen oder gelöscht, verschwinden sie dort wieder.
- Jede Freischaltung wird gefeiert: Die TV-Anzeige zeigt ein großes Popup mit Konfetti und Fanfare, auf dem eigenen Gerät gibt es das Popup für eigene Achievements und einen kleinen Hinweis für die der anderen. Der Ton hängt am gemeinsamen 🔊-Knopf (Taste **M**). Browser spielen Ton erst nach dem ersten Klick ab; `deploy/kiosk.sh` startet Chromium deshalb mit `--autoplay-policy=no-user-gesture-required`.

## Team-Generator

- Nutzer mit dem Feature „Team-Generator“ tragen sich im Dashboard mit „Ich bin dabei!“ ein, wählen die Anzahl der Teams und losen aus.
- Im Admin-Reiter **Teams** fügst du Nutzer oder Gäste ohne Konto hinzu, entfernst Teilnehmer, legst fest, ob Nutzer selbst auslosen dürfen, und blendest das Ergebnis wieder aus.
- **Nach Punkten ausgleichen** verteilt die Spieler per Schlangen-Draft nach ihren Punkten im globalen Leaderboard (verknüpfter Spieler oder gleicher Name), sonst wird rein zufällig gelost. Teamnamen werden zufällig vergeben.
- Die Auslosung läuft als Show auf allen Bildschirmen gleichzeitig: Namen rattern durch, die Spieler fliegen nacheinander in ihre Teams, am Ende gibt es Konfetti und eine Fanfare. Der Ton hängt am gemeinsamen 🔊-Knopf (Taste **M**). Die TV-Anzeige zeigt das Ergebnis 30 Sekunden lang.

## Musik (Spotify)

Alle steuern gemeinsam die Party-Musik. Gespielt wird über einen Spotify-Account mit **Premium** (z.B. auf dem Musik-PC), der Pi steuert ihn nur fern.

- **Einrichten** im Admin-Reiter **Musik**: Im [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) eine App anlegen, die angezeigte Redirect URI eintragen, *Web API* anhaken und die Client ID im Admin eintragen. Ein Client Secret ist nicht nötig. Dann „Mit Spotify verbinden“: Nach der Anmeldung zeigt der neue Tab eine Fehlerseite, deren komplette Adresse du in das Feld im Admin kopierst. (Spotify erlaubt ohne HTTPS nur `127.0.0.1` als Rücksprung, deshalb dieser Umweg.)
- Nutzer mit dem Feature „Musik (Spotify)“ suchen im Dashboard Songs und wünschen sie sich (landen in der Spotify-Warteschlange, mit Namen), höchstens 3 offene Wünsche pro Nutzer. Fürs Überspringen braucht es 3 Stimmen. Beides ist im Admin einstellbar.
- Pause, Vor, Zurück, Lautstärke und das Abspielgerät steuern Admins. Auf Wunsch dürfen das auch die Nutzer.
- Die TV-Anzeige zeigt in der Kopfzeile, was gerade läuft, und blendet neue Wünsche ein.
- Die Spotify-Zugangsdaten liegen in `data/spotify.json`, getrennt von `state.json`. Alternativ lässt sich die Client ID per `SPOTIFY_CLIENT_ID` setzen.

## Spiele-Matrix (Steam)

- Im Admin-Reiter **Steam** trägst du einmal einen kostenlosen Steam-Web-API-Schlüssel ein (https://steamcommunity.com/dev/apikey). Er bleibt auf dem Pi und geht nie an Browser. Alternativ per Umgebungsvariable `STEAM_API_KEY`.
- Nutzer mit dem Feature „Spiele-Matrix“ verknüpfen im Dashboard ihr Steam-Profil (Profil-Link, Name aus der Profil-URL oder SteamID64). Der Admin kann das im Reiter **Steam** auch für alle erledigen. In Steam müssen unter *Profil → Privatsphäre* die „Spieldetails“ öffentlich sein.
- Die Matrix zeigt pro Spiel, wer es besitzt, wer es gerade spielt und wer es installiert hat, dazu „Das können alle spielen“. Mit „Starten“ öffnet Steam das Spiel direkt (und installiert es, falls nötig).
- **Einschränkung:** Steam verrät nur Besitz, Spielzeit und das gerade laufende Spiel, nicht, was installiert ist. „Installiert“ hakt deshalb jeder in seiner eigenen Spalte selbst an.
- Spielelisten werden stündlich neu geladen, „spielt gerade“ jede Minute. Die letzte Liste bleibt gespeichert, falls das Internet ausfällt.

## Netzwerk-Monitoring

Die Karte **Netzwerk** im Dashboard und auf der TV-Anzeige zeigt live, wie es um das LAN steht. Der Pi misst alle 10 Sekunden:

- **Internet, Router, DNS**: Ping-Zeit, Jitter und Paketverlust mit Verlaufskurve. Der Router wird automatisch erkannt (bei der FritzBox meist `192.168.178.1`).
- **Internet-Durchsatz**: aktueller Download und Upload der ganzen Party samt Auslastung der Leitung, direkt aus der FritzBox. Dafür in der FritzBox *Heimnetz → Netzwerk → Netzwerkeinstellungen → „Statusinformationen über UPnP übertragen“* einschalten. Ohne diese Option bleibt der Bereich ausgeblendet.
- **Geräte**: Im Admin-Reiter **Netzwerk** trägst du PCs, Konsolen usw. ein oder lässt den Pi mit **Netzwerk durchsuchen** alle Geräte im Heimnetz finden. Fällt ein Gerät aus oder kommt zurück, wackelt die Zeile, ein Hinweis erscheint und es gibt einen kurzen Ton.

Windows-PCs beantworten Ping meist nicht. Sie gelten trotzdem als online, sobald sie im Netz sind (der Pi sieht sie in seiner ARP-Tabelle), nur ohne Ping-Zeit.

**Verbindungstest**: Nutzer mit dem Feature „Verbindungstest“ messen im Dashboard Ping, Download und Upload zwischen ihrem Gerät und dem Pi, mit Tacho-Animation. Das zeigt schnell, wessen WLAN schwächelt. Das letzte Ergebnis pro Nutzer landet in der Liste „Schnellste Verbindungen“. Es testet immer nur einer gleichzeitig.

Die Töne hängen am gemeinsamen 🔊-Knopf (Taste **M**). Damit die TV-Anzeige ohne Klick Töne abspielen darf, startet `deploy/kiosk.sh` Chromium mit `--autoplay-policy=no-user-gesture-required`.

## Glücksrad

- Nutzer mit dem Feature „Glücksrad“ tragen im Dashboard Einträge ein und entfernen ihre eigenen (max. 10 pro Nutzer, 60 insgesamt).
- Im Admin-Reiter **Glücksrad** stoppst du die Eingabe, legst fest, wer drehen darf, entfernst Einträge oder leerst das Rad. Admins dürfen immer drehen.
- Beim Drehen lost der Server den Gewinner aus. TV-Anzeige, Nutzerseiten und Admin-Seite drehen synchron und landen auf demselben Feld.
- **Umschalter Admin-Modus / Nutzermodus**: Admins wechseln oben zwischen `/admin` und dem Dashboard. Wer mit dem Master-Passwort angemeldet ist, sieht im Nutzermodus alle Features.
- **Neuer Link** macht den alten Link ungültig und meldet den Nutzer überall ab. **Löschen** entfernt den Nutzer samt Zugang.

## Animationen und Sound

Glücksrad (Tick am Zeiger, Konfetti und Fanfare beim Ergebnis) und Abstimmungen (wachsende Balken, Sieger mit Krone) haben eigene Animationen und Töne. Die Töne erzeugt der Browser selbst, es gibt keine Audiodateien. Der Lautsprecher-Knopf oben (oder die Taste **M**) schaltet den Ton pro Gerät stumm. Wer im Betriebssystem „Bewegung reduzieren“ eingestellt hat, bekommt keine Animationen.

Neue Features nutzen dafür `public/fx.js` (vor dem eigenen Skript einbinden):

```js
FX.sound('win');                      // tick, spin, win, vote, unvote, pop, remove, coin, chime, up, down, error
FX.confettiAt(element);               // Konfetti aus der Mitte eines Elements
FX.bump(element, 'fx-pop');           // fx-pop, fx-glow, fx-enter, fx-shake, fx-press, fx-flash-ok, fx-flash-bad
FX.floatText(element, '+5');          // aufsteigender Text
FX.flip(liste, () => { /* neu rendern */ });   // Umsortieren animieren (Kinder mit data-key)
FX.bars(liste, () => { /* neu rendern */ });   // Balken mit data-key und data-w (Prozent) wachsen lassen
const vorher = FX.track('schluessel', wert);  // vorheriger Wert, undefined beim ersten Aufruf
```

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

`kiosk.sh` startet Chromium so, dass die Soundeffekte auch ohne Klick auf dem Bildschirm laufen. Lautsprecher am Pi anschließen (HDMI-Ton reicht).

## Konfiguration

| Variable | Standard | Bedeutung |
|---|---|---|
| `ADMIN_PASSWORD` | `lanparty` | Passwort für `/admin`. Unbedingt ändern! |
| `PORT` | `8080` | HTTP-Port |
| `DATA_DIR` | `./data` | Ordner für `state.json` |
| `SPOTIFY_CLIENT_ID` | – | Client ID der Spotify-App (sonst im Admin eintragen) |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:<PORT>/api/spotify/callback` | Rücksprung-Adresse, muss in der Spotify-App eingetragen sein |
| `STEAM_API_KEY` | – | Steam-Web-API-Schlüssel (sonst im Admin-Reiter **Steam** eintragen) |
| `STEAM_REFRESH_MINUTES` | `60` | Minuten zwischen dem Neuladen der Steam-Spielelisten |
| `NET_CHECK_INTERVAL` | `10` | Sekunden zwischen den Netzwerk-Messungen |

## Hinweise

- Im Docker-Container darf `ping` ohne Root nicht senden. Das Netzwerk-Monitoring misst dann die Zeit für einen TCP-Verbindungsaufbau; die Geräteerkennung per ARP funktioniert nur mit `network_mode: host`. Auf dem Pi direkt (systemd) gibt es echte Ping-Zeiten.
- Lokal entwickeln: `npm run dev` (Node 18+), dann http://localhost:8080 öffnen.
