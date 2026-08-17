"""Prueft NUR den Judge, nicht die Pipeline.

Die Unit-Tests des Workers ersetzen den Judge durch einen Stub - sie beweisen, dass
die Mechanik stimmt, aber nicht, dass das 9B-Modell einen echten Widerspruch
erkennt. Genau das ist hier die Frage. Vier Paare: zwei echte Widersprueche, zwei
harmlose. Ein Detektor, der auf alles anschlaegt, ist so wertlos wie einer, der nie
anschlaegt.
"""
import os
import sys

sys.path.insert(0, os.path.expanduser('~/Knowledge/_meta/tools/gardener'))

from pathlib import Path
from gardener import contradict, ollama, config
from gardener.vault import Note

PAIRS = [
    ("widerspruch", "Modellwahl",
     "Fuer lange, mehrstufige Aufgaben wird immer opus5 mit effort xhigh gespawnt.",
     "Fuer lange, mehrstufige Aufgaben ist sonnet5 der Standard; opus5 wird nie benutzt."),
    ("widerspruch", "Zahl",
     "Der Kontext-Guard warnt den Orchestrator bei 75 Prozent Auslastung.",
     "Der Kontext-Guard warnt den Orchestrator erst bei 90 Prozent Auslastung."),
    ("harmlos", "Ergaenzung",
     "Worker schreiben ihr Ergebnis nach ~/.pi-workers/results/<name>/latest.md.",
     "Auf das Ergebnis wird mit einer Deadline gewartet, nie unbegrenzt."),
    ("harmlos", "Verschiedene Themen",
     "Lokale Modelle laufen ueber Ollama mit 128k Kontext.",
     "Aufnahmen werden fenstergenau gemacht, nie als Vollbild."),
]

client = ollama.OllamaClient()
print(f'Judge: {config.JUDGE_MODEL}   Schwelle: {config.CONTRADICT_MIN_CONFIDENCE}\n')
print(f"{'erwartet':>12} | {'verdikt':>14} | {'konfidenz':>9} | begruendung")
print('-' * 96)

ok = 0
for expected, label, a, b in PAIRS:
    try:
        na = Note(path=Path("/tmp/a.md"), rel="a.md", title=label + " A", text=a)
        nb = Note(path=Path("/tmp/b.md"), rel="b.md", title=label + " B", text=b)
        v = contradict.judge_pair(client, na, nb)
    except Exception as e:
        print(f'{expected:>12} | FEHLER: {e}')
        continue
    verdict = (v or {}).get('verdict', '?')
    conf = (v or {}).get('confidence', 0) or 0
    why = ((v or {}).get('why') or '')[:44]
    fires = verdict == 'contradiction' and conf >= config.CONTRADICT_MIN_CONFIDENCE
    correct = fires if expected == 'widerspruch' else not fires
    ok += correct
    mark = ' ' if correct else '<-- FALSCH'
    print(f'{expected:>12} | {verdict:>14} | {conf:>9.2f} | {why} {mark}')

print(f'\n{ok}/{len(PAIRS)} richtig eingeordnet')
