#!/usr/bin/env python3
"""Worktree je Agent (docs/AGENTS-PLAN.md, Abschnitt 8 Punkt 9; docs/AGENTS-TRAEGER.md, "Worktree je Agent").

der Nutzer, 16.09.2026: "Agents sollen in den jeweiligen Projektordner schreiben, wie die Worker dann auch nicht
nach main sondern in eigene." Hat die Welt ein git-Projekt (``<projekt>/.git`` ist ein echter Ordner), legt der
Traeger vor dem ersten Zug eines Agenten einen Worktree auf dem Zweig ``agent/<id>`` an, abgezweigt vom
Hauptzweig (``main``, sonst ``master``). Er liegt im privaten Arbeitsordner des Agenten,
``<agentenbereich>/<id>/work/<id>``: ausserhalb des nur lesbar eingebundenen Projekts, kurz (die Sockets
liegen ohnehin im Zugordner) und innerhalb des Schreibpfads, den die Profil-Sperre als ``WB_AGENT_WORKTREE``
kennt. Ein vorhandener Worktree wird wiederverwendet; der Agent behaelt seinen Zweig.

Im Zug liegt ``<projekt>/.git`` als tmpfs, in das der Launcher nur die Teile einbindet, die ein Commit,
Rebase oder Merge im eigenen Worktree braucht (auf peer am 16.09.2026 mit git 2.55 in bwrap gemessen):
beschreibbar ``objects`` (darin ``pack`` und ``info`` nur lesbar), ``refs/heads/agent``,
``logs/refs/heads/agent`` und der eigene Verwaltungsordner ``worktrees/<name>``; nur lesbar ``config``,
``HEAD``, ``packed-refs``, ``shallow``, ``info``, ``modules``, ``refs``, ``logs`` und ``worktrees``. Das tmpfs
ist noetig, weil git beim Loeschen eines Refs (``CHERRY_PICK_HEAD``, ``AUTO_MERGE``) ``.git/packed-refs.lock``
anlegt; ohne schreibbaren ``.git``-Ordner blieb ein Rebase mit ``CHERRY_PICK_HEAD`` haengen. Was ein Zug dort
neu anlegt, sieht der Mensch nie.

Der Traeger fuehrt git nur mit ``-C <projekt>`` aus, nie im Worktree: der Worktree und sein Verwaltungsordner
sind fuer den Agenten beschreibbar, und git liest dort Dateien, die Programme starten koennten. Einzige Ausnahme
ist die Pruefung auf ungesicherte Aenderungen beim Aufraeumen, nach Pruefung der Verwaltungsdateien und mit
abgeschalteten Hooks, fsmonitor und Submodulen.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import agents_data as ad  # noqa: E402

ZWEIG_PRAEFIX = "agent/"
HAUPTZWEIGE = ("main", "master")
# Nur lesbar aus dem Projekt-Repo; fehlende Eintraege entfallen.
GIT_LESEN = ("config", "HEAD", "packed-refs", "shallow", "info", "modules", "refs", "logs", "worktrees")
OBJEKTE_LESEN = ("objects/pack", "objects/info")
# Git-Einstellungen des Zuges, ueber GIT_CONFIG_COUNT (Vorrang vor der Projektkonfiguration): keine Hooks
# (ein Hookpfad im Projekt laege im beschreibbaren Worktree), kein fsmonitor, kein Editor ohne Terminal, keine
# Hintergrundpflege, keine Signatur ohne Schluessel.
GIT_EINSTELLUNGEN = (("core.hooksPath", "/dev/null"), ("core.fsmonitor", "false"), ("core.editor", "false"),
                     ("sequence.editor", "false"), ("gc.auto", "0"), ("maintenance.auto", "false"),
                     ("commit.gpgSign", "false"))
_GIT_FRIST_S = 60
_KLEIN = 4096


class WorktreeFehler(ad.AgentsError):
    """Worktree nicht anlegbar oder nicht vertrauenswuerdig."""


def zweig(agent_id: str) -> str:
    return ZWEIG_PRAEFIX + ad.valid_id(agent_id, "Agentenkennung")


def git_ordner(projekt: Optional[Path]) -> Optional[Path]:
    """``<projekt>/.git``, wenn das Projekt ein eigenes Repo mit echtem Ordner ist, sonst None."""
    if projekt is None or not Path(projekt).is_dir():
        return None
    gitdir = Path(projekt).resolve(strict=True) / ".git"
    if gitdir.parent in (Path("/"), Path.home().resolve()) or gitdir.is_symlink() or not gitdir.is_dir():
        return None
    return gitdir


def _umgebung() -> dict[str, str]:
    # Keine GIT_*-Variablen des Aufrufers: sie koennten Repo, Arbeitsbaum oder Konfiguration umlenken.
    return {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}


def _git(projekt: Path, *args: str, pruefen: bool = True) -> subprocess.CompletedProcess:
    befehl = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", str(projekt), *args]
    try:
        result = subprocess.run(befehl, capture_output=True, text=True, timeout=_GIT_FRIST_S, env=_umgebung())
    except (OSError, subprocess.SubprocessError) as exc:
        raise WorktreeFehler("git %s: %s" % (args[0], exc)) from exc
    if pruefen and result.returncode != 0:
        raise WorktreeFehler("git %s: %s" % (" ".join(args[:2]), (result.stderr or result.stdout).strip()[:300]))
    return result


def _ref_da(projekt: Path, ref: str) -> bool:
    return _git(projekt, "rev-parse", "--verify", "--quiet", ref + "^{commit}", pruefen=False).returncode == 0


def hauptzweig(projekt: Path) -> Optional[str]:
    return next((name for name in HAUPTZWEIGE if _ref_da(projekt, "refs/heads/" + name)), None)


def _klein_lesen(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise WorktreeFehler("%s fehlt oder ist keine Datei" % path)
    with path.open("rb") as handle:
        return handle.read(_KLEIN).decode("utf-8", "replace").strip()


def verwaltung(gitdir: Path, pfad: Path) -> Path:
    """Verwaltungsordner ``<gitdir>/worktrees/<name>`` eines Worktrees, nach Pruefung beider Richtungen.

    Der Worktree ist fuer den Agenten beschreibbar; geglaubt wird nur, was unter ``worktrees/`` des
    Projekt-Repos liegt und dorthin zurueckzeigt."""
    if pfad.is_symlink() or not pfad.is_dir():
        raise WorktreeFehler("%s ist kein Ordner" % pfad)
    inhalt = _klein_lesen(pfad / ".git")
    if not inhalt.startswith("gitdir: "):
        raise WorktreeFehler("%s/.git nennt keinen Verwaltungsordner" % pfad)
    admin = Path(inhalt[len("gitdir: "):])
    if not admin.is_absolute() or admin.parent != gitdir / "worktrees" or admin.is_symlink() or not admin.is_dir() \
            or os.path.realpath(admin) != str(admin):
        raise WorktreeFehler("%s/.git zeigt nicht in %s/worktrees" % (pfad, gitdir))
    if os.path.realpath(_klein_lesen(admin / "gitdir")) != os.path.realpath(pfad / ".git"):
        raise WorktreeFehler("%s gehoert zu einem anderen Worktree" % admin)
    if _klein_lesen(admin / "commondir") != "../..":
        raise WorktreeFehler("%s/commondir zeigt nicht auf das Projekt-Repo" % admin)
    return admin


def _worktrees(projekt: Path) -> list[dict[str, Any]]:
    eintraege: list[dict[str, Any]] = []
    for zeile in _git(projekt, "worktree", "list", "--porcelain").stdout.splitlines():
        if zeile.startswith("worktree "):
            eintraege.append({"pfad": zeile[len("worktree "):]})
        elif eintraege and zeile.startswith("branch "):
            eintraege[-1]["zweig"] = zeile[len("branch "):]
        elif eintraege and zeile.split(" ", 1)[0] in {"prunable", "locked", "detached"}:
            eintraege[-1][zeile.split(" ", 1)[0]] = True
    return eintraege


@dataclass(frozen=True)
class Arbeitsbaum:
    projekt: Path
    gitdir: Path
    pfad: Path
    zweig: str
    admin: Path
    basis: Optional[str]
    neu: bool

    def einbindung(self) -> dict[str, Any]:
        """Einbindung fuer den Launcher (``agents_linux.LinuxLauncher``, ``git_einbindung``)."""
        lesen = [self.gitdir / name for name in GIT_LESEN + OBJEKTE_LESEN if (self.gitdir / name).exists()]
        schreiben = [self.gitdir / "objects", self.admin, self.gitdir / "refs" / "heads" / "agent",
                     self.gitdir / "logs" / "refs" / "heads" / "agent"]
        return {"gitdir": str(self.gitdir), "lesen": [str(p) for p in lesen], "schreiben": [str(p) for p in schreiben]}

    def git_umgebung(self, agent_id: str) -> dict[str, str]:
        """Umgebung fuer Bash im Zug (Einstellungsdatei ``env``): Git-Einstellungen und Identitaet.

        Die Identitaet ist die des Projekts (Hausregel: Commits mit der Identitaet des Menschen); fehlt sie,
        steht die Agentenkennung da. Welcher Agent committet hat, zeigt der Zweig."""
        name = _git(self.projekt, "config", "--get", "user.name", pruefen=False).stdout.strip() or agent_id
        email = _git(self.projekt, "config", "--get", "user.email", pruefen=False).stdout.strip() \
            or "%s@agents.werkbank.invalid" % agent_id
        paare = GIT_EINSTELLUNGEN + (("user.name", name), ("user.email", email))
        env = {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_COUNT": str(len(paare))}
        for index, (key, value) in enumerate(paare):
            env["GIT_CONFIG_KEY_%d" % index] = key
            env["GIT_CONFIG_VALUE_%d" % index] = value
        return env


def bereitstellen(projekt: Optional[Path], arbeitsordner: Path, agent_id: str) -> Optional[Arbeitsbaum]:
    """Worktree des Agenten anlegen oder wiederverwenden; None ohne git-Projekt."""
    gitdir = git_ordner(projekt)
    if gitdir is None:
        return None
    projekt = gitdir.parent
    name = zweig(agent_id)
    pfad = Path(arbeitsordner).resolve(strict=True) / agent_id
    basis, neu = hauptzweig(projekt), False
    if not os.path.lexists(pfad):
        if basis is None:
            raise WorktreeFehler("Projekt hat weder main noch master")
        eintraege = _worktrees(projekt)
        belegt = [e for e in eintraege if e.get("zweig") == "refs/heads/" + name
                  and os.path.realpath(e["pfad"]) != str(pfad)]
        if belegt:
            raise WorktreeFehler("Zweig %s ist schon in %s ausgecheckt" % (name, belegt[0]["pfad"]))
        # Ein geloeschter Arbeitsordner hinterlaesst einen verwaisten Eintrag genau fuer diesen Pfad; nur dann -f.
        erzwingen = ["-f"] if any(os.path.realpath(e["pfad"]) == str(pfad) and e.get("prunable")
                                  for e in eintraege) else []
        if _ref_da(projekt, "refs/heads/" + name):
            _git(projekt, "worktree", "add", *erzwingen, str(pfad), name)
        else:
            _git(projekt, "worktree", "add", *erzwingen, "-b", name, str(pfad), basis)
        neu = True
    admin = verwaltung(gitdir, pfad)
    for teil in (("refs", "heads", "agent"), ("logs", "refs", "heads", "agent")):
        ordner = gitdir.joinpath(*teil)
        ordner.mkdir(parents=True, exist_ok=True)
        if ordner.is_symlink() or os.path.realpath(ordner) != str(ordner):
            raise WorktreeFehler("%s ist kein echter Ordner" % ordner)
    return Arbeitsbaum(projekt, gitdir, pfad, name, admin, basis, neu)


# Aufraeumen ------------------------------------------------------------------------
def _aufgeloest(root: Path, agent_id: str) -> bool:
    try:
        return ad.read_agent(root, agent_id).get("state") == "archiviert"
    except ad.AgentsError:
        return not (root / "agents" / agent_id).exists()


def _ungesichert(gitdir: Path, pfad: Path) -> Optional[str]:
    """Kurzbeschreibung ungesicherter Aenderungen im Worktree, None wenn sauber."""
    admin = verwaltung(gitdir, pfad)
    if _git(gitdir.parent, "config", "--bool", "extensions.worktreeConfig", pruefen=False).stdout.strip() == "true":
        raise WorktreeFehler("extensions.worktreeConfig ist an; der Status des Worktrees wird nicht gelesen")
    result = _git(gitdir.parent, "-c", "core.untrackedCache=false", "--git-dir", str(admin),
                  "--work-tree", str(pfad), "status", "--porcelain", "--ignore-submodules=all", "--no-renames")
    zeilen = [z for z in result.stdout.splitlines() if z.strip()]
    return None if not zeilen else "%d ungesicherte Aenderungen" % len(zeilen)


def aufraeumen(root: Path, agent_id: Optional[str] = None) -> dict[str, Any]:
    """Entfernt Worktree und Zweig aufgeloester Agenten, deren Zweig im Hauptzweig enthalten ist.

    Alles andere bleibt mit Hinweis. Geloescht wird nie automatisch, nur auf diesen Aufruf."""
    root = ad.world_path(str(root))
    ad.read_world(root)
    import agents_skills as ask  # noqa: PLC0415 - nur hier gebraucht
    projekt = ask.world_project(root)
    gitdir = git_ordner(projekt)
    if gitdir is None:
        return {"projekt": str(projekt) if projekt else None, "entfernt": [], "bleibt": [],
                "hinweis": "Die Welt hat kein git-Projekt; es gibt keine Agenten-Worktrees."}
    projekt = gitdir.parent
    basis = hauptzweig(projekt)
    zweige = _git(projekt, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/agent/").stdout
    stand = {z.split()[0][len("refs/heads/agent/"):]: z.split()[1] for z in zweige.splitlines() if z.strip()}
    baeume = {e["zweig"][len("refs/heads/agent/"):]: e for e in _worktrees(projekt)
              if str(e.get("zweig", "")).startswith("refs/heads/agent/")}
    kandidaten = sorted(set(stand) | set(baeume))
    if agent_id is not None:
        ad.valid_id(agent_id, "Agentenkennung")
        kandidaten = [agent_id] if agent_id in kandidaten else []
    entfernt, bleibt = [], []
    for kennung in kandidaten:
        eintrag = baeume.get(kennung)
        info = {"agent": kennung, "zweig": ZWEIG_PRAEFIX + kennung, "worktree": eintrag["pfad"] if eintrag else None}
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", kennung):
            bleibt.append(dict(info, grund="Zweigname ist keine Agentenkennung"))
            continue
        if not _aufgeloest(root, kennung):
            bleibt.append(dict(info, grund="Agent ist nicht aufgeloest"))
            continue
        if basis is None:
            bleibt.append(dict(info, grund="Projekt hat weder main noch master"))
            continue
        sha = stand.get(kennung)
        if sha and _git(projekt, "merge-base", "--is-ancestor", sha, "refs/heads/" + basis,
                        pruefen=False).returncode != 0:
            bleibt.append(dict(info, grund="Zweig ist nicht in %s gemergt" % basis))
            continue
        if eintrag is not None and eintrag.get("locked"):
            bleibt.append(dict(info, grund="Worktree ist gesperrt (git worktree lock)"))
            continue
        if eintrag is not None and not eintrag.get("prunable"):
            try:
                offen = _ungesichert(gitdir, Path(eintrag["pfad"]))
            except WorktreeFehler as exc:
                bleibt.append(dict(info, grund=str(exc)))
                continue
            if offen:
                bleibt.append(dict(info, grund=offen))
                continue
        if eintrag is not None and eintrag.get("prunable"):
            _git(projekt, "worktree", "prune")
        elif eintrag is not None:
            # Eigene Pruefung oben; --force ueberspringt nur gits zweiten Status, der in Submodule hineingeht.
            _git(projekt, "worktree", "remove", "--force", eintrag["pfad"])
        if sha:
            _git(projekt, "update-ref", "-d", "refs/heads/agent/" + kennung, sha)
        entfernt.append(info)
    if agent_id is not None and not kandidaten:
        bleibt.append({"agent": agent_id, "zweig": ZWEIG_PRAEFIX + agent_id, "worktree": None,
                       "grund": "kein Zweig und kein Worktree"})
    return {"projekt": str(projekt), "hauptzweig": basis, "entfernt": entfernt, "bleibt": bleibt}


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="wb-welt worktree-aufraeumen",
                                     description="Worktrees und Zweige aufgeloester Agenten entfernen, "
                                                 "wenn ihr Zweig im Hauptzweig enthalten ist")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("aufraeumen")
    p.add_argument("welt")
    p.add_argument("agent", nargs="?")
    p.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    import agents_fernweg as af  # noqa: PLC0415
    fern = af.FERN.fullmatch(args.welt)
    if fern is not None:
        shell_dir = os.environ.get("WB_AGENTS_FERN_SHELL") or af.LAUFZEIT
        remote = ["%s/wb-welt" % shell_dir.rstrip("/"), "worktree-aufraeumen", fern.group("pfad")] + (
            [args.agent] if args.agent else []) + (["--json"] if args.json else [])
        ssh = os.environ.get("WB_FERN_SSH") or "ssh"
        return subprocess.run([ssh, "-oBatchMode=yes", "-oConnectTimeout=8", fern.group("host"),
                               shlex.join(remote)]).returncode
    try:
        data = aufraeumen(Path(args.welt), args.agent)
    except (ad.AgentsError, OSError) as exc:
        print("wb-welt: FEHLER - %s" % exc, file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0
    if data.get("hinweis"):
        print(data["hinweis"])
    for item in data["entfernt"]:
        print("entfernt: %s (%s)" % (item["zweig"], item["worktree"] or "ohne Worktree"))
    for item in data["bleibt"]:
        print("bleibt:   %s (%s): %s" % (item["zweig"], item["worktree"] or "ohne Worktree", item["grund"]))
    if not data["entfernt"] and not data["bleibt"] and not data.get("hinweis"):
        print("Keine Agenten-Worktrees oder -Zweige.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
