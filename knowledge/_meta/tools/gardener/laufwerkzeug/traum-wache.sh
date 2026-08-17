#!/bin/bash
# Wache fuer den Traum-Volllauf: haelt an, bevor der Rechner stirbt, und weckt
# den Orchestrator bei allem, was nicht nach normalem Betrieb aussieht.
#
# WARUM ES SIE GIBT
#
# In der Nacht auf den 16.08.2026 ist der Mac dreimal gestorben - zweimal am
# 11.08. an einer GPU-Panik (`completeMemory() prepare count underflow`) und
# einmal am 15.08. um 23:04 an einem Watchdog-Timeout, 92 Sekunden ohne
# Lebenszeichen. Jedes Mal war die Ursache dieselbe: zu viele gleichzeitige
# Anfragen an ein lokales 27B-Modell, dessen Speicherspitze unterschaetzt war.
#
# Zwei Lehren stecken in der Bauart dieser Wache:
#
# 1. EINE MESSUNG IST KEIN BEFUND. Kurz vor dem Absturz, im Abstand von 15
#    Sekunden gemessen: 4.102, 858, 8.011, 4.125, 754 MiB frei. Der Speicher
#    SCHWINGT. Wer einmal hinsieht, sieht je nach Zeitpunkt Entwarnung oder
#    Katastrophe. Deshalb loest hier nichts beim ersten Wert aus.
# 2. EIN LEBENDER PROZESS IST KEIN FORTSCHRITT. Ein verklemmter Modellserver
#    (gemessen am 16.08.: alle Faeden auf Bedingungsvariablen, GPU bei null)
#    sieht in `ps` genauso gesund aus wie einer, der rechnet. Fortschritt wird
#    deshalb an wachsenden Ausgaben gemessen, nicht an einer PID.
#
# WAS SIE TUT
#
#   Unter dem Boden (Vorgabe 500 MiB, zwei Messungen in Folge):
#     Lauf und Modellserver beenden, Belegung freigeben, Orchestrator wecken.
#     Der Lauf ist fortsetzbar - offene Einheiten stehen auf `pending`.
#
#   Ungewoehnliches, ohne zu stoppen - sie weckt nur:
#     - der Lauf ist weg, obwohl niemand ihn beendet hat
#     - der Fortschritt steht (keine neue Protokollzeile seit STILLSTAND_MIN)
#     - der Modellserver ist weg, waehrend der Lauf weiterlaeuft
#     - der Modellserver lebt, aber seine CPU-Zeit waechst nicht (Deadlock)
#     - die Budgetbremse hat ausgeloest
#     - Quarantaene oder Wolken-Rueckfall haeufen sich auffaellig
#
#   traum-wache.sh <orchestrator-pane> [--boden-mib 500] [--abstand 10]
set -u

# Der Pane wird nur noch der Vollstaendigkeit halber angenommen: geweckt wird
# ueber WACHE-MELDUNGEN.md und einen Beobachter darauf, nicht durch Tippen in
# einen Pane. Er darf deshalb fehlen - ein Pflichtargument, das niemand
# benutzt, laesst die Wache beim Neustart still sterben. Genau das ist am
# 16.08. um 01:59 passiert, und eine tote Wache sieht aus wie eine ruhige.
PANE=${1:-}
[ $# -gt 0 ] && shift
BODEN_MIB=500
ABSTAND=10
STILLSTAND_MIN=25
LAUFDIR=$HOME/AI/traum-lauf
LOG="$LAUFDIR/wache-$(date +%Y%m%d-%H%M).log"

while [ $# -gt 0 ]; do
  case "$1" in
    --boden-mib) BODEN_MIB="$2"; shift 2 ;;
    --abstand)   ABSTAND="$2"; shift 2 ;;
    --stillstand-min) STILLSTAND_MIN="$2"; shift 2 ;;
    *) echo "unbekannt: $1" >&2; exit 64 ;;
  esac
done

mkdir -p "$LAUFDIR"
exec >>"$LOG" 2>&1
echo "=== Wache gestartet $(date '+%F %T'), Boden ${BODEN_MIB} MiB, Abstand ${ABSTAND}s ==="

frei_mib() {
  check-resources 2>/dev/null | python3 -c \
    'import json,sys
try: print(json.load(sys.stdin)["vram"]["free_mib"])
except Exception: pass' 2>/dev/null
}

lauf_pids() {   # der Volllauf und seine Kinder, ueber die Kommandozeile erkannt
  pgrep -f 'gardener.dream.cli (run|extract|reconcile|review|apply)' 2>/dev/null
}

server_pid() { pgrep -f 'mlx_lm.server' 2>/dev/null | head -1; }

# Ob gerade ein Modellserver DA SEIN MUSS, sagt nicht die Kommandozeile, sondern
# das Belegungsbuch. Nur `extract` ruft das lokale Modell an; `reconcile` rechnet
# Einbettungen ueber Ollama, `review` und `apply` sprechen mit der Wolke. In der
# Kette (`run`) laufen alle vier nacheinander unter EINEM Kommando, und
# `extract` gibt den Server am Ende selbst frei (extract.py:1147) - an der
# Kommandozeile waere das nicht zu unterscheiden, und die Wache haette jeden
# Kettenlauf ab der Urteilsstufe mit einer Falschmeldung begleitet.
#
# `grug-server ensure` bucht VOR dem Start und `stop` gibt frei. Eine offene
# Buchung auf das Modell ohne laufenden Server ist deshalb genau der Zustand,
# der jemanden wecken soll: der Speicher ist reserviert, aber niemand rechnet.
belegung_fuers_modell() {
  wb-belegung wer --json 2>/dev/null | python3 -c '
import json, sys
try:
    eintraege = json.load(sys.stdin).get("belegungen", [])
except Exception:
    sys.exit(0)
for e in eintraege:
    if any(w in json.dumps(e).lower() for w in ("mlx", "qwen", "grug")):
        print(e.get("id", "?"))
        break
' 2>/dev/null
}

# Weckt den Orchestrator - NICHT ueber `wb-pane-write`. Der Weg ist mit Absicht
# versperrt: In einen Pane mit @wb_role=orchestrator darf allein die
# Kontextwache tippen, geprueft an ihrem Pfad in der Ahnenreihe. Diese Sperre
# zu umgehen waere genau die Art Trick, gegen die sie gebaut wurde.
#
# Stattdessen schreibt die Wache eine Zeile mit dem Wort WECKEN in ihr
# Protokoll, und der Orchestrator haengt einen Beobachter an dieses Protokoll.
# Jede solche Zeile wird bei ihm zu einer Nachricht. Die Wache HANDELT also
# selbst (anhalten, freigeben) und meldet; wer geweckt wird, entscheidet der,
# der den Beobachter gestartet hat.
#
# Zusaetzlich landet der Grund in einer eigenen Datei, damit er eine
# Kompaktierung oder einen Sitzungswechsel ueberlebt.
wecke() {   # <text>
  echo "WECKEN: $1"
  printf '%s  %s\n' "$(date '+%F %T')" "$1" >> "$LAUFDIR/WACHE-MELDUNGEN.md"
}

# Beendet den Lauf sauber und verifiziert es. Erst der Lauf, dann der Server -
# umgekehrt liefe der Lauf in Zeitueberschreitungen statt in ein Ende.
halte_an() {   # <grund>
  local grund="$1" pids p
  echo "HALT: $grund"
  pids=$(lauf_pids)
  [ -n "$pids" ] && kill $pids 2>/dev/null
  sleep 3
  for p in $pids; do kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null; done
  p=$(server_pid)
  [ -n "$p" ] && { kill "$p" 2>/dev/null; sleep 3; kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null; }
  grug-server stop >/dev/null 2>&1 || true
  # Eine verwaiste Belegung sperrt die Maschine fuer jede weitere Sitzung.
  local kennung
  kennung=$(wb-belegung wer 2>/dev/null | sed -n '2p' | awk '{print $1}')
  if [ -n "$kennung" ] && [ "$kennung" != "Keine" ]; then
    wb-belegung gib "$kennung" >/dev/null 2>&1 || \
      wb-belegung gib "$kennung" --fremd >/dev/null 2>&1 || true
    echo "  Belegung $kennung freigegeben"
  fi
  echo "  Reste: $(pgrep -f 'gardener.dream.cli|mlx_lm.server' 2>/dev/null | tr '\n' ' ')"
}

# --- Zustand zwischen zwei Runden -------------------------------------------
unter_boden=0
letzte_groesse=0
letzte_aenderung=$(date +%s)
letzte_cpu=""
cpu_steht=0
gemeldet_stillstand=0
gemeldet_serverweg=0
serverweg_folge=0
gemeldet_deadlock=0
gemeldet_budget=0
gemeldet_lauf_weg=0
lauf_gesehen=0

protokoll() { ls -t "$LAUFDIR"/lauf-*.log 2>/dev/null | head -1; }

while true; do
  sleep "$ABSTAND"

  frei=$(frei_mib)
  if [ -z "$frei" ]; then
    # Siehe Befund B7: eine Wache, die nicht misst, sieht aus wie eine, die
    # schuetzt. Ein dauerhaft kaputtes `check-resources` muss laut sein.
    blind=$((${blind:-0} + 1))
    if [ "$blind" = 5 ] || [ "$blind" = 50 ] || [ $((blind % 200)) = 0 ]; then
      wecke "WACHE BLIND: ${blind} Messungen in Folge unlesbar (check-resources). Die Wache schuetzt gerade NICHT - bitte nachsehen."
    fi
  else
    blind=0
  fi
  pids=$(lauf_pids)
  spid=$(server_pid)
  [ -n "$pids" ] && lauf_gesehen=1

  # --- 1. Der harte Halt ---------------------------------------------------
  if [ -n "$frei" ] && [ "$frei" -lt "$BODEN_MIB" ]; then
    unter_boden=$((unter_boden + 1))
    echo "$(date '+%T') nur $frei MiB frei (${unter_boden}. Messung in Folge)"
    if [ "$unter_boden" -ge 2 ]; then
      halte_an "nur $frei MiB frei, Boden $BODEN_MIB, zwei Messungen in Folge"
      wecke "WACHE: Der Traum-Lauf wurde angehalten - nur ${frei} MiB freier Speicher (Boden ${BODEN_MIB}). Lauf und Modellserver sind beendet, die Belegung ist frei, offene Einheiten stehen auf pending. Bitte nachsehen, woran es lag, reparieren und fortsetzen. Protokoll: ${LOG}"
      echo "=== Wache endet nach hartem Halt $(date '+%F %T') ==="
      exit 0
    fi
  else
    unter_boden=0
  fi

  # --- 2. Lauf weg, ohne dass jemand ihn beendet hat ------------------------
  #
  # Gemeldet wird das EINMAL, danach wartet die Wache weiter. Bis zum
  # 16.08.2026 stieg sie hier aus - und das war falsch: In der Nacht des
  # ersten Volllaufs wurde der Lauf viermal angehalten und neu gestartet
  # (Beschleunigung eingebaut, Protokollzeilen ergaenzt, eine tote Belegung
  # geraeumt). Beim ERSTEN dieser Stopps war die Wache weg, und danach lief
  # die Maschine unbewacht weiter, ohne dass irgendwo etwas anderes stand als
  # die eine Meldung. Eine Wache, die beim ersten Neustart aufhoert, bewacht
  # den Rest der Nacht nicht.
  #
  # Beendet wird sie durch die STOPP-Marke, und nur durch die.
  if [ "$lauf_gesehen" = 1 ] && [ -z "$pids" ]; then
    if [ -e "$LAUFDIR/STOPP" ]; then
      echo "$(date '+%T') Lauf beendet, Stoppmarke liegt - alles in Ordnung"
      echo "=== Wache endet auf Stoppmarke $(date '+%F %T') ==="
      exit 0
    fi
    if [ "${gemeldet_lauf_weg:-0}" = 0 ]; then
      wecke "WACHE: Der Traum-Lauf ist weg, ohne Stoppmarke. Kein Prozess von gardener.dream.cli mehr da. Bitte nachsehen, ob er fertig ist oder abgestuerzt. Die Wache laeuft WEITER und nimmt einen neuen Lauf auf; beenden mit ${LAUFDIR}/STOPP. Protokoll: ${LOG}"
      gemeldet_lauf_weg=1
    fi
    continue
  fi
  # Ein neuer Lauf ist da: die Meldung darf beim naechsten Mal wieder kommen,
  # und alles, was sich auf den alten Lauf bezog, faengt von vorn an.
  if [ -n "$pids" ] && [ "${gemeldet_lauf_weg:-0}" = 1 ]; then
    echo "$(date '+%T') neuer Lauf gesehen (PIDs: $pids) - Wache nimmt ihn auf"
    gemeldet_lauf_weg=0
    letzte_groesse=0
    letzte_aenderung=$(date +%s)
    letzte_cpu=""
    cpu_steht=0
    gemeldet_stillstand=0
    gemeldet_serverweg=0
    serverweg_folge=0
    gemeldet_deadlock=0
  fi

  [ -z "$pids" ] && continue      # noch nicht gestartet

  # --- 3. Fortschritt: waechst das Protokoll? ------------------------------
  p=$(protokoll)
  if [ -n "$p" ] && [ -f "$p" ]; then
    groesse=$(wc -c <"$p" | tr -d ' ')
    if [ "$groesse" != "$letzte_groesse" ]; then
      letzte_groesse=$groesse
      letzte_aenderung=$(date +%s)
      gemeldet_stillstand=0
    else
      steht_seit=$(( ($(date +%s) - letzte_aenderung) / 60 ))
      if [ "$steht_seit" -ge "$STILLSTAND_MIN" ] && [ "$gemeldet_stillstand" = 0 ]; then
        wecke "WACHE: Der Traum-Lauf schreibt seit ${steht_seit} Minuten nichts mehr ins Protokoll, laeuft aber noch (PIDs: $(echo $pids | tr '\n' ' ')). Freier Speicher ${frei} MiB. Verdacht auf Stillstand - eine Einheit kann lange dauern, ${STILLSTAND_MIN} Minuten ohne eine Zeile nicht. Protokoll: ${p}"
        gemeldet_stillstand=1
      fi
    fi
    # Budgetbremse und Auffaelligkeiten
    if [ "$gemeldet_budget" = 0 ] && grep -qi 'budget' "$p" 2>/dev/null && \
       grep -qiE 'exhaust|erschoepft|budget_stopped|Konto ist leer' "$p" 2>/dev/null; then
      wecke "WACHE: Die Budgetbremse hat im Traum-Lauf ausgeloest. Der Lauf laeuft ggf. noch, aber ohne Wolke. Bitte nachsehen: ${p}"
      gemeldet_budget=1
    fi
  fi

  # --- 4. Modellserver ------------------------------------------------------
  if [ -z "$(belegung_fuers_modell)" ]; then
    # Niemand hat Speicher fuer das Modell gebucht - es wird gerade auch keiner
    # erwartet. Die Zaehler zuruecksetzen, damit der naechste echte Fall wieder
    # meldet.
    serverweg_folge=0
    gemeldet_serverweg=0
    gemeldet_deadlock=0
    cpu_steht=0
  elif [ -z "$spid" ]; then
    # Wie lange eine Buchung ohne Server ERLAUBT ist, entscheidet die
    # Ladezeit - und `grug-server ensure` bucht ABSICHTLICH vor dem Laden,
    # damit niemand den Speicher wegschnappt, waehrend 15 GB von der Platte
    # kommen. Zwischen Buchung und einem sichtbaren `mlx_lm.server` liegt also
    # regelmaessig mehr als eine Minute.
    #
    # Drei Runden (30 s) waren zu wenig: am 16.08.2026 um 04:49 hat diese
    # Regel einen voellig gesunden Start gemeldet. 18 Runden sind bei
    # ABSTAND=10 drei Minuten und liegen deutlich ueber jedem gemessenen
    # Ladevorgang, aber weit unter der Frist einer Buchung (drei Stunden).
    serverweg_folge=$((serverweg_folge + 1))
    if [ "$serverweg_folge" -ge 18 ] && [ "$gemeldet_serverweg" = 0 ]; then
      wecke "WACHE: Der Speicher fuer das Modell ist gebucht, aber es laeuft kein Modellserver. Der Lauf wird in Zeitueberschreitungen laufen und die Buchung blockiert die Maschine. Protokoll: ${LOG}"
      gemeldet_serverweg=1
    fi
  else
    serverweg_folge=0
    gemeldet_serverweg=0
    # Deadlock-Signatur: Server lebt, CPU-Zeit waechst nicht. Genau so sah der
    # verklemmte Server am 16.08. aus - vier offene Verbindungen, GPU bei null.
    cpu=$(ps -o time= -p "$spid" 2>/dev/null | tr -d ' ')
    if [ -n "$cpu" ] && [ "$cpu" = "$letzte_cpu" ]; then
      cpu_steht=$((cpu_steht + 1))
      # Bei ABSTAND=10 sind 30 Runden fuenf Minuten ohne eine einzige
      # Rechensekunde. Eine lange Erzeugung sieht anders aus.
      if [ "$cpu_steht" -ge 30 ] && [ "$gemeldet_deadlock" = 0 ]; then
        wecke "WACHE: Der Modellserver (PID ${spid}) verbraucht seit fuenf Minuten keine CPU-Zeit mehr, lebt aber. Das ist die Signatur des Deadlocks vom 16.08. Der Lauf haengt vermutlich in Zeitueberschreitungen. Protokoll: ${LOG}"
        gemeldet_deadlock=1
      fi
    else
      letzte_cpu=$cpu
      cpu_steht=0
      gemeldet_deadlock=0
    fi
  fi
done
