"""Die zwei Eingrenzungen des Recall-Hooks: Projektzweig und Eigenaussage.

Eigene Datei, weil beides reine Funktionen ueber (rel, text, prompt) sind und
sich damit ohne Vault, ohne Modell und ohne Hook testen laesst. `auto-recall-format.py`
ruft sie auf, mehr passiert dort nicht.

Warum es sie gibt: der Hook feuert bei JEDEM Prompt und uebergab an `brain search`
bis zum 10.08.2026 nur den Prompt - kein Arbeitsverzeichnis, kein Projekt. Gemessen
am 29.07.2026 ueber die 37 Eval-Fragen lag seine Praezision bei 36,2 Prozent (Schwelle
0.35), zwei von drei eingespielten Notizen waren also unpassend. Belegte Faelle: im
Spieleprojekt `~/AI/poe2-gptk` kamen Notizen zu feingeister und higgsfield, und eine
Themenseite, deren Stand-Abschnitt woertlich sagt, es liege noch keine belastbare
Zusammenfassung vor, stand mit 0,41 ueber der Schwelle.

An der Schwelle wird nicht gedreht. Beide Filter arbeiten davor.
"""
from __future__ import annotations

import re
from pathlib import Path

# --- Projektzweig ---------------------------------------------------------

PROJECT_PREFIX = "20-projects/"

# Verzeichnisse, deren Name den Zweig nicht erraten laesst. Alles andere wird
# ueber Normalisierung und Praefix getroffen (claude-setup-share -> claude-setup,
# a project-wt -> a project, Feingeister_Schul-KI-System -> feingeister).
DIR_ALIASES = {
    "praktikumnebenstudium": "praktikumssuche",
    "minecraft": "lumenpt",
    "shader": "lumenpt",
    "knowledge": "brain3",
}


def _normalize(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def known_branches(vault: Path) -> set[str]:
    try:
        return {p.name for p in (vault / "20-projects").iterdir() if p.is_dir()}
    except OSError:
        return set()


def _repo_root(start: Path) -> Path | None:
    """Wurzel des Repos, in dem `start` liegt - ohne git aufzurufen.

    Ein Arbeitsbaum (`git worktree`) traegt statt eines Verzeichnisses eine Datei
    `.git` mit der Zeile `gitdir: <hauptrepo>/.git/worktrees/<name>`. Ohne diesen
    Zweig hiesse das Projekt eines Workers so wie seine Aufgabe und nie so wie
    sein Repo.
    """
    for d in [start, *start.parents]:
        marker = d / ".git"
        if marker.is_dir():
            return d
        if marker.is_file():
            try:
                line = marker.read_text(encoding="utf-8", errors="replace").strip()
            except OSError:
                return d
            if line.startswith("gitdir:"):
                gitdir = line.split(":", 1)[1].strip()
                head = gitdir.split("/.git/worktrees/", 1)[0]
                if head and head != gitdir:
                    return Path(head)
            return d
    return None


def detect_project(cwd: str, vault: Path, home: Path | None = None) -> tuple[str | None, bool]:
    """(Zweig, laeuft-in-einem-Projekt) fuer ein Arbeitsverzeichnis.

    Zweig ist der Ordnername unter `20-projects/`, wenn er sich zuordnen laesst.
    Das zweite Feld sagt, ob die Sitzung ueberhaupt erkennbar in einem Projekt
    laeuft - ein Repo oder ein Ordner unter `~/AI`. Genau dieser Fall ist der
    poe2-Vorfall: ein Projekt ohne eigenen Zweig, in dem JEDE projektgebundene
    Notiz fremd ist.
    """
    if not cwd:
        return None, False
    home = home or Path.home()
    try:
        path = Path(cwd).resolve()
    except OSError:
        return None, False

    branches = known_branches(vault)
    by_norm = {_normalize(b): b for b in branches}

    candidates: list[str] = []
    for d in [path, *path.parents]:
        if d == home or d == d.parent:
            break
        candidates.append(d.name)
    root = _repo_root(path)
    if root is not None:
        candidates.append(root.name)

    for raw in candidates:
        norm = _normalize(raw)
        if norm in by_norm:
            return by_norm[norm], True
        alias = DIR_ALIASES.get(norm)
        if alias in branches:
            return alias, True
        for bnorm, branch in by_norm.items():
            if len(bnorm) >= 4 and (norm.startswith(bnorm) or bnorm.startswith(norm)):
                return branch, True

    in_project = root is not None or (home / "AI") in path.parents
    return None, in_project


def foreign_project(rel: str, project: str | None, in_project: bool) -> bool:
    """Gehoert der Treffer zu einem ANDEREN Projekt als die Sitzung?

    Nur `20-projects/<x>/` zaehlt als projektgebunden. Alles unter `10-global/`,
    `30-topics/`, `40-people/` und der Wurzel bleibt unangetastet - eine
    projektuebergreifende Notiz soll weiter durchkommen, sie soll nur nicht
    allein deshalb gewinnen, weil sie zufaellig Woerter teilt.
    """
    if not in_project:
        return False
    if not rel.startswith(PROJECT_PREFIX):
        return False
    if project is None:
        return True
    return not rel.startswith(f"{PROJECT_PREFIX}{project}/")


# --- Eigenaussage ---------------------------------------------------------

_FRONTMATTER_RE = re.compile(r"\A---\n.*?\n---\n", re.S)
_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
_WIKILINK_RE = re.compile(r"\[\[[^\]]*\]\]")
_MDLINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_LISTMARK_RE = re.compile(r"^[-*+]\s*|^\d+\.\s*")

# Zeilen, die eine erzeugte Seite ueber sich selbst schreibt. Sie sind Text,
# aber keine Aussage ueber die Welt.
_BOILERPLATE = (
    "noch keine belastbare zusammenfassung",
    "siehe quellnotizen",
    "automatisch aus",
    "kuratierter einstieg",
    "map of content",
    "stub-notes der",
    "keine quellen",
    "keine notizen",
    "themenseite zu",
)

STOPWORDS = {
    "eine", "einer", "eines", "einem", "einen", "oder", "und", "der", "die",
    "das", "den", "dem", "des", "was", "wie", "wer", "wo", "ist", "sind",
    "fuer", "für", "mit", "von", "vom", "beim", "bei", "auf", "aus", "nach",
    "noch", "auch", "nicht", "mach", "mir", "mal", "dann", "kannst", "moc",
    "status", "the", "and", "for", "with",
}


def own_prose(text: str) -> str:
    """Was von einer Notiz uebrig bleibt, wenn man abzieht, was keine eigene
    Aussage ist: Frontmatter, Marker, Ueberschriften, Tabellen, Codebloecke,
    Verweise und die Selbstbeschreibung erzeugter Seiten. Was dann noch dasteht,
    hat jemand ueber die Sache geschrieben."""
    body = _COMMENT_RE.sub("", _FRONTMATTER_RE.sub("", text))
    kept: list[str] = []
    in_code = False
    for line in body.splitlines():
        s = line.strip()
        if s.startswith("```"):
            in_code = not in_code
            continue
        if in_code or not s or s.startswith("#") or s.startswith("|") or s.startswith(">"):
            continue
        s = _LISTMARK_RE.sub("", s)
        s = _WIKILINK_RE.sub("", s)
        s = _MDLINK_RE.sub(r"\1", s)
        s = s.strip(" -:*_.()")
        if len(s) < 25:
            continue
        if any(b in s.lower() for b in _BOILERPLATE):
            continue
        kept.append(s)
    return " ".join(kept)


def title_matches_prompt(title: str, prompt: str) -> bool:
    """Fragt der Prompt die Seite beim Namen? Dann ist auch eine reine Linkliste
    die richtige Antwort - genau dafuer sind die Hubs da. Ohne diese Ausnahme
    verlieren navigatorische Fragen ihren Treffer."""
    if not title or not prompt:
        return False
    words = {w for w in re.findall(r"[\wäöüß]+", title.lower())
             if len(w) >= 4 and w not in STOPWORDS}
    if not words:
        return False
    ptokens = set(re.findall(r"[\wäöüß]+", prompt.lower()))
    return bool(words & ptokens)


def is_contentless(text: str, title: str, prompt: str, prose_min: int) -> bool:
    """Traegt die Seite keine eigene Aussage? Am Text entschieden, nicht am
    Dateinamen: eine `MOC.md` mit echten Saetzen bleibt, eine Notiz ohne
    Ueberschrift, die nur Verweise auflistet, faellt."""
    if title_matches_prompt(title, prompt):
        return False
    return len(own_prose(text)) < prose_min
