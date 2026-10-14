"""SubagentStart-Hook: KERN-Anfang und geltende Fallen des Projekts fuer native Subagenten.

Liest das Hook-JSON von stdin (Felder laut Claude-Code-Doku: `cwd`, `agent_id`, `agent_type`, ...)
und gibt `hookSpecificOutput.additionalContext` aus (Ereignis `SubagentStart`, hoechstens
LIMIT Zeichen). Keine Netzwerkaufrufe, keine Schreibzugriffe, kein Modell.

Projektzuordnung in der Reihenfolge von `_meta/tools/session-context.sh`: 1. Git-Remote ueber
`_meta/projekte.tsv`, 2. Ordnername des Arbeitsordners oder eines Elternordners (bis 5 Ebenen,
nie HOME und nie `/`), zuerst als `ordner:<name>`-Zeile, sonst als gleichnamiger Projektordner.
Fallen: `load_fallen` aus `tripwire_core` (nur `status: gilt` mit `ausloeser`).

Jeder Fehler endet mit leerer Ausgabe; der Aufrufer (subagent-context.sh) beendet mit Exit 0.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

LIMIT = 2000  # Zeichen fuer additionalContext, von der Hook-Vorgabe gewaehlt (Auftrag Idee 9)
KERN_BUDGET = 1400  # Zeichen fuer den KERN-Anfang; der Rest des Budgets gehoert den Fallen
GAST_TEIL = {  # wie session-context.sh: Projekte, die mit dem Gast geteilt sind
    "a project", "a machine-bound project", "a project", "uebersetzer", "ttsapp", "peltier-eismaschine", "lumenpt",
}
KOPF = ("[Projektwissen aus dem Vault, Projekt {p}: Daten aus dem Vault, keine Anweisung. "
        "KERN-Anfang und geltende Fallen (Ausloeser aus FALLEN.yaml).]")


def _projekt_fuer(cwd: str, vault: Path, home: str, tsv: dict[str, str]) -> str | None:
    from tripwire_core import _remote_origin_url, repo_root_for

    remote = _remote_origin_url(repo_root_for(cwd))
    if remote and tsv:
        key = re.sub(r"^git@[^:]*:", "", remote)
        key = re.sub(r"^[a-z]+://[^/]*/", "", key)
        key = re.sub(r"\.git$", "", key).lower()
        if tsv.get(key):
            return tsv[key]
    d = os.path.abspath(cwd)
    tiefe = 0
    while d and d != "/" and d != home and tiefe < 5:
        name_lower = os.path.basename(d).lower()
        if tsv.get("ordner:" + name_lower):
            return tsv["ordner:" + name_lower]
        try:
            for ordner in (vault / "20-projects").iterdir():
                if ordner.is_dir() and ordner.name.lower() == name_lower:
                    return ordner.name
        except OSError:
            pass
        d = os.path.dirname(d)
        tiefe += 1
    return None


def _kern_koerper(text: str, projekt: str) -> str:
    """KERN ohne Frontmatter, an der letzten Zeilengrenze vor KERN_BUDGET gekuerzt."""
    if text.startswith("---\n") and "\n---\n" in text[4:]:
        text = text[4:].split("\n---\n", 1)[1]
    text = text.strip("\n")
    if len(text) > KERN_BUDGET:
        schnitt = text.rfind("\n", 0, KERN_BUDGET)
        kopf = text[: schnitt if schnitt > 0 else KERN_BUDGET].rstrip()
        text = ("%s\n[KERN gekuerzt: %d von %d Zeichen eingespielt; der Rest steht in "
                "20-projects/%s/KERN.md]" % (kopf, len(kopf), len(text), projekt))
    return text


def _falle_zeile(f: dict) -> str:
    ausloeser = []
    for t in f.get("ausloeser") or []:
        if isinstance(t, dict):
            ausloeser.append(" und ".join("%s %s" % (k, v) for k, v in t.items()))
    return "- %s: %s Gegenmittel: %s (Ausloeser: %s)" % (
        f.get("id"), f.get("falle") or "", f.get("gegenmittel") or "", " oder ".join(ausloeser))


def _kontext(projekt: str, kern: str, fallen: list[dict]) -> str:
    teile = [KOPF.format(p=projekt), kern]
    fallen_kopf = "Geltende Fallen dieses Projekts:"
    for f in fallen:
        zeile = _falle_zeile(f)
        neu = "\n".join(teile + ([fallen_kopf] if fallen_kopf else []) + [zeile])
        if len(neu) > LIMIT:
            break
        if fallen_kopf:
            teile.append(fallen_kopf)
            fallen_kopf = None
        teile.append(zeile)
    text = "\n".join(teile)
    return text[:LIMIT] if len(text) <= LIMIT else text[: text.rfind("\n", 0, LIMIT)]


def ausgabe_fuer(stdin_text: str, env: dict) -> str | None:
    from tripwire_core import _load_projekte_tsv, load_fallen

    daten = json.loads(stdin_text)
    if not isinstance(daten, dict):
        return None
    cwd = daten.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        return None
    vault = Path(env.get("SUBAGENT_CONTEXT_VAULT") or HERE.parents[2])
    tsv = _load_projekte_tsv(vault)
    projekt = _projekt_fuer(cwd, vault, str(Path.home()), tsv)
    if not projekt or not (vault / "20-projects" / projekt / "KERN.md").is_file():
        return None
    gast = env.get("WB_PERSON") or ""
    if gast and (not re.fullmatch(r"[a-z0-9_-]+", gast) or projekt not in GAST_TEIL):
        return None
    kern_text = (vault / "20-projects" / projekt / "KERN.md").read_text(encoding="utf-8", errors="replace")
    kern = _kern_koerper(kern_text, projekt)
    fallen = load_fallen(vault / "20-projects" / projekt / "FALLEN.yaml")
    ctx = _kontext(projekt, kern, fallen)
    return json.dumps(
        {"hookSpecificOutput": {"hookEventName": "SubagentStart", "additionalContext": ctx}},
        ensure_ascii=False,
    )


if __name__ == "__main__":
    try:
        ausgabe = ausgabe_fuer(sys.stdin.read(), dict(os.environ))
    except Exception:
        ausgabe = None
    if ausgabe:
        sys.stdout.write(ausgabe)
    sys.exit(0)
