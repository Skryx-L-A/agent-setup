#!/usr/bin/env python3
"""Notiz-Lint: Pflichtfelder neuer und geaenderter Wissensnotizen (v2-ki-nutzung #4, 2026-09-24).

Prueft, was `AGENTS.md` ("Schreiben") verlangt: Frontmatter mit `title`, `type`,
`created`, `beleg` (gemessen|berichtet) und als erste Textzeile "Für künftige Sessions".
Gemessen am 24.09. fehlte bei neuen Notizen seit 25.08. `beleg` in 53 %, `created` in 30 %,
die erste Zeile in 26 % (eval/v2-ki-nutzung/BEFUNDE.md). Nur eine WARNUNG, nie eine Blockade.

Dazu der Schema-4-Lint (`gardener/gardener/schema.py`, eine Definition fuer Hook, Gaertner-Lint
und `brain doctor`): Pflichtfelder id/schema/class/type, Typ-Vokabular, Klasse gegen Pfad
(sessions/ und 00-sources/ => source), doppelte Frontmatter-Bloecke, Claude-Memory-Felder. Im
Commit gilt jede vorgemerkte Datei als "neu": der Autor sieht seine eigenen Verstoesse, der
Bestand wird hier nie gemeldet.

Geprueft werden nur Wissensnotizen unter 10-global/, 20-projects/, 30-topics/, 40-people/,
nicht Quellen (00-sources/, jedes sessions/), KERN/MOC/STATUS, erzeugte Seiten
(`class: derived`, `gardener-generated`) und _assets/.

Zwei Wege:
- `pre-commit` (git-hooks/): Namen der vorgemerkten Dateien auf stdin (NUL-getrennt),
  `--top` = Wurzel des Repos (Kern, Kern-Worktree oder Space), `--vault` = Vault-Wurzel;
  gelesen wird der vorgemerkte Stand (`git show :pfad`).
- `braincli.doctor` importiert `pruefe()` und `ist_wissensnotiz()`.

Dazu der KERN-Hinweis (Idee 3, 2026-10-14): steht ein `20-projects/<p>/KERN.md` im Commit und
waechst dabei oder liegt ueber dem Budget (3200 Zeichen Koerper), kommt eine Zeile auf stderr.
Nur Text: der Commit geht immer durch. Schalter: BRAIN_KERN_HINWEIS=0.

Nur Standardbibliothek: der Hook laeuft mit dem System-python3.
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys

# `branch` ist seit Schema 4 (Vorlage 2026-09-28) optional: es ist aus dem Pfad ableitbar (435/435 gleich)
PFLICHT = ("title", "type", "created", "beleg")
BELEG_WERTE = ("gemessen", "berichtet")
ZWEIGE = ("10-global/", "20-projects/", "30-topics/", "40-people/")
AUSGENOMMEN_NAMEN = {"KERN.md", "MOC.md", "STATUS.md", "README.md", "brain-vorschlaege.md",
                     "review-queue.md", "DECISIONS.md"}  # DECISIONS.md: vom Gärtner erzeugt
ERSTE_ZEILE = ("Für künftige Sessions", "Fuer kuenftige Sessions")
# KERN-Hinweis: Budget wie braincli.doctor._kern und session-context.sh (Vorgabe 3200 Zeichen)
KERN_BUDGET = 3200
KERN_PFAD = re.compile(r"^20-projects/[^/]+/KERN\.md$")


def ist_wissensnotiz(rel: str) -> bool:
    """rel: Pfad relativ zur Vault-Wurzel, mit `/`."""
    if not rel.endswith(".md") or not rel.startswith(ZWEIGE):
        return False
    teile = rel.split("/")
    if "sessions" in teile[:-1] or "_assets" in teile or any(t.startswith(".") for t in teile):
        return False
    return teile[-1] not in AUSGENOMMEN_NAMEN


def pruefe(text: str) -> list[str]:
    """Liste fehlender Punkte; leer = in Ordnung. Erzeugte Seiten liefern immer []."""
    fm = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n", text, re.S)
    if not fm:
        return ["kein Frontmatter"]
    kopf = fm.group(1)
    felder = {k: re.sub(r"\s+#.*$", "", v).strip()   # Vorlage traegt "# ..."-Kommentare
              for k, v in re.findall(r"^([A-Za-z_-]+):[ \t]*(.*)$", kopf, re.M)}
    if felder.get("class", "").strip() == "derived" or "gardener-generated" in felder:
        return []
    if felder.get("class", "").strip() == "source":   # Quelle ausserhalb von sessions/: nie umschreiben
        return []
    fehlt = [f for f in PFLICHT if not felder.get(f, "").strip() and f not in _listenfelder(kopf)]
    fehlt += _yaml_stolpersteine(kopf)
    beleg = felder.get("beleg", "").strip().strip("'\"")
    if beleg and beleg not in BELEG_WERTE:
        fehlt.append(f"beleg '{beleg}' statt gemessen|berichtet")
    body = text[fm.end():]
    erste = next((z.strip() for z in body.splitlines() if z.strip() and not z.lstrip().startswith("#")), "")
    if not erste.startswith(ERSTE_ZEILE):
        fehlt.append('erste Zeile nicht "Für künftige Sessions"')
    return fehlt


def _yaml_stolpersteine(kopf: str) -> list[str]:
    """Ungequotete Werte, an denen ein YAML-Parser scheitert (ohne PyYAML, der Hook laeuft mit System-python3):
    `: ` oder `:` am Ende im Wert (\"mapping values are not allowed\") und Werte, die mit ` oder @ beginnen
    (reservierte Zeichen). Gemessen 09.10.: genau diese Regel traf die 14 Notizen mit kaputtem Frontmatter, ohne
    Fehlalarm; der Gaertner-Parser liest sie tolerant, YAML-Werkzeuge (Brain-App, pyyaml) nicht."""
    aus = []
    for k, v in re.findall(r"^([A-Za-z_-]+):[ \t]+(.+)$", kopf, re.M):
        v = re.sub(r"\s+#.*$", "", v).strip()
        if v and v[0] not in "\"'[{|>" and (": " in v or v.endswith(":") or v[0] in "`@"):
            aus.append(f"YAML: Wert von '{k}' ungequotet (Anfuehrungszeichen setzen)")
    return aus


def _listenfelder(kopf: str) -> set[str]:
    """Felder, deren Wert als YAML-Liste in den Folgezeilen steht (`aliases:\\n- x`)."""
    return set(re.findall(r"^([A-Za-z_-]+):[ \t]*\r?\n[ \t]*- ", kopf, re.M))


def lade_schema():
    """`gardener/schema.py` dieses Vaults (Nachbarordner von git-hooks/), oder None."""
    import importlib.util
    pfad = os.path.join(os.path.dirname(os.path.realpath(__file__)), os.pardir, "gardener",
                        "gardener", "schema.py")
    if not os.path.isfile(pfad):
        return None
    try:
        spec = importlib.util.spec_from_file_location("brain_schema_lint", pfad)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod        # @dataclass braucht das Modul in sys.modules
        spec.loader.exec_module(mod)
        return mod
    except Exception:
        return None


def schema_zaehlung(vault: str, beispiele: int = 5) -> dict | None:
    """Fuer `brain doctor`: Schema-Verstoesse im ganzen Vault, neu (created ab Stichtag) und Bestand
    GETRENNT gezaehlt, damit der Altbestand die neuen Verstoesse nicht zudeckt. None ohne schema.py."""
    schema = lade_schema()
    if schema is None:
        return None
    b = schema.scan_vault(vault)
    return {"geprueft": b.geprueft, "stichtag": schema.STICHTAG,
            "neu": len(b.neu), "bestand": len(b.bestand),
            "neu_je_art": b.je_art(b.neu), "bestand_je_art": b.je_art(b.bestand),
            "beispiele_neu": [f"{n.rel}: {n.text()}" for n in b.neu[:beispiele]]}


def _blobs(top: str, objekte: list[str]) -> list[str | None]:
    """Inhalt mehrerer git-Objekte (`:pfad` = Index, `HEAD:pfad` = letzter Commit) in EINEM git-Aufruf
    (`cat-file --batch`): ein Aufruf je Datei kostete bei 50 Dateien 1,4 s, so bleibt ein Commit unter
    einer halben Sekunde. None, wo das Objekt fehlt."""
    if not objekte:
        return []
    eingabe = "".join(f"{o}\n" for o in objekte).encode("utf-8")
    r = subprocess.run(["git", "-C", top, "cat-file", "--batch"], input=eingabe, capture_output=True)
    out: list[str | None] = []
    daten, pos = r.stdout, 0
    for _ in objekte:
        ende = daten.find(b"\n", pos)
        if ende == -1:
            out.append(None)
            continue
        kopf = daten[pos:ende].split()
        pos = ende + 1
        if len(kopf) != 3 or kopf[1] != b"blob":          # `<name> missing` u.a.
            out.append(None)
            continue
        groesse = int(kopf[2])
        out.append(daten[pos:pos + groesse].decode("utf-8", errors="replace"))
        pos += groesse + 1
    return out


def _staged_alle(top: str, namen: list[str]) -> dict[str, str]:
    """Vorgemerkter Stand mehrerer Dateien in EINEM git-Aufruf (siehe `_blobs`)."""
    if not namen:
        return {}
    texte = _blobs(top, [f":{n}" for n in namen])
    return {n: t for n, t in zip(namen, texte) if t is not None}


def kern_koerper(text: str) -> int:
    """Zeichen des KERN-Koerpers: der Text ohne Frontmatter, gezaehlt wie `braincli.doctor._kern`."""
    if text.startswith("---\n") and "\n---\n" in text[4:]:
        text = text[4:].split("\n---\n", 1)[1]
    return len(text)


def kern_hinweise(top: str, praefix: str, namen: list[str]) -> list[str]:
    """Eine Zeile je vorgemerkter KERN.md, die ueber dem Budget liegt (Zuwachs im Commit steht dabei). `praefix` wie in
    main(). Ohne KERN im Commit kein git-Aufruf."""
    if os.environ.get("BRAIN_KERN_HINWEIS", "1") == "0":
        return []
    kerns = [n for n in namen if KERN_PFAD.match(praefix + n)]
    if not kerns:
        return []
    # Index und HEAD in einem git-Aufruf: jeder Aufruf kostet gemessen rund 12 ms Startzeit (macOS)
    blobs = _blobs(top, [f":{n}" for n in kerns] + [f"HEAD:{n}" for n in kerns])
    neu, alt = blobs[:len(kerns)], blobs[len(kerns):]
    hinweise = []
    for n, text, vorher_text in zip(kerns, neu, alt):
        if text is None:
            continue
        zeichen = kern_koerper(text)
        vorher = kern_koerper(vorher_text) if vorher_text is not None else 0
        if zeichen <= KERN_BUDGET:
            continue
        zusatz = f", +{zeichen - vorher} in diesem Commit" if zeichen > vorher else ""
        hinweise.append(f"KERN-Hinweis: {praefix + n}: {zeichen} Zeichen, Budget {KERN_BUDGET}{zusatz}. "
                        "Neue Lehren nach FALLEN.yaml oder in eine Entscheidungsnotiz statt in den KERN; "
                        "Älteres aus dem KERN kürzen. Nur ein Hinweis, der Commit geht durch.")
    return hinweise


def _staged(top: str, rel: str) -> str | None:
    r = subprocess.run(["git", "-C", top, "show", f":{rel}"], capture_output=True)
    if r.returncode != 0:
        return None
    return r.stdout.decode("utf-8", errors="replace")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--top", required=True)
    ap.add_argument("--vault", required=True)
    a = ap.parse_args(argv)
    if os.environ.get("BRAIN_NOTIZ_LINT", "1") == "0":
        return 0
    top, vault = os.path.realpath(a.top), os.path.realpath(a.vault)
    praefix = os.path.relpath(top, vault).replace(os.sep, "/")
    praefix = "" if praefix == "." else praefix + "/"
    namen = [n for n in sys.stdin.read().split("\0") if n.strip()]
    schema = lade_schema()
    befunde = []
    relevant = [n for n in namen if ist_wissensnotiz(praefix + n)
                or (schema is not None and schema.im_geltungsbereich(praefix + n))]
    texte = _staged_alle(top, relevant)
    for n in relevant:
        rel = praefix + n
        alt = ist_wissensnotiz(rel)
        neu = schema is not None and schema.im_geltungsbereich(rel)
        text = texte.get(n)
        if text is None:
            continue
        fehlt = pruefe(text) if alt else []
        if neu:
            fehlt += [b.detail for b in schema.pruefe(rel, text)]
        if fehlt:
            befunde.append(f"  {rel}: " + ", ".join(fehlt))
    if befunde:
        print("Notiz-Lint (Warnung, blockiert nicht; Regeln: AGENTS.md \"Schreiben\", "
              "Vorlagen _meta/templates/):", file=sys.stderr)
        print("\n".join(befunde), file=sys.stderr)
    hinweise = kern_hinweise(top, praefix, namen)       # nach dem Lint: ein Fehler hier nimmt ihm nichts
    if hinweise:
        print("\n".join(hinweise), file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
