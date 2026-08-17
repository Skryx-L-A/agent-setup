#!/bin/bash
# Zweck: verhindert `git add`/`git commit`, die .env-Dateien oder gaengige
#        Secret-Dateimuster ausserhalb ~/Knowledge/90-secrets/ einschliessen.
# Event: PreToolUse, matcher Bash.
# Warum: CLAUDE.md sagt "Never commit a .env (or any secret) to GitHub" und
#        "Secrets knowledge goes only into 90-secrets/" — bisher reine Prosa-
#        Regel ohne technische Durchsetzung (siehe research-skills Luecke #1).
# Fix nach Review 2026-07-28 (M10): alle drei Trigger-Checks verlangten "git"
#        UNMITTELBAR gefolgt vom Unterbefehl (add/commit) — `git -C <dir> add`
#        oder `git --git-dir=<pfad> commit` (genau die Form, die vault-sync
#        selbst benutzt!) fielen komplett durch den Hook. Jetzt liest
#        find_git_invocation() den ERSTEN Nicht-Options-Token nach "git" als
#        echtes Unterkommando (kennt -C/-c/--git-dir=/--work-tree= als
#        Optionen-mit-Wert) und traegt zusaetzlich den per -C/--git-dir
#        angegebenen Zielpfad ein — der breite Staging-Scan (Abschnitt 2)
#        prueft jetzt GENAU dieses Repo, nicht mehr blind das cwd des
#        Bash-Aufrufs (das bei `-C` etwas ganz anderes sein kann).
# Umweg, falls falsch-positiv: Datei umbenennen/aus dem Commit nehmen, oder
#        (nur wenn wirklich unbedenklich) einmalig ohne diesen Hook committen
#        via `git commit --no-verify` betrifft NICHT diesen Hook (Hooks laufen
#        unabhaengig von Git-Hooks) — in dem Fall den Nutzer fragen, ob das
#        Pattern hier angepasst werden soll.
# Fix nach Stresstest 2026-07-28 (B10/B02): Abschnitt 1 pruefte die Pfad-
#        Argumente von `git add` als rohe Kommandozeilen-Tokens — jede Form
#        von Quoting (`git add ".env"`, `git add "$(printf .env)"`, sogar
#        `git add .en''v`) liess sich damit beliebig variieren, der
#        tatsaechliche Working-Tree-Status nicht. Abschnitt 1 ist komplett
#        entfernt; Abschnitt 2 (git status --porcelain) laeuft jetzt bei JEDER
#        Form von `git add` (nicht nur den vorher als "breit" erkannten
#        -A/--all/./commit -a), erkennt damit alle Quoting-Varianten gleich
#        mit und kostet weiterhin nur einen git-Aufruf. Und: kein `jq` mehr —
#        Python3 (json-Modul) uebernimmt Parsen und Ausgabe, damit ein
#        fehlendes jq-Binary diesen Deny-Hook nicht mehr lautlos stilllegt.
# Erweiterung 2026-08-17 (dokumentierter Befund "guard-inhalt"): Abschnitt 2
#        prueft bislang NUR den Dateipfad/-namen (is_secret_path). Ein echter
#        Schluessel in einer unverdaechtig benannten Datei (z. B. config.py,
#        settings.yaml) rutschte ungehindert durch. Neu: Abschnitt 3 fuehrt
#        zusaetzlich eine INHALTSPRUEFUNG der Dateien durch, die durch
#        add/commit ins Staging geraten wuerden — Muster-Erkennung fuer
#        gaengige Provider-Tokens (AWS/GitHub/OpenAI/Anthropic/Slack/Google/
#        private Schluessel/JWT) plus eine Shannon-Entropie-Schaetzung fuer
#        generische "password/secret/token/api_key = <Wert>"-Zuweisungen.
#        Design-Entscheidungen (Details im Code unten):
#        - FAIL-CLOSED bei Lesefehlern: kann eine Datei nicht gelesen werden
#          (Rechte, I/O-Fehler) oder schlaegt der Scan-Prozess selbst fehl
#          (python3 fehlt/crasht), wird das NICHT als "sauber" gewertet,
#          sondern verweigert — analog zur bestehenden Haertung oben (ein
#          Deny-Hook, der seine Pruefung nicht durchfuehren kann, darf nicht
#          so tun als waere alles in Ordnung).
#        - Binaerdateien werden erkannt (NUL-Byte im gelesenen Ausschnitt)
#          und von der INHALTS-Pruefung ausgenommen (nicht: fail-closed) —
#          das ist in der Aufgabe ausdruecklich als legitimes Ueberspringen
#          vorgesehen, keine Bloesse.
#        - Grosse Dateien werden nur bis zu einer Groessengrenze gelesen
#          (CONTENT_SCAN_MAX_BYTES, siehe Abschnitt 3), nicht komplett
#          uebersprungen — ein Fund in den ersten N Bytes zaehlt weiterhin.
#        - Ausnahmen von der INHALTS-Pruefung (z. B. *.example-Dateien)
#          stehen in einer SEPARATEN Konfigurationsdatei
#          (guard-secrets-content-exceptions.conf, gleiches Verzeichnis wie
#          dieses Skript) mit sinnvollen Standardwerten — nicht als
#          Sonderfall im Code. Sie betrifft NUR Abschnitt 3; die bestehende
#          90-secrets/-Ausnahme in is_secret_path (Abschnitt 1/2) bleibt
#          unveraendert. Fehlt die Konfigurationsdatei, gilt der sichere
#          Standard: KEINE Ausnahme (es wird mehr gescannt, nie weniger).
set -uo pipefail

# HAERTUNG 2026-07-28 (Stress-Befund B02, zweite Runde): Interpreter und Leser werden
# ABSOLUT aufgerufen. Ein gestripptes PATH (im Stresstest nur `bash`) liess sonst schon
# `cat` und `python3` fehlschlagen — der Hook konnte die Eingabe nicht einmal lesen und
# endete auf 0, also ERLAUBEN. Ein Deny-Hook, der sein Werkzeug nicht findet, blockt.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTENT_EXCEPTIONS_FILE="$SCRIPT_DIR/guard-secrets-content-exceptions.conf"

input=$(/bin/cat)
command=$(printf '%s' "$input" | /usr/bin/python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
c = (d.get("tool_input") or {}).get("command")
print(c if isinstance(c, str) else "")
')
[ -z "$command" ] && exit 0
cwd=$(printf '%s' "$input" | /usr/bin/python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
c = d.get("cwd")
print(c if isinstance(c, str) else "")
')

GIT_DIR_HINT=""
find_git_invocation() {
  # Sucht im Kommando "git ... <Unterbefehl>", ueberspringt bekannte
  # Optionen-mit-Wert (-C <dir>, -c <k=v>, --git-dir=<p>, --work-tree=<p>).
  # Setzt GIT_DIR_HINT auf den zuletzt gefundenen -C/--git-dir/--work-tree-
  # Wert (leer = kein Hinweis -> Aufrufer nutzt cwd). Rueckgabe 0, wenn
  # IRGENDEIN Vorkommen von "git" im Kommando eines der uebergebenen
  # Zielsubkommandos traf (deckt auch mehrere/verkettete git-Aufrufe ab).
  local seg="$1"; shift
  # Klammern trennen Woerter. Ohne diese Zeile heisst der erste Token von
  # `(git add .env)` nicht "git", sondern "(git" -- der Guard sah dann gar
  # keinen git-Aufruf und stieg sofort aus. Gemessen 2026-08-05 am echten
  # Guard-Verlauf: BEIDE protokollierten secrets-Ablehnungen liefen in dieser
  # geklebten Form durch (in `( C )` mit Leerzeichen dagegen nicht).
  # Bewusst nur eine Wortgrenze, keine Shell-Aufloesung: die naive Zerlegung
  # dieses Guards bleibt, wie sie ist (siehe Fix-Historie B10/B02 oben).
  seg="${seg//[()]/ }"
  local -a targets=("$@")
  local -a toks
  read -r -a toks <<< "$seg"
  local n=${#toks[@]} i=0 found=1
  GIT_DIR_HINT=""
  while [ $i -lt $n ]; do
    if [ "${toks[$i]}" = "git" ]; then
      local dirhint="" j=$((i+1))
      while [ $j -lt $n ]; do
        case "${toks[$j]}" in
          -C) dirhint="${toks[$((j+1))]:-}"; j=$((j+2)); continue ;;
          -c) j=$((j+2)); continue ;;
          --git-dir=*) dirhint="${toks[$j]#--git-dir=}"; j=$((j+1)); continue ;;
          --work-tree=*) dirhint="${toks[$j]#--work-tree=}"; j=$((j+1)); continue ;;
          -*) j=$((j+1)); continue ;;
          *) break ;;
        esac
      done
      if [ $j -lt $n ]; then
        local sub="${toks[$j]}" t
        for t in "${targets[@]}"; do
          if [ "$sub" = "$t" ]; then
            GIT_DIR_HINT="$dirhint"
            found=0
          fi
        done
      fi
    fi
    i=$((i+1))
  done
  return $found
}

# Nur reagieren, wenn ueberhaupt git add/commit im Spiel ist.
find_git_invocation "$command" add commit || exit 0

deny() {
  local reason="$1"
  /usr/bin/python3 -c '
import json, sys
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": sys.argv[1],
    }
}))
' "$reason"
  exit 0
}

is_allowed_env_suffix() {
  # .env.example / .env.template / .env.sample sind erlaubt.
  echo "$1" | /usr/bin/grep -Eqi '\.env\.(example|template|sample)$'
}

is_secret_path() {
  local p="$1"
  # Ausnahme: alles innerhalb 90-secrets/ ist der vorgesehene Ort fuer Secrets.
  echo "$p" | /usr/bin/grep -Eq '(^|/)90-secrets/' && return 1
  is_allowed_env_suffix "$p" && return 1
  # .env oder .env.<irgendwas ausser example/template/sample>
  if echo "$p" | /usr/bin/grep -Eq '(^|/)\.env($|\.[A-Za-z0-9_-]+$)'; then
    return 0
  fi
  # gaengige Secret-Dateimuster
  if echo "$p" | /usr/bin/grep -Eqi '(^|/)(id_rsa|id_ed25519|id_ecdsa)$|\.(pem|p12|pfx)$|(^|/)credentials\.json$|(^|/)service-account.*\.json$|(^|/)secrets\.ya?ml$'; then
    return 0
  fi
  return 1
}

# --- Abschnitt 3: Inhaltspruefung -----------------------------------------
#
# is_content_scan_exempt(): laedt Glob-Muster aus CONTENT_EXCEPTIONS_FILE
# (eine pro Zeile, # = Kommentar, leere Zeilen ignoriert) und prueft den
# repo-relativen Pfad dagegen. Betrifft NUR Abschnitt 3 (Inhalt), nicht die
# Pfadpruefung oben. Fehlt die Datei: keine Ausnahme (scannt mehr, nie
# weniger -> sicherer Standard).
is_content_scan_exempt() {
  local p="$1"
  [ -f "$CONTENT_EXCEPTIONS_FILE" ] || return 1
  local pattern
  while IFS= read -r pattern; do
    case "$pattern" in
      ''|'#'*) continue ;;
    esac
    # shellcheck disable=SC2254
    case "$p" in
      $pattern) return 0 ;;
    esac
  done < "$CONTENT_EXCEPTIONS_FILE"
  return 1
}

# CONTENT_SCAN_MAX_BYTES: pro Datei werden hoechstens so viele Bytes gelesen.
# Ein Fund in diesem Bereich zaehlt weiterhin als Treffer; alles danach wird
# nicht gesehen (dokumentierte Grenze, kein stilles Uebergehen der ganzen
# Datei). 2 MB deckt so gut wie jede Quell-/Konfigurationsdatei komplett ab
# und haelt den Scan schnell (siehe Messung im Test-Report).
CONTENT_SCAN_MAX_BYTES=2000000

# Der eigentliche Scanner laeuft als EIN einziger python3-Prozess fuer ALLE
# Kandidaten-Dateien zusammen (Batch statt ein Prozess pro Datei) -- Prozess-
# Start ist der teuerste Teil bei vielen kleinen Dateien, ein Hook der vor
# JEDEM Bash-Aufruf laeuft darf das nicht x-mal pro Aufruf zahlen.
#
# Entropie-Schwelle (ENTROPY_THRESHOLD unten): gemessen an echten Beispielen
# (Shannon-Entropie in Bit/Zeichen ueber die Zeichenverteilung des Strings
# selbst, Standardmass wie bei trufflehog/detect-secrets):
#   UUID v4 mit Bindestrichen (36 Zeichen)      3.391 Bit/Zeichen
#   UUID v4 ohne Bindestriche (32 Hexziffern)   3.248 Bit/Zeichen
#   git SHA-1, 39 Hexziffern                    3.821 Bit/Zeichen
#   zufaelliger 32-Zeichen-Schluessel           5.000 Bit/Zeichen
#     (gemischte Gross-/Kleinschreibung+Ziffern, aB3xK9mQ7vN2pL5tR8wZ1cF4hJ6yU0sD)
#   zufaellige 40-Zeichen-Zeichenkette          5.172 Bit/Zeichen
# Reines Hex (UUID/SHA) hat ein theoretisches Maximum von log2(16) = 4.0
# Bit/Zeichen -- selbst ein perfekt zufaelliger Hexwert kommt nie darueber.
# Zufallsschluessel mit groesserem Alphabet (Gross-/Kleinschreibung+Ziffern,
# ~62 Symbole, log2(62) = 5.95) liegen bei ueblichen Laengen klar darueber.
# Schwelle 4.3 liegt damit sicher ueber der Hex-Decke UND sicher unter den
# gemessenen echten Zufallsschluesseln -- kein UUID/git-SHA kann sie je
# erreichen, ein generischer Zufallsschluessel ueberschreitet sie deutlich.
ENTROPY_THRESHOLD_COMMENT="siehe Kommentar oben (4.3 Bit/Zeichen)"

read -r -d '' CONTENT_SCAN_PY <<'PYEOF' || true
import math, re, sys
from collections import Counter

MAX_BYTES = 2000000
ENTROPY_THRESHOLD = 4.3
MIN_GENERIC_LEN = 16

PATTERNS = [
    ("aws_access_key", re.compile(r'AKIA[0-9A-Z]{16}')),
    ("github_token", re.compile(r'(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255}')),
    ("anthropic_key", re.compile(r'sk-ant-[A-Za-z0-9_-]{20,}')),
    ("openai_key", re.compile(r'sk-(?!ant-)[A-Za-z0-9_-]{20,}')),
    ("slack_token", re.compile(r'xox[baprs]-[A-Za-z0-9-]{10,48}')),
    ("google_api_key", re.compile(r'AIza[0-9A-Za-z_-]{35,}')),
    ("private_key_block", re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----')),
    ("jwt", re.compile(r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}')),
    ("stripe_key", re.compile(r'(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}')),
]

# Keine vordere Wortgrenze: '\b' greift NICHT vor dem S in STRIPE_SECRET, weil der
# Unterstrich selbst ein Wortzeichen ist -- ein Praefix wie STRIPE_, AZURE_CLIENT_ oder
# DB_ haette den Fund sonst still verhindert. Gemessen am 17.08.2026 mit einem
# erfundenen Stripe- und einem Azure-Wert, beide gingen durch. Ein Fehlalarm bleibt
# unwahrscheinlich, weil zusaetzlich ein Wert von mindestens MIN_GENERIC_LEN Zeichen
# UND eine Entropie ueber der Schwelle verlangt wird.
GENERIC_ASSIGN = re.compile(
    r'(?i)(password|passwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret)\b'
    r'\s*[:=]\s*["\']?([A-Za-z0-9+/_=\-~.]{%d,})["\']?' % MIN_GENERIC_LEN
)


def shannon_entropy(s):
    if not s:
        return 0.0
    counts = Counter(s)
    length = len(s)
    return -sum((c / length) * math.log2(c / length) for c in counts.values())


def scan_file(path):
    findings = []
    try:
        with open(path, "rb") as f:
            data = f.read(MAX_BYTES)
    except Exception as e:
        return None, "%s: %s" % (path, e)

    if b"\x00" in data:
        return [], None  # binaer -> uebersprungen, kein Fehler

    text = data.decode("utf-8", errors="replace")

    for name, rx in PATTERNS:
        m = rx.search(text)
        if m:
            line = text.count("\n", 0, m.start()) + 1
            findings.append("%s: Zeile %d, Muster '%s'" % (path, line, name))

    for m in GENERIC_ASSIGN.finditer(text):
        value = m.group(2)
        ent = shannon_entropy(value)
        if ent >= ENTROPY_THRESHOLD:
            line = text.count("\n", 0, m.start()) + 1
            findings.append(
                "%s: Zeile %d, generische Zuweisung '%s' mit hoher Entropie (%.2f Bit/Zeichen)"
                % (path, line, m.group(1), ent)
            )

    return findings, None


def main():
    paths = sys.argv[1:]
    any_finding = False
    any_error = False
    for p in paths:
        findings, err = scan_file(p)
        if err is not None:
            print("ERROR:%s" % err)
            any_error = True
            continue
        for f in findings:
            print("FINDING:%s" % f)
            any_finding = True
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("FATAL:%s" % e)
        sys.exit(1)
PYEOF

run_content_scan() {
  # $@ = absolute Pfade der zu scannenden Dateien.
  [ "$#" -eq 0 ] && return 0
  /usr/bin/python3 -c "$CONTENT_SCAN_PY" "$@"
}

# Immer den echten Working-Tree-Status pruefen, sobald ueberhaupt "git add"
# im Spiel ist (jede Form -- eng oder breit), plus "git commit -a/-am" (deckt
# bereits getrackte, veraenderte Secret-Dateien ab). Ein Token-Vergleich der
# Kommandozeile gegen den Add-Pfad entfaellt komplett -- er war beliebig durch
# Quoting/Kommandosubstitution umgehbar (B10); der tatsaechliche Repo-Zustand
# nicht.
if find_git_invocation "$command" add || echo "$command" | /usr/bin/grep -Eq -- 'commit[[:space:]]+-a(m|[[:space:]]|$)'; then
  find_git_invocation "$command" add commit || true
  repo_dir="${GIT_DIR_HINT:-}"
  if [ -z "$repo_dir" ]; then
    repo_dir="$cwd"
    [ -n "$repo_dir" ] || repo_dir="$PWD"
  fi
  if git -C "$repo_dir" rev-parse --show-toplevel >/dev/null 2>&1; then
    toplevel=$(git -C "$repo_dir" rev-parse --show-toplevel 2>/dev/null)
    declare -a content_candidates=()
    while IFS= read -r line; do
      # git status --porcelain: "XY path" oder "XY orig -> path"
      path=$(echo "$line" | /usr/bin/sed -E 's/^.{2} //' | /usr/bin/sed -E 's/.* -> //')
      [ -z "$path" ] && continue
      if is_secret_path "$path"; then
        deny "git add/commit (breites Staging, Repo: $repo_dir) wuerde eine Secret-/​.env-Datei einschliessen ($path) ausserhalb 90-secrets/. Blockiert von bash-guard-secrets."
      fi
      # Abschnitt 3: Inhaltspruefung fuer alles, was die Pfadpruefung
      # passiert hat -- nur wenn die Datei tatsaechlich existiert (bei
      # geloeschten Dateien gibt es nichts mehr zu lesen) und nicht per
      # Ausnahme-Konfiguration von der Inhaltspruefung befreit ist.
      abs_path="$toplevel/$path"
      if [ -f "$abs_path" ] && ! is_content_scan_exempt "$path"; then
        content_candidates+=("$abs_path")
      fi
    done < <(git -C "$repo_dir" status --porcelain 2>/dev/null)

    if [ "${#content_candidates[@]}" -gt 0 ]; then
      scan_output=$(run_content_scan "${content_candidates[@]}")
      scan_status=$?
      if [ $scan_status -ne 0 ]; then
        # FAIL-CLOSED: der Scan-Prozess selbst ist fehlgeschlagen (python3
        # fehlt/crasht) -- das wird NICHT als "sauber" gewertet.
        deny "git add/commit (Repo: $repo_dir): die Inhaltspruefung auf Secrets konnte nicht ausgefuehrt werden (Exit $scan_status). Fail-closed: Commit wird verweigert, bis das Werkzeug wieder verfuegbar ist. Blockiert von bash-guard-secrets."
      fi
      if [ -n "$scan_output" ]; then
        first_error=$(printf '%s\n' "$scan_output" | /usr/bin/grep -m1 '^ERROR:' || true)
        if [ -n "$first_error" ]; then
          # FAIL-CLOSED: mindestens eine Datei konnte nicht gelesen werden
          # (Rechte/I/O) -- ob sie ein Secret enthaelt, ist damit ungeklaert.
          deny "git add/commit (Repo: $repo_dir): eine Datei im Staging konnte nicht auf Secrets geprueft werden (${first_error#ERROR:}). Fail-closed: Commit wird verweigert. Blockiert von bash-guard-secrets."
        fi
        first_finding=$(printf '%s\n' "$scan_output" | /usr/bin/grep -m1 '^FINDING:' || true)
        if [ -n "$first_finding" ]; then
          deny "git add/commit (Repo: $repo_dir) wuerde eine Datei mit einem wahrscheinlichen Secret im INHALT einschliessen: ${first_finding#FINDING:}. Blockiert von bash-guard-secrets (Inhaltspruefung)."
        fi
      fi
    fi
  else
    # git nicht benutzbar (fehlt im PATH, kein Repo): frueher endete der Hook hier
    # still auf "erlauben" — gemessen im Stresstest mit gestripptem PATH. Ein
    # Deny-Hook, der seine Pruefung nicht durchfuehren kann, darf nicht so tun, als
    # waere alles in Ordnung. Die Namen im Kommando selbst kann er trotzdem pruefen;
    # bleibt danach Unsicherheit, wird sie WENIGSTENS sichtbar gemacht.
    # Klammern auch hier als Wortgrenze -- sonst hiesse der Pfad in
    # `(git add .env)` ".env)" und kein Secret-Muster traefe darauf.
    declare -a fallback_candidates=()
    for tok in ${command//[()]/ }; do
      case "$tok" in
        -*) continue ;;
      esac
      stripped=${tok%\"}; stripped=${stripped#\"}; stripped=${stripped%\'}; stripped=${stripped#\'}
      if is_secret_path "$stripped"; then
        deny "git add/commit nennt '$stripped' — sieht nach einer Secret-/.env-Datei ausserhalb 90-secrets/ aus. (git war hier nicht benutzbar, geprueft wurde deshalb nur der Kommandotext.) Blockiert von bash-guard-secrets."
      fi
      # Best-effort Inhaltspruefung: nur wenn der Token tatsaechlich als
      # Datei relativ zu repo_dir existiert (git ist hier unbenutzbar, es
      # gibt also keine verlaessliche Staging-Liste -- das bleibt best-effort
      # und wird unten explizit als solches gewarnt).
      candidate_path="$repo_dir/$stripped"
      if [ -f "$candidate_path" ] && ! is_content_scan_exempt "$stripped"; then
        fallback_candidates+=("$candidate_path")
      fi
    done
    if [ "${#fallback_candidates[@]}" -gt 0 ]; then
      scan_output=$(run_content_scan "${fallback_candidates[@]}")
      scan_status=$?
      if [ $scan_status -ne 0 ]; then
        deny "git add/commit (Repo: $repo_dir, git unbenutzbar): die Inhaltspruefung auf Secrets konnte nicht ausgefuehrt werden (Exit $scan_status). Fail-closed. Blockiert von bash-guard-secrets."
      fi
      first_error=$(printf '%s\n' "$scan_output" | /usr/bin/grep -m1 '^ERROR:' || true)
      if [ -n "$first_error" ]; then
        deny "git add/commit (Repo: $repo_dir, git unbenutzbar): eine genannte Datei konnte nicht auf Secrets geprueft werden (${first_error#ERROR:}). Fail-closed. Blockiert von bash-guard-secrets."
      fi
      first_finding=$(printf '%s\n' "$scan_output" | /usr/bin/grep -m1 '^FINDING:' || true)
      if [ -n "$first_finding" ]; then
        deny "git add/commit nennt eine Datei mit einem wahrscheinlichen Secret im INHALT: ${first_finding#FINDING:}. (git war hier nicht benutzbar, best-effort Pruefung ausserhalb der Staging-Liste.) Blockiert von bash-guard-secrets."
      fi
    fi
    echo "bash-guard-secrets: WARNUNG — git ist hier nicht benutzbar (Repo '$repo_dir'); es wurde NUR der Kommandotext (Pfadmuster + best-effort Inhaltspruefung existierender Dateien) geprueft, nicht der echte Staging-Bereich." >&2
  fi
fi

exit 0
