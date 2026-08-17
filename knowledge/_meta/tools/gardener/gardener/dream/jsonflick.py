"""Flickt JSON, das ein Modell durch woertliches Zitieren kaputt gemacht hat.

Eigenes Modul, weil zwei Stellen dieselbe Reparatur brauchen und keine von
ihnen von der anderen abhaengen soll: `extract` liest Antworten mit Zitaten
aus dem Vault, `reconcile` liest Urteile mit einem freien Begruendungssatz.
`reconcile._parse_result` trug den Kommentar, es dupliziere die Toleranz von
`extract` bewusst, "this module must keep working while extract.py is being
changed on another branch". Das Anliegen bleibt richtig, die Duplikation war
die schlechtere Antwort darauf: Ein kleines, stabiles Modul, von dem beide
abhaengen, koppelt sie nicht aneinander.

Der gemeinsame Grund aller drei Schadensbilder: Ein Modell soll woertlich
zitieren, und der zitierte Text kennt die Regeln von JSON nicht.

Gemessen am 12.08.2026 im Traum-Kaltstart. Die Antwort eines Buendels war
22.432 Zeichen lang und brach bei 6.108:

    "quote": "erkennt „mein Autostash konnte nicht zurueckgespielt werden" allein

Ein deutsches Anfuehrungszeichen unten als Oeffner, ein schlichtes
ASCII-Zeichen als Schliesser - woertlich kopiert beendet dieses die
JSON-Zeichenkette mitten im Zitat. Rund ein Viertel aller Buendel traf es,
jedes kostete zwei weitere Generierungen und einen Wolkenaufruf.
"""
from __future__ import annotations

import json

MAX_REPARATUREN = 40


def flicke(text: str, max_reparaturen: int = MAX_REPARATUREN
           ) -> tuple[str, int, bool]:
    """Gibt (Text, Zahl der Reparaturen, hat_geparst) zurueck.

    Drei Schadensbilder:

    - `... delimiter`: ein schlichtes Anfuehrungszeichen hat die Zeichenkette
      zu frueh geschlossen. Es wird maskiert.
    - `Invalid \\escape`: ein Rueckwaertsstrich, der in JSON keine gueltige
      Folge einleitet, etwa `\\'95\\'` aus einem zitierten Shell-Schnipsel.
      Er wird verdoppelt.
    - `Invalid control character`: ein echter Zeilenumbruch oder Tabulator
      mitten in der Zeichenkette. Er wird durch seine Ersatzdarstellung
      ersetzt.

    Das Aufgeben-Verhalten ist der Teil, der schon einmal falsch war. Die
    erste Fassung gab bei einem unbekannten Fehler den URTEXT zurueck und warf
    damit jede schon gelungene Reparatur weg; das nachgelagerte Rettungsnetz
    bekam dann eine Antwort, die im ersten Zitat abbrach. Gemessen in Fenster
    3 des Kaltstarts: drei Buendel blieben in Quarantaene, die im Nachbau alle
    reparierbar waren. Jetzt bleibt Teilarbeit erhalten, aber `hat_geparst`
    sagt ehrlich, dass sie nicht reicht - wer sie nimmt, prueft selbst nach.
    """
    kandidat = text
    reparaturen = 0
    while reparaturen < max_reparaturen:
        try:
            json.loads(kandidat)
            return kandidat, reparaturen, True
        except json.JSONDecodeError as e:
            if e.pos < 0 or e.pos > len(kandidat):
                break
            neu = _eine_reparatur(kandidat, e)
            if neu is None:
                break
            kandidat = neu
            reparaturen += 1
        except ValueError:
            break
    return (kandidat if reparaturen else text), reparaturen, False


def _ist_maskiert(text: str, i: int) -> bool:
    """Ob das Zeichen an Stelle `i` wirklich maskiert ist. Gezaehlt wird, wie
    viele Rueckwaertsstriche unmittelbar davor stehen: eine GERADE Zahl heisst
    unmaskiert, weil sie sich paarweise selbst maskieren.

    Die erste Fassung prueft nur das eine Zeichen davor und hielt deshalb das
    Anfuehrungszeichen in `\\\\"` fuer maskiert - dort ist aber der
    Rueckwaertsstrich maskiert und das Anfuehrungszeichen frei. Gemessen am
    12.08.2026 an einem zitierten SSH-Aufruf (`ssh a \\\\"ssh b ...`), dem
    einzigen Buendel, das Fenster 4 noch verlor."""
    n = 0
    j = i - 1
    while j >= 0 and text[j] == "\\":
        n += 1
        j -= 1
    return n % 2 == 1


def _eine_reparatur(text: str, e: json.JSONDecodeError) -> str | None:
    """Ein Schaden, ein Schnitt. None heisst: unbekanntes Bild, Finger weg."""
    if "delimiter" in e.msg or "property name" in e.msg:
        i = e.pos - 1
        while i >= 0 and text[i] != '"':
            i -= 1
        if i < 0 or _ist_maskiert(text, i):
            return None
        return text[:i] + '\\"' + text[i + 1:]
    if "Invalid \\escape" in e.msg:
        if e.pos >= len(text) or text[e.pos] != "\\":
            return None
        return text[:e.pos] + "\\\\" + text[e.pos + 1:]
    if "Invalid control character" in e.msg:
        if e.pos >= len(text):
            return None
        ersatz = {"\n": "\\n", "\r": "\\r", "\t": "\\t"}.get(text[e.pos])
        if ersatz is None:
            ersatz = f"\\u{ord(text[e.pos]):04x}"
        return text[:e.pos] + ersatz + text[e.pos + 1:]
    return None


def lade_mit_flicken(text: str) -> tuple[dict, int]:
    """`json.loads` fuer eine Modellantwort, mit Reparatur als zweitem
    Versuch. Wirft den URSPRUENGLICHEN Fehler weiter, wenn nichts half - die
    spaetere Meldung waere sonst die des geflickten Texts und wuerde die
    Fehlersuche in die Irre schicken."""
    try:
        return json.loads(text), 0
    except json.JSONDecodeError:
        geflickt, n, ganz = flicke(text)
        if not ganz:
            raise
        return json.loads(geflickt), n
