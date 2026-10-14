"""`brain server status|waehlen`: Client-Fallback zwischen peer und dem my-server-Standby (F6).

Jeder Server meldet unter `/health` `rolle`, `epoch` und ob Forgejo erreichbar ist
(braindienst/rolle.py). Nutzbar ist ein Server, der antwortet, `rolle=primaer` meldet und
Forgejo erreicht. Regel (dieselbe wie in der App, web/src/server-wahl.ts):

- Der Server, auf den Git gerade zeigt, bleibt, solange er nutzbar ist (kein Hin und Her).
- Sonst der nutzbare Server mit der hoechsten Epoche; bei Gleichstand der fruehere Listeneintrag.
- Ist keiner nutzbar, bleibt alles, wie es ist.

Umgeschaltet wird nur Git, und nur repo-lokal (`git config --local`) im Vault und in jedem
Space-Repo aus `.brain/spaces.lock`: `url.<standby-basis>.insteadOf <peer-basis>` fuer SSH und
HTTPS. Die Remote-URLs selbst bleiben. Zurueck auf den ersten Listeneintrag (peer) heisst: die
eigenen insteadOf-Eintraege wieder entfernen.

Serverliste: `_meta/tools/braincli/server.json` im Vault (Vorgabe unten, falls die Datei fehlt).
Pruefergebnisse liegen mit Zeitstempel in `_meta/tools/state/server-wahl.json` (gitignoriert);
juenger als 10 min werden sie wiederverwendet, damit wiederholte Aufrufe nichts kosten.
"""
from __future__ import annotations

import datetime as dt
import json
import re
import ssl
import subprocess
import threading
import time
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path

from gardener import spaces as spaces_mod

PRUEF_ZEITLIMIT_S = 2.0
CACHE_S = 600.0
KONFIG_REL = Path("_meta/tools/braincli/server.json")
STATE_REL = Path("_meta/tools/state/server-wahl.json")

# Vorgabe, falls server.json fehlt. Git-SSH-Nutzer auf dem Standby: Forgejos eingebauter
# SSH-Server nimmt nur BUILTIN_SSH_SERVER_USER an, Vorgabe = RUN_USER; brain-failover
# (ini_umschreiben) setzt RUN_USER=brain-standby.
VORGABE = [
    {"name": "peer", "dienst": "https://peer.tailnet.example.ts.net:8443",
     "git": ["ssh://forgejo@peer.tailnet.example.ts.net:2223/", "https://peer.tailnet.example.ts.net/"]},
    {"name": "my-server", "dienst": "https://lan-dns.tailnet.example.ts.net:8443",
     "git": ["ssh://brain-standby@lan-dns.tailnet.example.ts.net:2240/", "https://lan-dns.tailnet.example.ts.net/"]},
]


@dataclass
class Server:
    name: str
    dienst: str
    git: list[str]  # Git-Basis-URLs, gleiche Reihenfolge in allen Eintraegen (SSH, HTTPS)


@dataclass
class Pruefung:
    name: str
    erreichbar: bool = False
    rolle: str = "unbekannt"
    epoch: int = 0
    forgejo: bool = False
    fehler: str = ""
    kalt: bool = False  # Nicht-Heim-Server lehnt die Verbindung ab: erwarteter Normalzustand

    @property
    def nutzbar(self) -> bool:
        return self.erreichbar and self.rolle == "primaer" and self.forgejo


def konfig_laden(vault: Path) -> list[Server]:
    roh = VORGABE
    pfad = Path(vault) / KONFIG_REL
    try:
        daten = json.loads(pfad.read_text(encoding="utf-8"))
        if isinstance(daten, dict) and isinstance(daten.get("server"), list) and daten["server"]:
            roh = daten["server"]
    except (OSError, ValueError):
        pass
    out = [Server(name=str(e["name"]), dienst=str(e["dienst"]).rstrip("/"),
                  git=[str(g) for g in e.get("git", [])]) for e in roh]
    laengen = {len(s.git) for s in out}
    if len(laengen) != 1:
        raise ValueError(f"{KONFIG_REL}: jeder Eintrag braucht gleich viele git-Basen")
    return out


# --------------------------------------------------------------------------- Pruefen

def _health(url: str, zeitlimit: float) -> dict:
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url.rstrip("/") + "/health", headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=zeitlimit, context=ctx) as r:  # noqa: S310 (feste Liste)
        return json.loads(r.read(1_000_000).decode("utf-8"))


def _auswerten(name: str, h: dict) -> Pruefung:
    rolle = h.get("rolle") if h.get("rolle") in ("primaer", "sekundaer", "unbekannt") else "unbekannt"
    epoch = h.get("epoch") if isinstance(h.get("epoch"), int) and not isinstance(h.get("epoch"), bool) else 0
    forgejo = h.get("forgejo_erreichbar")
    if not isinstance(forgejo, bool):
        forgejo = bool((h.get("forgejo") or {}).get("erreichbar"))
    return Pruefung(name=name, erreichbar=True, rolle=rolle, epoch=max(epoch, 0), forgejo=forgejo)


def _abgelehnt(e: BaseException) -> bool:
    """Verbindung aktiv verweigert (ECONNREFUSED), nicht Zeitlimit oder Namensfehler."""
    grund = getattr(e, "reason", e)
    return isinstance(grund, ConnectionRefusedError)


def pruefen(server: list[Server], zeitlimit: float = PRUEF_ZEITLIMIT_S) -> list[Pruefung]:
    """Alle Eintraege parallel; jede Pruefung hoechstens `zeitlimit` Sekunden, auch wenn
    schon die Namensaufloesung haengt (Daemon-Threads, die wir nach Ablauf zuruecklassen)."""
    ergebnis: dict[str, Pruefung] = {}

    def eins(s: Server) -> None:
        try:
            ergebnis[s.name] = _auswerten(s.name, _health(s.dienst, zeitlimit))
        except Exception as e:  # jede Stoerung heisst: nicht erreichbar
            if s is not server[0] and _abgelehnt(e):
                # Der Standby laeuft im Normalbetrieb nicht (braindienst/README.md): Port zu
                # heisst kalt, nicht kaputt. Nutzbar bleibt er trotzdem nicht.
                ergebnis[s.name] = Pruefung(name=s.name, fehler="Standby kalt (erwartet)", kalt=True)
            else:
                ergebnis[s.name] = Pruefung(name=s.name, fehler=f"{type(e).__name__}: {e}"[:160])

    threads = [threading.Thread(target=eins, args=(s,), daemon=True) for s in server]
    for t in threads:
        t.start()
    ende = time.monotonic() + zeitlimit + 0.2
    for t in threads:
        t.join(max(0.0, ende - time.monotonic()))
    return [ergebnis.get(s.name) or Pruefung(name=s.name, fehler=f"Zeitlimit {zeitlimit:g} s")
            for s in server]


# --------------------------------------------------------------------------- Regel

def waehlen(pruefungen: list[Pruefung], aktuell: str) -> tuple[str, str]:
    """(Ziel, Grund). Reine Funktion; `pruefungen` in Listenreihenfolge."""
    nach_name = {p.name: p for p in pruefungen}
    eigen = nach_name.get(aktuell)
    if eigen is not None and eigen.nutzbar:
        return aktuell, f"{aktuell} ist nutzbar"
    nutzbar = [p for p in pruefungen if p.nutzbar]
    if not nutzbar:
        return aktuell, "kein Server nutzbar, nichts geaendert"
    beste = max(nutzbar, key=lambda p: (p.epoch, -pruefungen.index(p)))
    return beste.name, f"{aktuell} nicht nutzbar, {beste.name} ist primaer mit Epoche {beste.epoch}"


# --------------------------------------------------------------------------- Git

def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=20)


def _umleitungen(repo: Path, server: list[Server]) -> list[tuple[str, str]]:
    """Eigene insteadOf-Eintraege: (Schluessel-Basis, Wert) mit Wert = Basis des ersten
    Eintrags und Schluessel = Basis eines anderen Eintrags."""
    heim = set(server[0].git)
    fremd = {g for s in server[1:] for g in s.git}
    r = _git(repo, "config", "--local", "--get-regexp", r"^url\..*\.insteadof$")
    out = []
    for zeile in r.stdout.splitlines():
        schluessel, _, wert = zeile.partition(" ")
        basis = schluessel[len("url."):-len(".insteadof")]
        if wert in heim and basis in fremd:
            out.append((basis, wert))
    return out


def aktuell_in(repo: Path, server: list[Server]) -> str:
    """Name des Servers, auf den Git in `repo` gerade zeigt (ohne Umleitung: erster Eintrag)."""
    for basis, _ in _umleitungen(repo, server):
        for s in server[1:]:
            if basis in s.git:
                return s.name
    return server[0].name


def anwenden(repo: Path, server: list[Server], ziel: str) -> bool:
    """Setzt/entfernt die Umleitung in `repo` fuer `ziel`; True, wenn sich etwas geaendert hat."""
    vorher = sorted(_umleitungen(repo, server))
    for basis, wert in vorher:
        if ziel == server[0].name or basis not in next(s.git for s in server if s.name == ziel):
            _git(repo, "config", "--local", "--fixed-value", "--unset-all", f"url.{basis}.insteadOf", wert)
            if not _git(repo, "config", "--local", "--get-regexp", rf"^url\.{re.escape(basis)}\.").stdout.strip():
                _git(repo, "config", "--local", "--remove-section", f"url.{basis}")
    if ziel != server[0].name:
        z = next(s for s in server if s.name == ziel)
        for neu, alt in zip(z.git, server[0].git):
            if (neu, alt) not in vorher:
                _git(repo, "config", "--local", "--add", f"url.{neu}.insteadOf", alt)
    return sorted(_umleitungen(repo, server)) != vorher


def repos(vault: Path) -> list[Path]:
    vault = Path(vault)
    out = [vault] if _ist_repo(vault) else []
    for eintrag in spaces_mod.load_manifest(vault):
        mount = eintrag.get("mount") or ""
        pfad = vault / mount
        if mount and pfad != vault and _ist_repo(pfad):
            out.append(pfad)
    return out


def _ist_repo(pfad: Path) -> bool:
    return (pfad / ".git").exists()


# --------------------------------------------------------------------------- Zwischenspeicher

def _state(vault: Path) -> Path:
    return Path(vault) / STATE_REL


def zustand_lesen(vault: Path) -> dict:
    try:
        d = json.loads(_state(vault).read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _zustand_schreiben(vault: Path, daten: dict) -> None:
    pfad = _state(vault)
    try:
        pfad.parent.mkdir(parents=True, exist_ok=True)
        tmp = pfad.with_suffix(".neu")
        tmp.write_text(json.dumps(daten, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        tmp.replace(pfad)
    except OSError:
        pass


def pruefungen_holen(vault: Path, server: list[Server], frisch: bool = False,
                     jetzt: float | None = None) -> tuple[list[Pruefung], float, bool]:
    """(Pruefungen, Zeitpunkt, aus_cache)."""
    jetzt = time.time() if jetzt is None else jetzt
    alt = zustand_lesen(vault)
    namen = [s.name for s in server]
    if not frisch and isinstance(alt.get("zeit"), (int, float)) and 0 <= jetzt - alt["zeit"] < CACHE_S \
            and [p.get("name") for p in alt.get("pruefungen", [])] == namen:
        felder = Pruefung.__dataclass_fields__
        return [Pruefung(**{k: v for k, v in p.items() if k in felder}) for p in alt["pruefungen"]], \
            alt["zeit"], True
    ergebnisse = pruefen(server)
    _zustand_schreiben(vault, {**alt, "zeit": jetzt, "pruefungen": [asdict(p) for p in ergebnisse]})
    return ergebnisse, jetzt, False


# --------------------------------------------------------------------------- Befehle

def _zeit(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts).strftime("%d.%m. %H:%M:%S")


def cmd_status(vault: Path, frisch: bool = False, as_json: bool = False) -> int:
    server = konfig_laden(vault)
    ergebnisse, zeit, cache = pruefungen_holen(vault, server, frisch=frisch)
    aktuell = aktuell_in(Path(vault), server) if _ist_repo(Path(vault)) else server[0].name
    if as_json:
        print(json.dumps({"zeit": zeit, "aus_cache": cache, "git_zeigt_auf": aktuell,
                          "server": [{**asdict(p), "nutzbar": p.nutzbar,
                                      "dienst": next(s.dienst for s in server if s.name == p.name)}
                                     for p in ergebnisse]}, ensure_ascii=False))
        return 0
    print(f"Stand {_zeit(zeit)}{' (Zwischenspeicher, neu: --frisch)' if cache else ''}; "
          f"Git zeigt auf {aktuell}")
    for p, s in zip(ergebnisse, server):
        if p.erreichbar:
            print(f"  {p.name:<10} {s.dienst}  erreichbar, Rolle {p.rolle}, Epoche {p.epoch}, "
                  f"Forgejo {'ja' if p.forgejo else 'nein'}{'  -> nutzbar' if p.nutzbar else ''}")
        else:
            print(f"  {p.name:<10} {s.dienst}  {p.fehler if p.kalt else f'nicht erreichbar ({p.fehler})'}")
    return 0


def cmd_waehlen(vault: Path, still: bool = False, frisch: bool = False) -> int:
    vault = Path(vault)
    server = konfig_laden(vault)
    ziele = repos(vault)
    if not ziele:
        if not still:
            print(f"Kein Git-Repo unter {vault}")
        return 1
    ergebnisse, _, _ = pruefungen_holen(vault, server, frisch=frisch)
    aktuell = aktuell_in(ziele[0], server)
    ziel, grund = waehlen(ergebnisse, aktuell)
    geaendert = [r for r in ziele if anwenden(r, server, ziel)]
    alt = zustand_lesen(vault)
    eintrag = {**alt, "git_zeigt_auf": ziel, "heim": server[0].name, "grund": grund}
    if geaendert:
        eintrag["wechsel"] = {"zeit": time.time(), "von": aktuell, "nach": ziel,
                              "repos": [str(r) for r in geaendert]}
    _zustand_schreiben(vault, eintrag)
    if geaendert:
        if ziel == server[0].name:
            print(f"brain server: Git zeigt wieder auf {ziel} ({len(geaendert)} Repo(s)).")
        else:
            print(f"brain server: Git zeigt jetzt auf den Standby {ziel}, weil {grund} "
                  f"({len(geaendert)} Repo(s), repo-lokales insteadOf).")
    elif not still:
        print(f"Keine Aenderung: Git zeigt auf {ziel} ({grund}).")
    return 0


def umweg(vault: Path) -> list[str]:
    """Repos, in denen Git gerade nicht auf den ersten Listeneintrag zeigt (fuer `brain doctor`)."""
    try:
        server = konfig_laden(vault)
    except (ValueError, KeyError):
        return []
    return [f"{r}: {aktuell_in(r, server)}" for r in repos(vault) if aktuell_in(r, server) != server[0].name]


def add_parser(sub) -> None:
    p = sub.add_parser("server", help="Brain-Server (peer/Standby) pruefen und Git umleiten (F6)")
    ssub = p.add_subparsers(dest="servercmd", required=True)
    p_status = ssub.add_parser("status", help="Erreichbarkeit, Rolle, Epoche, Forgejo je Server")
    p_status.add_argument("--frisch", action="store_true", help="Zwischenspeicher ignorieren")
    p_status.add_argument("--json", action="store_true")
    p_status.set_defaults(func=lambda a: cmd_status(Path(a.vault), a.frisch, a.json))
    p_w = ssub.add_parser("waehlen", help="nutzbaren Server waehlen, repo-lokales insteadOf setzen/entfernen")
    p_w.add_argument("--still", action="store_true", help="nur bei einem Wechsel eine Zeile ausgeben")
    p_w.add_argument("--frisch", action="store_true", help="Zwischenspeicher ignorieren")
    p_w.set_defaults(func=lambda a: cmd_waehlen(Path(a.vault), a.still, a.frisch))
