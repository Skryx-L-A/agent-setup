#!/usr/bin/env python3
"""deck.py -- the CONTENT of this deck: slides, headings, bullets, notes. No sizes,
no colours, no positions here. Mirrors templates/deck/deck.typ.

    ./build.sh              # writes build/deck.pptx (+ review via docrender)
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tokens as t
from layout_pptx import CONTENT, IMAGE, SECTION, TITLE, build

SLIDES = [
    TITLE(
        "Projektbericht Q3",
        subtitle="Zwischenstand und Empfehlung",
        notes="Begrüßung, Rahmen des Vortrags: fünf Minuten, Entscheidung am Ende.",
    ),
    SECTION("Ausgangslage", notes="Kurzer Rückblick auf die letzten vier Wochen."),
    CONTENT(
        "Woran gearbeitet wurde",
        bullets=[
            "Konzeption abgeschlossen, mit dem Kunden abgestimmt",
            "Umsetzung läuft, drei von fünf Modulen fertig",
            "Abnahme für Modul 1 terminiert",
        ],
        notes=(
            "Hier auf die Konzeptionsphase eingehen: was war die zentrale Entscheidung, "
            "und warum hat sie zwei Wochen gedauert statt einer."
        ),
    ),
    CONTENT(
        "Zahlen im Überblick",
        bullets=[
            "Budget: 18.600,00 EUR, davon 60% gebunden",
            "Zeitplan: eine Woche Verzug gegenüber Angebot",
            "Risiko: eine offene Abhängigkeit von der Kunden-IT",
        ],
    ),
    IMAGE(
        "Fortschritt nach Modul",
        path="bilder/beispiel.png",
        caption="Lokal erzeugte Abbildung, kein Stockfoto.",
    ),
    SECTION("Empfehlung"),
    CONTENT(
        "Nächste Schritte",
        bullets=[
            "Modul 1 abnehmen, Zahlung anstoßen",
            "Kunden-IT-Abhängigkeit bis Freitag klären",
            "Nächstes Update in zwei Wochen",
        ],
        notes="Klare Entscheidung einfordern: Freigabe für Modul 2 heute oder Verzug um eine Woche.",
    ),
]

if __name__ == "__main__":
    build(t, SLIDES, out_path="build/deck.pptx")
    print("wrote build/deck.pptx")
