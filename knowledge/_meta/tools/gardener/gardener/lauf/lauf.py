"""`brain run`: one process, one lock, one run id, one report, one commit.

Profiles::

    gardener  the gardener's care phases (embed, linking, consolidate,
              maintain, ingest, sidecar, synth, owner, lint/audit; no `mine`)
    lehren    ernte -> erkennen -> extrahieren -> grossmodell -> projektwahl
              -> abgleichen -> pruefen -> schreiben       (alias profile: dream)
    all       gardener, then lehren

``--dry-run`` loads no model and writes nothing to vault or state (only the
gardener's own log file under ``logs/``): the book is an in-memory
copy, the vault writer only plans, engines are only probed (``/api/tags``).
``--dry-run --mit-modell`` additionally runs the model stages against that
in-memory copy (a timing probe; still nothing on disk).  SIGTERM behaves
like SIGINT: the unit in progress is finished or dropped, the book stays
consistent, the lock is released, the run can be resumed.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, TextIO

from .. import config
from ..runtime import (Deadline, Lock, LockHeldError, commit_by_repo, dirty_paths,
                       install_termination_handler)
from ..vault import VaultWriter
from . import buch as b
from . import nachpruefen as nachpruefen_mod
from . import quellen as q
from . import projektwahl as projektwahl_mod
from . import pruefen as pruefen_mod
from . import schreiben as schreiben_mod
from . import stufen as st
from .ausgabe import Ausgabe
from .motoren import Motoren

log = logging.getLogger("gardener.lauf")

LEHREN = ["ernte", "erkennen", "extrahieren", "grossmodell", "projektwahl", "abgleichen", "pruefen",
          "schreiben"]
PROFILE = {"gardener": ["gardener"], "lehren": LEHREN, "dream": LEHREN,
           "all": ["gardener", *LEHREN]}
# ``--stufen`` only (opt-in): ``nachpruefen`` re-opens the discarded backlog the
# current rule keeps, without a model call (nachpruefen, 2026-09-27); it is not
# part of any profile.  ``STUFEN_WAHL`` is the ``--stufen`` vocabulary and
# fixes the order, so ``nachpruefen`` must sit before ``schreiben``.
STUFEN_WAHL = ["gardener", *LEHREN[:-1], "nachpruefen", "schreiben"]
MODELL_STUFEN = {"extrahieren", "grossmodell", "projektwahl", "abgleichen", "pruefen"}
# a required model stage without its engine fails the run (exit 1); ``pruefen``
# only while its model part is on (``BRAIN_PRUEFEN``), so no unchecked
# proposal is written
PFLICHT_STUFEN = {"extrahieren", "abgleichen", "pruefen"}
# `--klassen` names (German, as in the docs) -> source classes of the book
KLASSEN_NAMEN = {"transkript": q.TRANSCRIPT, "worker": q.WORKER, "doku": q.DOC,
                 "memory": q.MEMORY}
LOCK_NAME = "brain-run.lock"
LAST_FILE = "brain-run-last.json"
PIPELINE_AUTHOR = "brain-pipeline <brain-pipeline@local>"


def buch_pfad() -> Path:
    return config.STATE_DIR / "dream" / "dream.db"


def klassen_aus(namen: list[str] | None) -> tuple[str, ...] | None:
    """``transkript,worker,doku,memory`` (or the class names) -> classes."""
    if not namen:
        return None
    out = []
    for name in namen:
        name = name.strip().lower()
        klasse = KLASSEN_NAMEN.get(name, name)
        if klasse not in q.KLASSEN:
            raise ValueError(f"unbekannte Klasse {name!r} (erlaubt: {', '.join(KLASSEN_NAMEN)})")
        out.append(klasse)
    return tuple(out)


def new_lauf_id() -> str:
    return dt.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + os.urandom(2).hex()


def _pipeline_commit_message(message: str) -> tuple[str, str | None]:
    """A runner job has a distinct author and an auditable triggering login.

    The runner supplies a Forgejo login, not an arbitrary commit trailer.  Keep
    manual runs byte-for-byte on their established author/message path.
    """
    ausgeloest_von = " ".join(os.environ.get("BRAIN_RUN_AUSGELOEST_VON", "").split())
    if not ausgeloest_von:
        return message, None
    # Own trailer, not Co-authored-by: since 25.09.2026 the global commit-msg hook
    # strips every co-author line (der Nutzer: no co-authors, ever). The triggering
    # login is provenance, not authorship.
    return f"{message}\n\nAusgeloest-von: {ausgeloest_von}", PIPELINE_AUTHOR


def _gardener_stage(vault: Path, gardener_args: dict, *, dry_run: bool, report_rel: str,
                    json_mode: bool) -> tuple[int, dict]:
    from .. import cli as gardener_cli
    sammel: dict[str, Any] = {"report_rel": report_rel}
    ns = argparse.Namespace(vault=str(vault), phase=gardener_args.get("phase", "all"),
                            dry_run=dry_run, once=True, audit=gardener_args.get("audit", False),
                            topic=gardener_args.get("topic"), min_notes=gardener_args.get("min_notes"),
                            budget_minutes=gardener_args.get("budget_minutes"),
                            verbose=gardener_args.get("verbose", False), sammel=sammel)
    target = sys.stderr if json_mode else sys.stdout
    with contextlib.redirect_stdout(target):
        rc = gardener_cli.run(ns)
    return rc, sammel


def _bericht(lauf_id: str, profil: str, stufen: list[str], dry_run: bool, results: list[dict],
             schreib: dict | None, gardener: dict | None, buch_zahlen: dict, pakete: dict,
             migration: dict, motoren_info: dict | None, status: str) -> str:
    lines = [f"# brain run {lauf_id}", "",
             f"Profil `{profil}`, Stufen {', '.join(stufen)}"
             + (" (Trockenlauf)" if dry_run else "") + f". Status: {status}.", ""]
    if motoren_info:
        lines += ["## Motoren", ""]
        for stufe, info in motoren_info.items():
            lines.append(f"- {stufe}: {info['engine']} {', '.join(info['modelle'])} "
                         f"(bereit: {', '.join(info['bereit']) or 'keins'})")
        lines.append("")
    if results:
        lines += ["## Stufen", "", "| Stufe | bearbeitet | Fehlschläge | Zustände | s je Einheit (Median) | Anmerkung |",
                  "|---|---|---|---|---|---|"]
        for r in results:
            med = (r.get("sekunden_je_einheit") or {}).get("median")
            note = r.get("uebersprungen") or ("abgebrochen" if r.get("abgebrochen") else "")
            if r.get("fehler"):
                note = (note + "; " if note else "") + f"{len(r['fehler'])} Fehler"
            lines.append(f"| {r['stufe']} | {r.get('bearbeitet', '')} | {r.get('fehlschlaege', 0)} | "
                         f"{', '.join(f'{k} {v}' for k, v in (r.get('zustaende') or {}).items())} | "
                         f"{'' if med is None else f'{med:.2f}'} | {note} |")
        lines.append("")
    if schreib:
        lines += ["## Geschrieben (nur Vorschläge)", ""]
        for rel in schreib["geschrieben"] or schreib["geplant"]:
            lines.append(f"- {rel}" + (" (geplant)" if dry_run else ""))
        for rel, why in schreib["verweigert"]:
            lines.append(f"- NICHT geschrieben: {rel} ({why})")
        lines.append(f"- Pakete vorgeschlagen: {schreib['vorgeschlagen']}, ohne Ziel: "
                     f"{schreib['ohne_ziel']}, übernommen erkannt: {schreib['uebernommen']}")
        lines.append("")
    lines += ["## Buch", "", "Einheiten: " + ", ".join(f"{k} {v}" for k, v in buch_zahlen.items()),
              "Pakete: " + (", ".join(f"{k} {v}" for k, v in pakete.items()) or "keine"),
              f"Migration dream.db: {migration.get('kopiert', 0)} von {migration.get('legacy', 0)} "
              f"Alt-Einheiten im Buch (neu in diesem Lauf: {migration.get('neu', 0)}).", ""]
    if gardener and gardener.get("report"):
        lines += ["## Gärtner", "", gardener["report"].strip(), ""]
    return "\n".join(lines) + "\n"


def run(vault: Path, *, profil: str = "all", stufen: list[str] | None = None,
        limit: int | None = None, dry_run: bool = False, mit_modell: bool = False,
        json_mode: bool = False, budget_minutes: float | None = None,
        remote: str | None = None, gardener_args: dict | None = None,
        motoren: Motoren | None = None, wurzeln: q.Wurzeln | None = None,
        leser: q.Leser | None = None, stream: TextIO | None = None,
        lauf_id: str | None = None, klassen: list[str] | None = None,
        projekt: str | None = None) -> int:
    vault = Path(vault).expanduser().resolve()
    if profil not in PROFILE:
        raise ValueError(f"unbekanntes Profil {profil!r}")
    plan = list(PROFILE[profil])
    if stufen:
        unknown = [s for s in stufen if s not in STUFEN_WAHL]
        if unknown:
            raise ValueError(f"unbekannte Stufen: {unknown}")
        plan = [s for s in STUFEN_WAHL if s in stufen]
    klassen_ = klassen_aus(klassen)
    auswahl = {"klassen": klassen_, "projekt": projekt}
    lauf_id = lauf_id or new_lauf_id()
    out = Ausgabe(lauf_id, json_mode=json_mode, stream=stream)
    started_wall = dt.datetime.now().isoformat(timespec="seconds")
    started = time.monotonic()
    deadline = Deadline(budget_minutes * 60) if budget_minutes is not None else None
    stop = (lambda: deadline.expired()) if deadline is not None else (lambda: False)
    gardener_args = dict(gardener_args or {})
    if budget_minutes is not None:
        gardener_args.setdefault("budget_minutes", budget_minutes)
    report_rel = f"00-sources/brain-run-{lauf_id}.md"
    out.start(profil=profil, stufen=plan, dry_run=dry_run, mit_modell=mit_modell,
              klassen=list(klassen_) if klassen_ else None, projekt=projekt)

    locks: list[Lock] = []
    buch = None
    results: list[dict] = []
    schreib = None
    gardener_sammel: dict | None = None
    motoren_info = None
    status = "ok"
    exit_code = 0
    commits: list[dict] = []
    own_motoren = motoren is None
    try:
        if not dry_run:
            for name in (LOCK_NAME, "dream/dream.lock") if any(s != "gardener" for s in plan) else (LOCK_NAME,):
                lock = Lock(config.STATE_DIR / name)
                lock.acquire()
                locks.append(lock)
        foreign = dirty_paths(vault) if not dry_run and (vault / ".git").exists() else []
        writer = VaultWriter(vault, dry_run=dry_run, foreign=foreign)

        if "gardener" in plan:
            out.stufe_start("gardener")
            rc, gardener_sammel = _gardener_stage(vault, gardener_args, dry_run=dry_run,
                                                  report_rel=report_rel, json_mode=json_mode)
            gres = {"stufe": "gardener", "bearbeitet": len(gardener_sammel.get("written", [])),
                    "zustaende": {"exit": rc}, "fehler": [], "uebersprungen": None,
                    "abgebrochen": False, "sekunden_je_einheit": {}}
            if rc != 0:
                exit_code = rc      # `brain gardener run` keeps the gardener's exit codes
                gres["fehler"].append(f"gardener exit {rc}")
                out.fehler("gardener", f"gardener endete mit Exit {rc}")
                status = "teilweise"
            results.append(gres)
            out.stufe_ende("gardener", gres)

        lehren = [s for s in plan if s != "gardener"]
        if lehren:
            buch = b.Buch(buch_pfad(), in_memory=dry_run)
            leser = leser or q.Leser()
            router = q.Router(vault, leser)
            geschlossen = pruefen_mod.lade_geschlossene(vault)
            if motoren is None and any(s in MODELL_STUFEN for s in lehren):
                motoren = Motoren.from_file()
            ctx = motoren if (motoren is not None and own_motoren) else contextlib.nullcontext()
            with ctx:
                if motoren is not None:
                    motoren_info = motoren.beschreibung()
                for stufe in lehren:
                    if stop():
                        out.stufe_uebersprungen(stufe, "Zeitbudget erschoepft")
                        status = "teilweise"
                        continue
                    if dry_run and not mit_modell and stufe in MODELL_STUFEN:
                        if stufe == "projektwahl":
                            n = 0 if projekt else len(buch.ohne_projekt(
                                classes=st._klassen(klassen_), limit=limit))
                        elif stufe == "pruefen":
                            n = len(buch.zu_pruefen(classes=st._klassen(klassen_), projekt=projekt,
                                                    limit=limit))
                        else:
                            waiting = {"extrahieren": b.ERKANNT, "grossmodell": b.WARTET,
                                       "abgleichen": b.EXTRAHIERT}[stufe]
                            n = len(buch.units(waiting, limit=limit, reihenfolge=True,
                                               classes=st._klassen(klassen_), projekt=projekt))
                        einheit = "Pakete" if stufe == "pruefen" else "Einheiten"
                        out.stufe_uebersprungen(stufe, f"Trockenlauf: {n} {einheit} warten, kein Modell geladen")
                        results.append({"stufe": stufe, "bearbeitet": 0, "zustaende": {"wartend": n},
                                        "uebersprungen": "trockenlauf", "fehler": [],
                                        "sekunden_je_einheit": {}})
                        continue
                    out.stufe_start(stufe)
                    fort = out.fortschritt
                    if stufe == "ernte":
                        wurzeln_ = wurzeln or q.Wurzeln()
                        sources = q.lokale_quellen(wurzeln_, klassen_ or q.KLASSEN)
                        if remote:
                            try:
                                sources += q.remote_quellen(remote, leser, klassen_ or q.KLASSEN)
                            except OSError as exc:
                                out.fehler("ernte", f"--remote {remote}: {exc}")
                                status = "teilweise"
                        ern = q.ernte(buch, sources, leser=leser, router=router, lauf_id=lauf_id,
                                      stop=stop, fortschritt=lambda d, t: fort("ernte", d, t))
                        res = {"stufe": "ernte", "bearbeitet": sum(ern.quellen.values()),
                               "zustaende": {"pending-neu": ern.neu_pending, "unveraendert": ern.unveraendert,
                                             **{f"skipped:{k}": v for k, v in ern.uebersprungen.items()}},
                               "quellen": ern.quellen, "geheimnis_tor": len(ern.geheimnis),
                               "fehler": ern.fehler[:20], "uebersprungen": None,
                               "abgebrochen": ern.abgebrochen, "sekunden_je_einheit": {}}
                    elif stufe == "erkennen":
                        res = st.erkennen(buch, leser=leser, router=router, lauf_id=lauf_id,
                                          limit=limit, stop=stop, fortschritt=fort,
                                          geschlossen=geschlossen, **auswahl).als_dict()
                    elif stufe in ("extrahieren", "grossmodell"):
                        res = st.extrahieren(buch, motoren=motoren, leser=leser, lauf_id=lauf_id,
                                             limit=limit, grossmodell=stufe == "grossmodell",
                                             stop=stop, fortschritt=fort, geschlossen=geschlossen,
                                             **auswahl).als_dict()
                    elif stufe == "projektwahl":
                        res = projektwahl_mod.projektwahl(
                            buch, motoren=motoren, leser=leser, router=router, vault=vault,
                            lauf_id=lauf_id, limit=limit, stop=stop, fortschritt=fort,
                            **auswahl).als_dict()
                    elif stufe == "abgleichen":
                        res = st.abgleichen(buch, motoren=motoren, lauf_id=lauf_id, limit=limit,
                                            stop=stop, fortschritt=fort, **auswahl).als_dict()
                    elif stufe == "pruefen":
                        res = pruefen_mod.pruefen(buch, motoren=motoren, leser=leser, vault=vault,
                                                  lauf_id=lauf_id, limit=limit, stop=stop,
                                                  fortschritt=fort, **auswahl).als_dict()
                    elif stufe == "nachpruefen":
                        standard = motoren.stufen["pruefen"].get("schwelle") if motoren else None
                        res = nachpruefen_mod.nachpruefen(
                            buch, lauf_id=lauf_id, limit=limit, stop=stop, fortschritt=fort,
                            schwelle_standard=standard, **auswahl).als_dict()
                        vert = res.get("verteilung") or {}
                        if vert.get("kandidaten"):
                            out.text(f"  nachpruefen: {vert['behalten']} von {vert['kandidaten']} "
                                     "verworfenen Paketen neu behalten (je Art: "
                                     + ", ".join(f"{k} {v}" for k, v in vert.get("je_art", {}).items())
                                     + ")")
                    else:   # schreiben
                        sres = schreiben_mod.schreiben(buch, writer, lauf_id=lauf_id)
                        schreib = sres.als_dict()
                        res = {"stufe": "schreiben", "bearbeitet": sres.vorgeschlagen,
                               "zustaende": {"vorgeschlagen": sres.vorgeschlagen, "ohne-ziel": sres.ohne_ziel,
                                             "uebernommen": sres.uebernommen},
                               "fehler": [f"{r}: {w}" for r, w in sres.verweigert],
                               "uebersprungen": None, "abgebrochen": False, "sekunden_je_einheit": {}}
                    for message in res.get("fehler") or []:
                        out.fehler(stufe, message)
                    if (stufe in PFLICHT_STUFEN and res.get("uebersprungen") == "Motor nicht erreichbar"
                            and (stufe != "pruefen" or pruefen_mod.aktiv())):
                        status, exit_code = "fehler", 1
                    if res.get("abgebrochen") or res.get("uebersprungen"):
                        if status == "ok":
                            status = "teilweise"
                    results.append(res)
                    out.stufe_ende(stufe, res)
                    if status == "fehler":
                        break
    except LockHeldError as exc:
        out.fehler(None, str(exc))
        status, exit_code = "gesperrt", 4
    except KeyboardInterrupt:
        out.fehler(None, "abgebrochen (SIGINT/SIGTERM); Buch konsistent, Lauf fortsetzbar")
        status, exit_code = "abgebrochen", 130
    except b.MigrationError as exc:
        out.fehler(None, str(exc))
        status, exit_code = "fehler", 1
    except Exception as exc:     # report, then fail loudly
        log.exception("brain run failed")
        out.fehler(None, f"{type(exc).__name__}: {exc}")
        status, exit_code = "fehler", 1
    finally:
        buch_zahlen: dict = {}
        pakete: dict = {}
        bericht_rel = None
        report = ""
        try:
            buch_zahlen = buch.zaehlung() if buch is not None else {}
            pakete = buch.paket_zaehlung() if buch is not None else {}
            migration = buch.migration if buch is not None else {}
            report = _bericht(lauf_id, profil, plan, dry_run, results, schreib, gardener_sammel,
                              buch_zahlen, pakete, migration, motoren_info, status)
            bericht_rel = None
            written = list((schreib or {}).get("geschrieben") or []) + \
                list((gardener_sammel or {}).get("written") or [])
            if status != "gesperrt":
                if dry_run:
                    out.text("")
                    out.text(report)
                elif not written:
                    out.text("")
                    out.text(report)        # not in the vault; also in brain-run-last.json
                else:
                    # Only a run that changed a vault file leaves a report and a commit;
                    # otherwise (e.g. `--phase embed`, vectors only) the state stays in
                    # state/brain-run-last.json.
                    ok = VaultWriter(vault, foreign=()).write(vault / report_rel, report, expect=None)
                    if ok:
                        bericht_rel = report_rel
                        written.append(report_rel)
                    if written and (vault / ".git").exists():
                        msg = f"brain run {lauf_id} [{profil}]: {len(written)} file(s), status {status}"
                        msg, author = _pipeline_commit_message(msg)
                        try:
                            for c in commit_by_repo(vault, msg, written, author=author):
                                commits.append({"committed": c.committed, "paths": c.paths,
                                                "repo": c.repo, "ignored": c.ignored,
                                                "error": c.error})
                                # Ein Teilfehler (ein Repo scheitert, die anderen
                                # nicht) muss sichtbar sein, nicht nur im Log.
                                if c.error:
                                    out.fehler(None, f"commit {c.repo}: {c.error}")
                                    status = "fehler"
                                    exit_code = exit_code or 1
                                if c.ignored:
                                    out.fehler(None, f"commit {c.repo}: ignoriert, nicht "
                                                     f"eingestellt: {', '.join(c.ignored)}")
                        except Exception as exc:     # the run's work stays on disk, uncommitted
                            out.fehler(None, f"commit: {exc}")
                            status = "fehler"
                            exit_code = exit_code or 1
            if buch is not None:
                summary = {"status": status, "stufen": results, "bericht": bericht_rel}
                if not dry_run:
                    buch.lauf_start(lauf_id, profil, plan, started_wall)
                    buch.lauf_ende(lauf_id, status, dt.datetime.now().isoformat(timespec="seconds"), summary)
                buch.close()
            if not dry_run and status != "gesperrt":
                try:
                    (config.STATE_DIR / LAST_FILE).write_text(json.dumps(
                        {"lauf_id": lauf_id, "profil": profil, "status": status, "gestartet": started_wall,
                         "beendet": dt.datetime.now().isoformat(timespec="seconds"),
                         "bericht": bericht_rel, "einheiten": buch_zahlen, "pakete": pakete,
                         "fehlschlaege_je_stufe": {r["stufe"]: r.get("fehlschlaege", len(r.get("fehler", [])))
                                                   for r in results},
                         **({} if bericht_rel else {"bericht_text": report})},
                        ensure_ascii=False, indent=2) + "\n")
                except OSError:
                    pass
        except Exception as exc:     # a failing final step must not skip lock release or the closing message
            log.exception("brain run: final step failed")
            out.fehler(None, f"Abschluss: {type(exc).__name__}: {exc}")
            status = "fehler"
            exit_code = exit_code or 1
            if buch is not None:
                with contextlib.suppress(Exception):
                    buch.close()
        finally:
            for lock in reversed(locks):
                try:
                    lock.release()
                except Exception:
                    log.exception("brain run: lock release failed")
        out.abschluss(status=status, exit_code=exit_code, profil=profil, stufen=plan,
                      dry_run=dry_run, dauer_s=round(time.monotonic() - started, 2),
                      einheiten=buch_zahlen, pakete=pakete, stufen_ergebnisse=results,
                      schreiben=schreib, bericht=bericht_rel, commits=commits)
    return exit_code


def abgleich_nachlauf(vault: Path, bis_lauf: str, *, dry_run: bool = False) -> dict:
    """Reopen ``abgleichen`` for packages extracted in runs up to ``bis_lauf``
    (``Buch.abgleich_zuruecksetzen``): status only, nothing deleted.  Takes the
    run lock, so it never overlaps a running `brain run`.  The comparison
    itself is the next ``brain run --profil lehren --stufen abgleichen,schreiben``."""
    if not bis_lauf or not bis_lauf[:8].isdigit():
        raise ValueError(f"--bis-lauf braucht eine Lauf-ID (JJJJMMTT-HHMMSS-xxxx), nicht {bis_lauf!r}")
    lock = None
    if not dry_run:
        lock = Lock(config.STATE_DIR / LOCK_NAME)
        lock.acquire()
    try:
        buch = b.Buch(buch_pfad(), in_memory=dry_run)
        try:
            zahlen = buch.abgleich_zuruecksetzen(bis_lauf)
            if not dry_run:
                buch.commit()
        finally:
            buch.close()
    finally:
        if lock is not None:
            lock.release()
    return {"bis_lauf": bis_lauf, "dry_run": dry_run, **zahlen}


def status(vault: Path) -> dict:
    """Book and last run, read-only (for `brain run status [--json]`)."""
    path = buch_pfad()
    info: dict[str, Any] = {"buch": str(path), "einheiten": {}, "pakete": {}, "letzter_lauf": None,
                            "laeuft": False}
    lock = config.STATE_DIR / LOCK_NAME
    if lock.exists():
        try:
            pid = int(lock.read_text().split()[0])
            os.kill(pid, 0)
            info["laeuft"] = True
        except (OSError, ValueError, IndexError):
            info["laeuft"] = False
    if path.exists():
        buch = b.Buch(path, in_memory=True)
        try:
            info["einheiten"] = buch.zaehlung()
            info["pakete"] = buch.paket_zaehlung()
            info["migration"] = buch.migration
        finally:
            buch.close()
    try:
        info["letzter_lauf"] = json.loads((config.STATE_DIR / LAST_FILE).read_text())
    except (OSError, ValueError):
        pass
    return info


def main_signals() -> None:
    """SIGTERM = SIGINT, from the main thread only."""
    install_termination_handler()


def uebernehmen(vault: Path, *, ok: list[str] | None = None, dry_run: bool = False,
                listen: list[Path] | None = None, zellen: Path | None = None,
                buch: Path | None = None, einbetten: bool = True,
                motoren: Motoren | None = None, heute: str | None = None) -> dict:
    """`brain run uebernehmen` (p3, since 10.10.2026 only with an OK).

    Without ``ok``: the ready proposals (cloud-checked and cell-proven, near
    duplicates merged) are only LISTED with their selection basis and source
    (``vorschlaege``); nothing is written, the book stays untouched.  With
    ``ok`` (package ids): exactly those packages go into FALLEN.yaml / the
    decision note / KERN (``uebernehmen.uebernehmen``), and only when the
    caller measures as orchestrator or human (``freigabe.pruefe``, der Nutzer
    10.10.: "ok eines Orchestrators reicht"); the approval is recorded with
    every entry.  Takes the run lock, writes through the vault gate, one
    commit; ``dry_run`` works on an in-memory book and only plans.  ``buch``
    reads another book file (a copy) -- always only in memory."""
    from . import freigabe as freigabe_mod
    from . import uebernehmen as ueb
    vault = Path(vault).expanduser().resolve()
    pfad = Path(buch) if buch else buch_pfad()
    nur_liste = ok is None
    if nur_liste:
        dry_run = True
    if buch and not dry_run:
        raise ValueError("--buch (eine Kopie) nur mit --dry-run")
    freigabe = None
    if not nur_liste:
        ok = [str(x).strip() for x in ok if str(x).strip()]
        if not ok:
            raise ValueError("--ok braucht mindestens eine Paket-ID")
        if dry_run:
            freigabe = "ok (Probe)"
        else:
            rolle, wer = freigabe_mod.pruefe()
            freigabe = f"ok {rolle}: {wer}"
    lock = None
    if not dry_run:
        lock = Lock(config.STATE_DIR / LOCK_NAME)
        lock.acquire()
    lauf_id = "uebernahme-" + new_lauf_id()
    try:
        book = b.Buch(pfad, in_memory=dry_run)
        foreign = dirty_paths(vault) if not dry_run and (vault / ".git").exists() else []
        writer = VaultWriter(vault, dry_run=dry_run, foreign=foreign)
        own = motoren is None and einbetten
        if own:
            motoren = Motoren.from_file()
        ctx = motoren if (motoren is not None and own) else contextlib.nullcontext()
        with ctx:
            embed_fn, gleich = None, 0.62
            if einbetten and motoren is not None and motoren.verfuegbar("einbettung"):
                embed_fn, gleich = motoren.einbetten, motoren.gleich_cos
            try:
                res = ueb.uebernehmen(book, writer,
                                      listen=listen if listen is not None else ueb.LISTEN_STANDARD,
                                      zellen_datei=zellen if zellen is not None else ueb.ZELLEN_STANDARD,
                                      einbetten=embed_fn, gleich_cos=gleich, lauf_id=lauf_id, heute=heute,
                                      ids=ok, freigabe=freigabe)
            finally:
                book.close()
        info = res.als_dict()
        info["einbettung"] = embed_fn is not None
        info["modus"] = "vorschlaege" if nur_liste else "uebernahme"
        if nur_liste:   # a list writes nothing; what an OK for all of them would touch
            info["wuerde_schreiben"], info["geschrieben"] = info["geschrieben"], []
        info["freigabe"] = freigabe
        if not dry_run and res.geschrieben and (vault / ".git").exists():
            msg = f"brain run uebernehmen {lauf_id}: {res.uebernommen} package(s) taken over"
            msg, author = _pipeline_commit_message(msg)
            for c in commit_by_repo(vault, msg, res.geschrieben, author=author):
                info["commits"].append({"committed": c.committed, "paths": c.paths,
                                        "repo": c.repo, "ignored": c.ignored,
                                        "error": c.error})
        return info
    finally:
        if lock is not None:
            lock.release()
