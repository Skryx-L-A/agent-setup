#!/usr/bin/env python3
"""Zaehlt die mechanisch zaehlbaren Merkmale von Maschinentext.

Aufruf:  python3 pruefen.py <datei> [--von "Hallo"] [--bis "Viele Gruesse"]

Ein Zaehler, kein Urteil. Jeder Befund ist eine Stelle zum Nachsehen, keine
Vorschrift. Die Schwellen stammen aus gemessenen Texten, nicht aus Theorie:
Sie stehen in SCHWELLEN und duerfen sich mit der Erfahrung aendern.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys

SCHWELLEN = {
    "median_min": 12,
    "median_max": 20,
    "spanne_min": 18,  # laengster minus kuerzester Satz
    "antithese_max": 1,
    "geviertstrich_max": 0,
}

# Wendungen, die in Modelltext ueberproportional auftreten. Quelle:
# reference/ki-marker.md, Abschnitte 1 und 2.
FLOSKELN = [
    "in der heutigen zeit", "in einer welt, in der", "immer mehr menschen",
    "es ist wichtig zu beachten", "dies könnte hilfreich sein",
    "ein guter weg, dies zu erreichen", "viele experten sind sich einig",
    "abschließend lässt sich sagen", "zusammenfassend", "interessant wird es",
    "spannend ist dabei", "über eine rückmeldung würde ich mich freuen",
    "nicht zuletzt", "darüber hinaus", "es lässt sich festhalten",
]

UEBERNUTZT = [
    "präzise", "strukturell", "nahtlos", "umfassend", "ganzheitlich", "robust",
    "maßgeschneidert", "mehrwert", "zukunftssicher", "essenziell", "eintauchen",
]

WEICHSPUELER = [
    "könnte ich mir vorstellen", "wäre ich bereit", "würde ich gerne",
    "möglicherweise", "unter umständen", "gegebenenfalls",
]


def saetze(text: str) -> list[str]:
    roh = re.split(r"(?<=[.!?])\s+", text)
    return [s.strip() for s in roh if len(s.strip()) > 3]


def befunde(text: str) -> list[tuple[str, str]]:
    """Liefert (schwere, meldung); schwere ist 'hoch' oder 'hinweis'."""
    aus: list[tuple[str, str]] = []
    klein = text.lower()

    s = saetze(text)
    if not s:
        return [("hoch", "Kein Satz gefunden - stimmt der Ausschnitt?")]
    laengen = sorted(len(x.split()) for x in s)
    median = laengen[len(laengen) // 2]
    spanne = laengen[-1] - laengen[0]

    print(f"  {len(text.split())} Woerter, {len(s)} Saetze, "
          f"{laengen[0]} bis {laengen[-1]} Woerter, Median {median}")

    if not SCHWELLEN["median_min"] <= median <= SCHWELLEN["median_max"]:
        aus.append(("hinweis", f"Median {median} liegt ausserhalb von "
                               f"{SCHWELLEN['median_min']} bis {SCHWELLEN['median_max']}"))
    if spanne < SCHWELLEN["spanne_min"]:
        aus.append(("hoch", f"Satzlaenge schwankt zu wenig (Spanne {spanne}). "
                            "Kurze Saetze einstreuen."))

    # Antithese: 'nicht ... sondern' im selben Satz, sowie 'kein X, sondern Y'.
    anti = [x for x in s if re.search(r"\b(nicht|kein\w*)\b[^.!?]{0,80}\bsondern\b",
                                      x, re.IGNORECASE)]
    if len(anti) > SCHWELLEN["antithese_max"]:
        aus.append(("hoch", f"Antithese 'nicht X, sondern Y' {len(anti)}x - "
                            f"erlaubt sind {SCHWELLEN['antithese_max']}"))
        for x in anti:
            aus.append(("hinweis", f"    {x[:90]}"))

    gevier = text.count("—")
    if gevier > SCHWELLEN["geviertstrich_max"]:
        aus.append(("hoch", f"Geviertstrich (—) {gevier}x - im Deutschen "
                            "gehoert dort der Halbgeviertstrich (–)"))

    if '"' in text and "„" not in text:
        aus.append(("hinweis", "Gerade Anfuehrungszeichen ohne ein einziges „ ..."))

    if re.search(r"[\U0001F300-\U0001FAFF☀-➿]", text):
        aus.append(("hoch", "Emoji gefunden - in keinem Text erlaubt"))

    # Vier oder mehr Kommaglieder vor einem 'und' = Verbkette.
    for x in s:
        if x.count(",") >= 3 and re.search(r",\s*und\s+\w+", x):
            aus.append(("hinweis", f"Moegliche Verbkette: {x[:90]}"))

    for gruppe, name in ((FLOSKELN, "Floskel"), (UEBERNUTZT, "uebernutztes Wort"),
                         (WEICHSPUELER, "Weichspueler")):
        for w in gruppe:
            if w in klein:
                aus.append(("hinweis", f"{name}: '{w}'"))

    return aus


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("datei")
    p.add_argument("--von", help="Ab dieser Zeichenkette pruefen")
    p.add_argument("--bis", help="Bis zu dieser Zeichenkette pruefen")
    a = p.parse_args()

    text = pathlib.Path(a.datei).read_text(encoding="utf-8")
    if a.von and a.von in text:
        text = text[text.index(a.von):]
    if a.bis and a.bis in text:
        text = text[:text.index(a.bis)]

    print(f"\n{a.datei}")
    ergebnis = befunde(text)
    hoch = [m for schwere, m in ergebnis if schwere == "hoch"]
    hinweise = [m for schwere, m in ergebnis if schwere == "hinweis"]

    for m in hoch:
        print(f"  BEFUND   {m}")
    for m in hinweise:
        print(f"  hinweis  {m}")
    if not ergebnis:
        print("  nichts gefunden")
    print()
    return 1 if hoch else 0


if __name__ == "__main__":
    sys.exit(main())
