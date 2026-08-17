#!/usr/bin/env python3
"""report.py -- the CONTENT of this document: headings, paragraphs, a table. No sizes,
no colours, no spacing here -- a Pt(...) or an RGBColor(...) in this file means a
decision landed in the wrong place. Mirrors templates/report/report.typ.

    ./build.sh              # writes build/report.docx (+ review via docrender)
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tokens as t
from layout_docx import FIGURE, H1, H2, H3, P, TABLE, build

CONTENT = [
    H1("Ausgangslage"),
    P(
        "Dieser Bericht beschreibt den aktuellen Stand des Projekts und die "
        "nächsten Schritte. Er ist als Vorlage gedacht: Inhalt und Gestaltung "
        "werden für jedes Dokument neu entschieden, nicht aus einer Vorlage "
        "übernommen."
    ),
    P(
        "Ein zweiter Absatz zeigt, wie fließender Text in dieser Vorlage "
        "aussieht -- Randabstand, Zeilenabstand und Schriftgröße kommen "
        "ausschließlich aus tokens.py, nicht aus diesem Text."
    ),
    H2("Zwischenstand"),
    P(
        "Ein Unterabschnitt für den nächsten Gedankenschritt. Überschriften "
        "tragen ihre Ebene durch Gewicht, Fallhöhe und Abstand, nicht allein "
        "durch die Schriftgröße."
    ),
    H3("Kosten im Detail"),
    P(
        "Eine dritte Ebene liest dieselbe Größe wie der Fließtext, in "
        "Versalien und Fettschrift -- sie trägt ihre Stufe durch die Stimme, "
        "nicht durch eine vierte Schriftgröße."
    ),
    TABLE(
        head=["Posten", "Menge", "Betrag"],
        rows=[
            ["Konzeption", "1", "4.200,00"],
            ["Umsetzung", "3", "12.600,00"],
            ["Abnahme", "1", "1.800,00"],
        ],
    ),
    H1("Empfehlung"),
    P(
        "Der letzte Abschnitt hält die Empfehlung fest. Ein Bericht wie dieser "
        "wird Seite für Seite gleich gesetzt -- Variation ist hier ein Fehler, "
        "nicht ein Stilmittel."
    ),
]

if __name__ == "__main__":
    build(
        t,
        CONTENT,
        meta=dict(
            title="Projektbericht Q3",
            subtitle="Zwischenstand und Empfehlung",
            autor="M. Beispiel",
            datum="2026-07-29",
            version="1.0",
        ),
        out_path="build/report.docx",
    )
    print("wrote build/report.docx")
