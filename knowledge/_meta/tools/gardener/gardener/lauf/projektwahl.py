"""Project for units the routing rules left empty (p2, j2 measurement c).

Stage ``projektwahl`` of `brain run`, between ``grossmodell`` and
``abgleichen``; it looks only at units without project that have packages.

1. Rules again: the routing (``quellen.Router``) may know more now than at
   harvest (new ``projekte.tsv`` lines, a foreign remote falling back to the
   folder name, worker prefixes).  A rule hit is a fact: the unit and its
   packages get the project, packages that ended ``ohne-ziel`` start over
   (``Buch.projekt_zuordnen``).
2. The gap filler: one Jev-style choice question over the vault projects plus
   ``keins`` (``gemma4:12b`` on peer, stage ``projektwahl`` in ``engines.yaml``).
   Its answer is only a proposal: it goes to ``projekt_vorschlag`` of the unit
   and, via ``schreiben``, to the review queue, never into ``projekt``,
   FALLEN.yaml or KERN.md.  The probability is not calibrated (j2: wrong
   answers came with p >= 0.94), so no threshold is applied.
   ``BRAIN_PROJEKT_LUECKE=0`` switches the model part off.

Measured (j2, test half, 63 units): rules alone 0.49, rules + gemma4:12b for
the gap 0.87 (+0.38 [+0.24; +0.52]), 2.9 s per question on the Mac without
load.
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Callable

from ..engines import EngineError, Question
from .buch import Buch
from .quellen import Leser, Router, einheit_text
from .stufen import Fortschritt, StufenErgebnis, _klassen, _noop, key_of

FRAGE = "Zu welchem Projekt gehört dieser Text?"
KEINS = "keins"
TEXT_MAX = 3000
# Option texts of the measurement (eval/jev-pipeline/bewerte_c.py); only
# projects with a folder under 20-projects/ are offered.
PROJEKTE = {
    "a machine-bound project": "Handelsbot ProjectX, eToro-Konten, Runner, Deploy-Gate",
    "claude-workbench": "Werkbank: Worker, tmux, wb-Werkzeuge, Electron/Mac-App, Registry",
    "companion": "Companion: Rust-Daemon, Sprachassistent, Mac-Shell, Sitzungsaufsicht",
    "myproject": "myproject: Telefonassistent fuer Praxen, Datenschutz, Gruendung, Webseite",
    "brain3": "Wissensspeicher/Vault, brain-CLI, Gardener, Traum-Pipeline, Forgejo",
    "praktikumssuche": "Praktikums-/Werkstudentensuche, Bewerbungen, Anschreiben",
    "firma-x": "Werkstudentenstelle bei Firma-X, Onboarding",
    "studienwahl": "Studienwahl, Hochschule X, Vorkurse, Wohnungssuche",
    "a project": "another service/a project: Diktier-App, Whisper, Installer",
    "lumenpt": "LumenPT: Minecraft-Shader, Pfadverfolgung, Szenen",
    "scout": "scout",
    "ttsapp": "TTS-App, Sprachausgabe",
    "uebersetzer": "Uebersetzer: ESP32-Hardware, Mikrofone, Firmware",
    "autoresearch": "autoresearch: automatisierte Trainingslaeufe, train.py",
    "zasterzentrale": "Zasterzentrale: Finanzen",
    "project-kit": "project-kit: Projektvorlagen und Skills",
    "feingeister": "Feingeister Schul-KI-System",
    "ltx-2-mlx": "LTX-2 Videogenerierung auf MLX",
    "a project": "a project: Spielfiguren und Dialoge",
    "anlass": "anlass: Anlass-Texte, Entwuerfe",
    "claude-setup": "Hausanweisungen, CLAUDE.md, Rollen, Skills, Harness-Adapter",
    "<projekt>": "<projekt>: Kontaktaufnahme",
    "odysseus": "odysseus",
}
KEINS_TEXT = "kein Projekt: allgemeine Arbeitsregel, Maschinenpflege, Recherche ohne Projektbezug"


def aktiv() -> bool:
    return os.environ.get("BRAIN_PROJEKT_LUECKE", "1").strip() != "0"


def optionen(vault: Path) -> list[tuple[str, str]]:
    """(project or ``keins``, option text) in question order."""
    root = Path(vault) / "20-projects"
    out = [(p, f"{p}: {text}") for p, text in PROJEKTE.items() if (root / p).is_dir()]
    return out + [(KEINS, f"{KEINS}: {KEINS_TEXT}")]


def zustand(row, text: str) -> str:
    return f"Quelle: {row['source_class']}\nPfad: {row['path']}\nText:\n{text[:TEXT_MAX]}"


def projektwahl(buch: Buch, *, motoren, leser: Leser, router: Router, vault: Path,
                lauf_id: str | None, limit: int | None = None,
                stop: Callable[[], bool] = lambda: False,
                fortschritt: Fortschritt = _noop, klassen=None,
                projekt: str | None = None) -> StufenErgebnis:
    result = StufenErgebnis("projektwahl")
    if projekt is not None:         # `--projekt p` selects units that have one
        return result
    rows = buch.ohne_projekt(classes=_klassen(klassen), limit=limit)
    if not rows:
        return result
    vault_projekte = {p.name for p in (Path(vault) / "20-projects").iterdir() if p.is_dir()} \
        if (Path(vault) / "20-projects").is_dir() else set()
    wahl = optionen(vault)
    frage = Question(FRAGE, "choice", [text for _, text in wahl], mit_unklar=False)
    decide = modell = None
    if aktiv():
        if motoren is not None and motoren.verfuegbar("projektwahl"):
            decide, modell = motoren.decider("projektwahl")
        else:
            result.uebersprungen = "keine erreichbare Maschine (nur Regeln)"
    regel: dict[str, str | None] = {}
    for n, row in enumerate(rows, 1):
        if stop():
            result.abgebrochen = True
            break
        key = key_of(row)
        started = time.perf_counter()
        quelle = row["quell_id"]
        if quelle not in regel:
            try:
                regel[quelle] = router.route(row["source_class"], row["path"], row["maschine"] or "lokal")[0]
            except OSError:
                regel[quelle] = None
        treffer = regel[quelle]
        if treffer and treffer in vault_projekte:
            buch.projekt_zuordnen(key, treffer)
            result.zaehle("regel")
        elif decide is not None:
            text = einheit_text(row, leser)
            if text is None:
                buch.projekt_vorschlag_merken(key, {"projekt": None, "grund": "text-fehlt",
                                                    "lauf_id": lauf_id})
                result.zaehle("text-fehlt")
            else:
                try:
                    answer = decide(zustand(row, text), [frage])[0]
                except EngineError as exc:
                    buch.conn.rollback()
                    result.fehlschlaege += 1
                    result.fehler.append(f"{key}: {type(exc).__name__}: {exc}")
                    result.uebersprungen = "Motor nicht erreichbar (nur Regeln)"
                    decide = None       # the rest waits for the next run
                    continue
                index = frage.options.index(answer.choice)
                name = wahl[index][0]
                buch.projekt_vorschlag_merken(key, {
                    "projekt": None if name == KEINS else name,
                    "p": round(answer.probabilities[answer.choice], 3),
                    "modell": modell, "lauf_id": lauf_id})
                result.zaehle("vorschlag" if name != KEINS else KEINS)
        else:
            continue                    # no rule, no model: stays for the next run
        buch.commit()
        result.bearbeitet += 1
        result.sekunden.append(time.perf_counter() - started)
        result.einheiten.append(str(key))
        fortschritt("projektwahl", n, len(rows))
    return result

