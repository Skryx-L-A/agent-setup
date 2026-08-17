#!/usr/bin/env bash
# SessionStart hook: injects CRITICAL-FACTS + IDENTITY + HOT (+ project MOC if cwd matches).
# Must never fail the hook: always exit 0, silently skip missing files.
#
# 2026-08-03: INDEX.md wurde hier ENTFERNT. Grund und Ersatz:
#   Der Katalog ist 10.745 Zeichen (~2.985 Token) und wurde in JEDER Session geladen -
#   der groesste Einzelposten dieses Hooks. Nach der Suchleiter in CLAUDE.md ist er aber
#   erst Schritt 2: gesucht wird mit `brain search`, und INDEX.md sagt nur dann, wo ein
#   Thema liegen muesste, wenn die Suche nichts Brauchbares liefert. Das ist ein
#   Ausloeser, kein Dauerposten. Der Verweis unten nennt Datei UND Ausloeser.
# CRITICAL-FACTS, IDENTITY und HOT bleiben: klein, gelten ohne Ausloeser, und bei HOT
# waere Nachschlagen zu spaet - man weiss ja nicht, dass es etwas gibt.

VAULT="$HOME/Knowledge"

cat "$VAULT/CRITICAL-FACTS.md" 2>/dev/null
# IDENTITY.md is gitignored/per-machine — says which shared-brain person is at the keyboard.
if [ -f "$VAULT/IDENTITY.md" ]; then
  cat "$VAULT/IDENTITY.md"
else
  echo "IDENTITY.md fehlt — lege sie aus IDENTITY.md.example an (kopieren, ausfüllen, nie committen)."
fi

# HOT.md mit ALTERSANGABE. Ohne sie liest sich ein fuenf Tage alter "Recent Context" wie
# der aktuelle Stand - genau das war am 2026-08-03 der Fall, weil der Gardener seit dem
# 29.07. an keinem Job mehr hing. Ein veralteter Hinweis ist schlechter als keiner,
# solange er sein Alter verschweigt.
if [ -f "$VAULT/HOT.md" ]; then
  hot_age_days=$(( ( $(date +%s) - $(stat -f %m "$VAULT/HOT.md" 2>/dev/null || echo 0) ) / 86400 ))
  if [ "$hot_age_days" -ge 3 ]; then
    echo "[HOT.md ist $hot_age_days Tage alt — als Momentaufnahme von damals lesen, nicht"
    echo " als aktuellen Stand. Auffrischen: brain gardener run]"
  fi
  cat "$VAULT/HOT.md" 2>/dev/null
fi

echo
echo "Vault-Katalog: ~/Knowledge/INDEX.md — zu lesen, wenn \`brain search\` nichts Brauchbares"
echo "liefert und Du wissen musst, in welchem Branch ein Thema ueberhaupt liegen sollte."

project_dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"
project_name="$(basename "$project_dir" 2>/dev/null)"
project_name_lower="$(printf '%s' "$project_name" | tr '[:upper:]' '[:lower:]')"

if [ -n "$project_name_lower" ]; then
  for dir in "$VAULT"/20-projects/*/; do
    [ -d "$dir" ] || continue
    entry="$(basename "$dir")"
    if [ "$(printf '%s' "$entry" | tr '[:upper:]' '[:lower:]')" = "$project_name_lower" ]; then
      cat "$dir/MOC.md" 2>/dev/null
      break
    fi
  done
fi

exit 0
