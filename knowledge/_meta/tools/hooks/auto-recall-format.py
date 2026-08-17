"""Treffer von `brain search --json` in den Recall-Block formen.

Eigene Datei statt `python3 -c "..."`: in doppelten Anfuehrungszeichen
ersetzt die Shell `$`, Backticks und `\\` mitten im Code. Genau daran ist
der Hook am 2026-07-29 haengengeblieben.

Konfiguration kommt ueber die Umgebung (WB_*), die Treffer ueber stdin.
"""
import json, os, sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import auto_recall_filter as filt
except Exception:  # pragma: no cover - der Hook bleibt lieber stumm als laut
    filt = None

THRESHOLD = float(os.environ["WB_THRESHOLD"])
RELATIVE_MARGIN = float(os.environ["WB_RELATIVE_MARGIN"])
MAX_HITS = int(os.environ["WB_MAX_HITS"])
SNIPPET_CHARS = int(os.environ["WB_SNIPPET_CHARS"])

# Die zwei Eingrenzungen (2026-08-10). Fehlt die Umgebung, sind sie aus - der
# Hook verhaelt sich dann exakt wie vorher.
CWD = os.environ.get("WB_CWD", "")
PROMPT = os.environ.get("WB_PROMPT", "")
VAULT = Path(os.environ.get("WB_VAULT") or (Path.home() / "Knowledge"))
PROJECT_PENALTY = float(os.environ.get("WB_PROJECT_PENALTY", "0.03"))
PROSE_MIN = int(os.environ.get("WB_PROSE_MIN", "120"))

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

# Zwei Filter, nicht einer (2026-07-29, nach Messung).
#
# Bisher: filtern nach `cosine`, sortieren nach dem FUSIONIERTEN Score. Das ist
# inkohaerent, und es ist genau der Weg, auf dem themenfremde Notizen hereinkamen:
# ein Treffer, den BM25 wegen ein paar haeufiger Woerter auf Rang 1 hebt, hat oft
# eine cosine knapp ueber der Schwelle und wird trotzdem als bester Treffer
# eingespielt. Gemessen ueber die 37 Eval-Fragen: Praezision 36 %, also zwei von
# drei eingespielten Notizen falsch, bei 2,5 Einspielungen pro Frage.
#
# Deshalb zusaetzlich ein RELATIVER Filter: ein Treffer muss semantisch nah am
# besten Treffer liegen. Ein Feld schwacher Treffer (typisch fuer Gespraechs-
# eingaben wie -mach weiter-) faellt damit ganz weg, statt den schwachen Ersten
# einzuspielen. Der Hook laeuft bei JEDEM Prompt - was er einspielt, kostet in
# jedem Zug Tokens und kann in die Irre fuehren.
hits = list(data.get('hits', []))

# Dritter und vierter Filter (2026-08-10), beide VOR der Schwelle, damit an ihr
# nichts gedreht werden muss.
#
# Der Projektabschlag: laeuft die Sitzung erkennbar in einem Projekt, kostet eine
# Notiz aus einem ANDEREN Projekt einen festen Betrag an Naehe. Sie ist damit nicht
# ausgeschlossen, sie muss nur mehr mitbringen. Globale Notizen, Themenseiten und
# Personen bleiben unberuehrt.
#
# Der Aussage-Filter: eine Seite, die nach Abzug von Verweisen, Ueberschriften und
# Selbstbeschreibung fast nichts Eigenes uebrig laesst, wird nicht eingespielt -
# es sei denn, der Prompt nennt sie beim Namen. Entschieden wird am TEXT der Seite,
# nicht an ihrem Dateinamen.
if filt is not None:
    try:
        project, in_project = filt.detect_project(CWD, VAULT)
        kept = []
        for h in hits:
            rel = h.get('rel', '')
            if filt.foreign_project(rel, project, in_project):
                h['cosine'] = h.get('cosine', 0) - PROJECT_PENALTY
                h['foreign'] = True
            if rel:
                try:
                    text = (VAULT / rel).read_text(encoding='utf-8', errors='replace')
                except OSError:
                    text = ''
                if text and filt.is_contentless(text, h.get('title', ''), PROMPT, PROSE_MIN):
                    continue
            kept.append(h)
        hits = kept
    except Exception:
        pass  # im Zweifel unveraendert weiter: der Hook darf nie der Grund sein

# Fuenfter Filter (2026-08-11): Gueltigkeit. `brain search --json` liefert seit
# dem 10.08. je Treffer mit, wie viele Aussagen einer Notiz der Traum abgeloest
# hat (`retired_claims` von `total_claims`). Fehlen die Felder - aeltere
# braincli, anderer Vault -, passiert hier nichts.
#
# Die Abwertung aus der Suche kommt hier NICHT an, und das ist richtig so: sie
# rechnet auf dem fusionierten `score`, waehrend dieser Hook seit dem 29.07.
# absichtlich nach `cosine` filtert und sortiert (siehe oben). Ihren Faktor auf
# eine cosine zu multiplizieren, die gegen eine feste Schwelle laeuft, waere
# eine Zahl auf einer Skala, fuer die sie nie gemessen wurde.
#
# Stattdessen wird unterschieden. Im Chat liest kein Mensch eine Fussnote,
# sondern ein Agent nimmt den eingespielten Satz fuer wahr, und zwischen ein
# bis drei Zeilen aendert eine Umsortierung ohnehin nichts. Also: ist JEDE
# bekannte Aussage einer Notiz abgeloest, wird sie nicht eingespielt; ist nur
# ein Teil abgeloest, wird sie eingespielt und markiert. Nicht einspielen ist
# kein Ausblenden - ueber `brain search` bleibt die Notiz vollstaendig
# auffindbar, sie draengt sich nur nicht mehr ungefragt in jeden Prompt.
#
# WB_RECALL_VALIDITY: suppress (Vorgabe) | mark (nichts zurueckhalten, nur
# markieren) | off (verhaelt sich wie vor dem 11.08.).
RECALL_VALIDITY = os.environ.get('WB_RECALL_VALIDITY', 'suppress').strip().lower()
if RECALL_VALIDITY not in ('suppress', 'mark', 'off'):
    RECALL_VALIDITY = 'suppress'
if RECALL_VALIDITY != 'off':
    kept = []
    for h in hits:
        try:
            total = int(h.get('total_claims') or 0)
            retired = int(h.get('retired_claims') or 0)
        except (TypeError, ValueError):
            total = retired = 0
        if total <= 0 or retired <= 0:
            kept.append(h)   # der Normalfall: keine Aussage der Notiz im Traum
            continue
        if retired >= total and RECALL_VALIDITY == 'suppress':
            continue
        h['mark'] = f' [abgeloest: {retired} von {total}]'
        kept.append(h)
    hits = kept

hits = [h for h in hits if h.get('cosine', 0) >= THRESHOLD]
if hits:
    best = max(h.get('cosine', 0) for h in hits)
    hits = [h for h in hits if h.get('cosine', 0) >= best - RELATIVE_MARGIN]
    # Nach semantischer Naehe sortieren, nicht nach der Fusion: der Hook soll
    # thematisch passendes Material zeigen, keine Stichwort-Zufallstreffer.
    hits.sort(key=lambda h: h.get('cosine', 0), reverse=True)
hits = hits[:MAX_HITS]
if not hits:
    sys.exit(0)

lines = ['Brain-Recall (automatisch, ungeprueft - Naehe in Klammern; niedrige Werte',
         'bedeuten: vermutlich unpassend, ignorieren):']
if any(h.get('mark') for h in hits):
    lines.append('Ein mit [abgeloest] markierter Treffer enthaelt ueberholte Aussagen -'
                 ' die Quellnotiz pruefen, statt den Satz zu uebernehmen.')
for h in hits:
    title = h.get('title') or h.get('rel', '')
    rel = h.get('rel', '')
    cos = h.get('cosine', 0)
    mark = h.get('mark', '')
    snippet = (h.get('snippet') or '').strip()
    if len(snippet) > SNIPPET_CHARS:
        snippet = snippet[:SNIPPET_CHARS].rstrip() + '...'
    line = f'- {title} ({rel}, {cos:.2f}){mark}'
    if snippet:
        line += f': {snippet}'
    lines.append(line)
print('\n'.join(lines))
