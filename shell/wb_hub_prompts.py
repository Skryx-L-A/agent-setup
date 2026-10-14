"""wb_hub_prompts -- Spur H5: Werkbank-Prompts als MCP-Prompts, Skills als lesende MCP-Ressourcen.

Entwurf: ~/AI/_recherche/werkzeug-hub-entwurf-2026-10-13.md (Abschnitt 3, Zeile H5). Aufruf nur aus
wb_hub_kern.Hub.bearbeiten; die Weiche dort ist die einzige Verbindung.

PROMPTS: Quelle `prompts` in werkzeuge.default.json, je Eintrag {"datei": "<md>", "harnesses": ...}.
Die Datei ist Markdown mit Frontmatter (`description`, `argument-hint`); der Rumpf ist der Prompttext,
`$ARGUMENTS` wird durch das eine Argument `argumente` ersetzt. Name im Hub: `wb-<schluessel>`.
Sichtbarkeit wie bei Werkzeugen ueber `?harness=` und das Feld `harnesses`.

SKILLS: `~/.claude/skills/<name>/SKILL.md` (Test: WB_HUB_SKILLS), nur lesen. Ressource
`wb-hub://skills/<name>`. Der Name ist auf [A-Za-z0-9_-]+ begrenzt, und der reale Pfad (realpath)
muss unter dem Skill-Ordner liegen; Links nach aussen werden abgelehnt.
"""
import os
import re

import werkzeuge_kern

PROMPT_SCHLUESSEL = re.compile(r"^[a-z0-9][a-z0-9-]{0,60}$")
SKILL_NAME = re.compile(r"^[A-Za-z0-9_-]+$")
PROMPT_PRAEFIX = "wb-"
SKILL_URI_PRAEFIX = "wb-hub://skills/"
ARGUMENT = "argumente"
PROMPT_METHODEN = ("prompts/list", "prompts/get", "resources/list", "resources/read")


class PromptFehler(Exception):
    """Fehler mit JSON-RPC-Code, vom Hub als error-Antwort ausgegeben."""

    def __init__(self, code, text):
        super().__init__(text)
        self.code = code
        self.text = text


def _frontmatter(text):
    """-> (Felder, Rumpf). Nur einfache `schluessel: wert`-Zeilen zwischen zwei `---`-Zeilen."""
    if not text.startswith("---\n"):
        return {}, text
    ende = text.find("\n---", 4)
    if ende < 0:
        return {}, text
    felder = {}
    for zeile in text[4:ende].splitlines():
        k, sep, v = zeile.partition(":")
        if sep and re.match(r"^[A-Za-z_-]+$", k.strip()):
            felder[k.strip()] = v.strip().strip("\"'")
    rumpf = text[ende + len("\n---"):]
    if rumpf.startswith("\n"):
        rumpf = rumpf[1:]
    return felder, rumpf


def _lesen(pfad):
    """-> Text oder None, wenn die Datei fehlt oder nicht lesbar ist."""
    try:
        with open(pfad, encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def _prompts(q, reg, harness):
    """-> {hub-name: Eintrag} der Prompts, die dieser Harness sieht (harness None = alle)."""
    aus = {}
    for schluessel, e in sorted((q.get("prompts") or {}).items()):
        if not PROMPT_SCHLUESSEL.match(schluessel) or not isinstance(e, dict):
            continue
        if harness is not None and harness not in werkzeuge_kern.harnesses_aufloesen(
                e.get("harnesses", "alle-mit-prompts"), "prompts", reg):
            continue
        aus[PROMPT_PRAEFIX + schluessel] = e
    return aus


def prompts_liste(q, reg, harness):
    aus = []
    for name, e in _prompts(q, reg, harness).items():
        text = _lesen(werkzeuge_kern.pfad_aufloesen(e.get("datei", "")))
        if text is None:
            continue        # fehlende Datei fehlt in der Liste, der Hub bleibt lauffaehig
        felder, _ = _frontmatter(text)
        eintrag = {"name": name, "description": felder.get("description", "")}
        if felder.get("argument-hint"):
            eintrag["arguments"] = [{"name": ARGUMENT, "description": felder["argument-hint"],
                                     "required": False}]
        aus.append(eintrag)
    return {"prompts": aus}


def prompt_holen(q, reg, harness, params):
    name = params.get("name") if isinstance(params, dict) else None
    e = _prompts(q, reg, harness).get(name) if isinstance(name, str) else None
    if e is None:
        raise PromptFehler(-32602, "unbekannter Prompt")
    text = _lesen(werkzeuge_kern.pfad_aufloesen(e.get("datei", "")))
    if text is None:
        raise PromptFehler(-32603, "Prompt-Datei nicht lesbar")
    args = params.get("arguments") or {}
    if not isinstance(args, dict):
        raise PromptFehler(-32602, "arguments: Objekt erwartet")
    wert = args.get(ARGUMENT, "")
    if not isinstance(wert, str):
        raise PromptFehler(-32602, "argumente: Text erwartet")
    felder, rumpf = _frontmatter(text)
    return {"description": felder.get("description", ""),
            "messages": [{"role": "user",
                          "content": {"type": "text", "text": rumpf.replace("$ARGUMENTS", wert)}}]}


# ---------------------------------------------------------------- Skills (nur lesen)

def skills_ordner():
    return os.environ.get("WB_HUB_SKILLS") or os.path.join(werkzeuge_kern.home(), ".claude", "skills")


def _skill_datei(name):
    """-> realer Pfad der SKILL.md oder None. Name [A-Za-z0-9_-]+, Ergebnis muss unter dem Ordner liegen."""
    if not isinstance(name, str) or not SKILL_NAME.match(name):
        return None
    wurzel = os.path.realpath(skills_ordner())
    pfad = os.path.realpath(os.path.join(wurzel, name, "SKILL.md"))
    if not pfad.startswith(wurzel + os.sep) or not os.path.isfile(pfad):
        return None
    return pfad


def ressourcen_liste():
    wurzel = skills_ordner()
    aus = []
    try:
        namen = sorted(os.listdir(wurzel))
    except OSError:
        namen = []
    for name in namen:
        pfad = _skill_datei(name)
        if pfad is None:
            continue
        text = _lesen(pfad) or ""
        felder, _ = _frontmatter(text)
        aus.append({"uri": SKILL_URI_PRAEFIX + name, "name": name,
                    "description": felder.get("description", ""), "mimeType": "text/markdown"})
    return {"resources": aus}


def ressource_lesen(params):
    uri = params.get("uri") if isinstance(params, dict) else None
    if not isinstance(uri, str) or not uri.startswith(SKILL_URI_PRAEFIX):
        raise PromptFehler(-32602, "unbekannte Ressource")
    pfad = _skill_datei(uri[len(SKILL_URI_PRAEFIX):])
    if pfad is None:
        raise PromptFehler(-32602, "unbekannte Ressource")
    text = _lesen(pfad)
    if text is None:
        raise PromptFehler(-32603, "Ressource nicht lesbar")
    return {"contents": [{"uri": uri, "mimeType": "text/markdown", "text": text}]}


# ---------------------------------------------------------------- Weiche

def bearbeiten(methode, params, q, reg, harness):
    """-> Ergebnisobjekt; wirft PromptFehler."""
    if methode == "prompts/list":
        return prompts_liste(q, reg, harness)
    if methode == "prompts/get":
        return prompt_holen(q, reg, harness, params)
    if methode == "resources/list":
        return ressourcen_liste()
    if methode == "resources/read":
        return ressource_lesen(params)
    raise PromptFehler(-32601, "Methode nicht unterstuetzt")
