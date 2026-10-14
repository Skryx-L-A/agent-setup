"""Geaenderte Notizen nach einem Commit neu einbetten (Auftrag b6-einbett, 2026-09-28).

Anlass: `brain doctor` meldete 12-18 von 684 Notizen als veraltet, meist genau die
aktiven (BRAIN5-STATE, KERN), weil der Einbettungs-Index nur bei einem Gaertner-/
`brain run`-Lauf nachgezogen wurde. Die git-Hooks `post-commit`, `post-merge` und
`post-rewrite` (`_meta/tools/git-hooks/post-commit`) legen deshalb eine Marke ab und
starten diesen Lauf losgeloest; der Commit selbst wartet auf nichts.

Ablauf eines Laufs (`python -m braincli.nachbetten --vault <vault>`):

1. Sperre `state/nachbetten.lock` (flock, nicht blockierend): laeuft schon einer, endet
   dieser sofort - der laufende sieht die Marke ohnehin.
2. Entprellen: erst wenn die Marke `state/nachbetten.dirty` `RUHE_S` Sekunden alt ist
   (hoechstens `MAX_WARTEN_S` ab Start), mehrere Commits in kurzer Folge ergeben einen Lauf.
3. Vorbedingungen, sonst still ueberspringen (`brain doctor` sieht weiter "veraltet"):
   Ollama erreichbar; Akku nicht unter `AKKU_MIN_PROZENT` und entladend. Auf einer Maschine mit `nvidia-smi` (peer)
   nur eine technische Pruefung (Entscheidung der Nutzer 09.10.: Vault hat Vorrang vor dem Trader): liegt das
   Einbettungsmodell nicht schon auf der GPU und sind weniger als `GPU_MIN_MIB` frei, kurz warten
   (`GPU_WARTEN_S`), dann notfalls auf der CPU einbetten (`num_gpu: 0`). Aufgeschoben wird nie.
4. Nur, was der Index nicht hat: dieselbe Veraltungsregel wie `brain doctor`
   (`stats._index_rows`) liefert die Notizen ohne passenden Vektor; nur diese werden
   eingebettet, alles andere bleibt unberuehrt. Weder wird geloescht noch bereinigt
   (die Lehre vom Indexverlust 2026-08-04: ein Hook-Lauf loescht nie Vektoren).
   Gaertner-Index (`embeddinggemma`), MOC-Nebenspeicher, und jeder eigene Modell-Index,
   dessen Kopf zum Modell passt und dessen Ollama-Tag vorhanden ist.
5. Kam waehrenddessen eine neue Marke, ein weiterer Durchgang (hoechstens `RUNDEN`).
6. Prozessende. Kein Dauerdienst.

Ein leerer oder fehlender Gaertner-Index wird NICHT vom Hook gebaut (das ist ein voller
`brain gardener run --phase embed`); mehr als `MAX_NOTIZEN` veraltete Notizen werden in
Stuecken abgearbeitet, der Rest beim naechsten Commit.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from gardener import config
from gardener.linking import cache_key, embed_document
from gardener.ollama import OllamaClient, OllamaError, OllamaUnavailable
from gardener.store import Store

from . import einbettung, stats

RUHE_S = 30            # Marke so lange unveraendert = keine weiteren Commits mehr
MAX_WARTEN_S = 90      # Entprellen hoechstens so lange (ab Start)
AKKU_MIN_PROZENT = 20
MAX_NOTIZEN = 100      # je Lauf; Rest beim naechsten Anlass
FRIST_S = 300          # Gesamtdauer der Arbeit eines Durchgangs
RUNDEN = 3
LOG_MAX_BYTES = 200_000

OLLAMA_ENV = "BRAIN_NACHBETTEN_OLLAMA"      # nur fuer Tests (Doppelgaenger-Server)
RUHE_ENV = "BRAIN_NACHBETTEN_RUHE"          # nur fuer Tests: Entprellzeit
GPU_ENV = "BRAIN_NACHBETTEN_GPU_PRUEFUNG"     # 0 = GPU-Pruefung aus (immer Ollamas eigene Wahl)
GPU_MIN_MIB = 1024     # embeddinggemma belegt auf peer 681 MB (`ollama ps`, 09.10.), dazu Arbeitsspeicher
GPU_WARTEN_S = 60      # so lange auf freien GPU-Speicher warten, dann CPU
GPU_TAKT_S = 10
AKKU_ENV = "BRAIN_NACHBETTEN_AKKU"          # nur fuer Tests: "<prozent>[:laden]"


def zustandsdir(vault: Path) -> Path:
    return config.tool_dir_for(vault, "braincli") / "state"


def marke_pfad(vault: Path) -> Path:
    return zustandsdir(vault) / "nachbetten.dirty"


def log_pfad(vault: Path) -> Path:
    return zustandsdir(vault) / "nachbetten.log"


def _log(vault: Path, text: str) -> None:
    pfad = log_pfad(vault)
    try:
        pfad.parent.mkdir(parents=True, exist_ok=True)
        if pfad.exists() and pfad.stat().st_size > LOG_MAX_BYTES:
            rest = pfad.read_bytes()[-LOG_MAX_BYTES // 2:]
            pfad.write_bytes(rest[rest.find(b"\n") + 1:])
        with pfad.open("a", encoding="utf-8") as f:
            f.write(f"{dt.datetime.now().isoformat(timespec='seconds')} {text}\n")
    except OSError:
        pass


# -- Vorbedingungen -----------------------------------------------------------

def akku_stand() -> tuple[int | None, bool]:
    """(Prozent, entlaedt) der Batterie; (None, False) ohne Batterie oder unlesbar."""
    test = os.environ.get(AKKU_ENV)
    if test:
        prozent, _, laden = test.partition(":")
        return int(prozent), laden != "laden"
    try:
        if sys.platform == "darwin":
            out = subprocess.run(["pmset", "-g", "batt"], capture_output=True, text=True,
                                 timeout=5).stdout
            m = re.search(r"(\d+)%;\s*([a-z ]+)", out)
            if not m:
                return None, False
            return int(m.group(1)), m.group(2).strip() == "discharging"
        for bat in sorted(Path("/sys/class/power_supply").glob("BAT*")):
            return (int((bat / "capacity").read_text()),
                    (bat / "status").read_text().strip() == "Discharging")
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None, False


def akku_zu_leer() -> bool:
    prozent, entlaedt = akku_stand()
    return prozent is not None and entlaedt and prozent < AKKU_MIN_PROZENT


def _gpu_frei(run, which) -> int | None:
    try:
        r = run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=10)
        return int((r.stdout or "").strip().splitlines()[0]) if r.returncode == 0 else None
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


def _modell_auf_gpu(basis_url: str, modell: str) -> bool:
    try:
        with urllib.request.urlopen(basis_url.rstrip("/") + "/api/ps", timeout=3) as r:
            daten = json.loads(r.read())
    except Exception:
        return False
    return any(str(m.get("name", "")).split(":")[0] == modell.split(":")[0] and (m.get("size_vram") or 0) > 0
               for m in daten.get("models") or [])


def geraet(basis_url: str, modell: str = config.EMBED_MODEL, run=subprocess.run, which=shutil.which,
           schlafen=time.sleep, warten_s: float = GPU_WARTEN_S) -> str:
    """"gpu", "cpu" oder "frei" (keine Pruefung): wo jetzt eingebettet wird (Entscheidung der Nutzer 09.10.2026:
    Vault hat Vorrang vor dem Trader; nur die technische Machbarkeit zaehlt). Ohne `nvidia-smi` (Mac) oder mit
    GPU_ENV=0 entscheidet Ollama selbst. Liegt das Modell schon auf der GPU, braucht es keinen neuen Platz. Sonst
    bis `warten_s` auf GPU_MIN_MIB freien Speicher warten; reicht es dann nicht oder ist nichts messbar: CPU."""
    if os.environ.get(GPU_ENV, "1").strip().lower() in ("0", "aus", "off", "false", "no") or not which("nvidia-smi"):
        return "frei"
    if _modell_auf_gpu(basis_url, modell):
        return "gpu"
    ende = time.monotonic() + warten_s
    while True:
        frei = _gpu_frei(run, which)
        if frei is not None and frei >= GPU_MIN_MIB:
            return "gpu"
        if time.monotonic() >= ende:
            return "cpu"
        schlafen(GPU_TAKT_S)


def ollama_erreichbar(basis_url: str) -> bool:
    try:
        with urllib.request.urlopen(basis_url.rstrip("/") + "/api/tags", timeout=3):
            return True
    except Exception:
        return False


# -- Arbeit -------------------------------------------------------------------

def _gaertner_nachziehen(vault: Path, client, frist: float, limit: int) -> dict:
    """Veraltete Notizen in gardener.db einbetten. Bereinigt (prune) NIE."""
    db = config.tool_dir_for(vault) / "state" / "gardener.db"
    if not db.exists():
        return {"uebersprungen": "gardener.db fehlt (brain gardener run --phase embed)"}
    corpus, rows, _n, keyfn, _m, _miss = stats._index_rows(
        vault, None, einbettung.MODELLE["embeddinggemma"])
    if not rows:
        return {"uebersprungen": "gardener.db ohne Vektoren (brain gardener run --phase embed)"}
    veraltet = [n for n in corpus if rows.get(n.rel) != keyfn(n)]
    stand = {"veraltet": len(veraltet), "eingebettet": 0, "fehlgeschlagen": 0}
    if not veraltet:
        return stand
    store = Store(db)
    try:
        for n in veraltet[:limit]:
            if time.monotonic() > frist:
                stand["frist"] = True
                break
            try:
                vec = embed_document(client, n.embed_text)
            except OllamaUnavailable:
                raise
            except OllamaError as e:
                stand["fehlgeschlagen"] += 1
                _log(vault, f"Einbettung fehlgeschlagen {n.rel}: {e}")
                continue
            store.put_embedding(n.rel, cache_key(n), vec)
            stand["eingebettet"] += 1
    finally:
        store.close()
    if len(veraltet) > limit:
        stand["rest"] = len(veraltet) - limit
    return stand


def _moc_nachziehen(vault: Path, client) -> dict:
    from . import extra_embed
    try:
        fehlt = extra_embed.stale(vault)
    except (OSError, sqlite3.Error):
        return {}
    if not fehlt:
        return {"veraltet": 0}
    status = extra_embed.build(vault, client=client)
    return {"veraltet": len(fehlt),
            "eingebettet": sum(1 for s in status.values() if s == "embedded")}


def _eigene_nachziehen(vault: Path, modell, frist: float, limit: int,
                       embed_options: dict | None = None) -> dict:
    """Wie `_gaertner_nachziehen` fuer den eigenen Index eines Modells. Ein Fehler laesst
    den alten Vektor stehen (anders als `einbettung.nachziehen` fuer `brain undo`)."""
    pfad = einbettung.index_pfad(vault, modell)
    if not einbettung.kopf_passt(einbettung.lies_kopf(pfad), modell):
        return {}
    client = OllamaClient(embed_model=modell.ollama)
    client.embed_options = embed_options      # CPU-Rueckfall wie beim Gaertner-Index
    if not client.has_model(modell.ollama):
        return {"uebersprungen": f"{modell.ollama} nicht in Ollama"}
    corpus, rows, _n, keyfn, _m, _miss = stats._index_rows(vault, None, modell)
    veraltet = [n for n in corpus if rows.get(n.rel) != keyfn(n)]
    stand = {"veraltet": len(veraltet), "eingebettet": 0, "fehlgeschlagen": 0}
    if not veraltet:
        return stand
    conn = sqlite3.connect(pfad, timeout=30)
    try:
        for n in veraltet[:limit]:
            if time.monotonic() > frist:
                stand["frist"] = True
                break
            try:
                vec = einbettung.dokument_vektor(client, modell, n.embed_text)
            except OllamaUnavailable:
                raise
            except OllamaError as e:
                stand["fehlgeschlagen"] += 1
                _log(vault, f"{modell.name}: Einbettung fehlgeschlagen {n.rel}: {e}")
                continue
            if len(vec) != modell.dimension:
                stand["fehlgeschlagen"] += 1
                continue
            conn.execute("INSERT OR REPLACE INTO vektoren VALUES (?,?,?,?)",
                         (n.rel, keyfn(n), einbettung._pack(vec),
                          dt.datetime.now(dt.timezone.utc).timestamp()))
            conn.commit()
            stand["eingebettet"] += 1
    finally:
        conn.close()
    return stand


def durchgang(vault: Path, client=None, ollama_url: str | None = None,
              frist_s: float = FRIST_S, limit: int = MAX_NOTIZEN) -> dict:
    """Ein Nachbett-Durchgang ohne Sperre und Entprellen (die stehen in `lauf`)."""
    ollama_url = ollama_url or os.environ.get(OLLAMA_ENV) or config.OLLAMA_URL
    wo = None
    if client is None:
        if akku_zu_leer():
            return {"status": "uebersprungen", "grund": "Akku unter "
                    f"{AKKU_MIN_PROZENT} % und entladend"}
        if not ollama_erreichbar(ollama_url):
            return {"status": "uebersprungen", "grund": "Ollama nicht erreichbar"}
        client = OllamaClient(base_url=ollama_url)
        wo = geraet(ollama_url, client.embed_model)
        if wo == "cpu":
            client.embed_options = {"num_gpu": 0}
    frist = time.monotonic() + frist_s
    res: dict = {"status": "ok"}
    if wo and wo != "frei":
        res["geraet"] = wo
    try:
        res["gaertner"] = _gaertner_nachziehen(vault, client, frist, limit)
        if "uebersprungen" in res["gaertner"]:
            return res           # unfertiger Vault: nichts anfassen, das ist Sache eines vollen Laufs
        res["moc"] = _moc_nachziehen(vault, client)
        for modell in einbettung.MODELLE.values():
            if modell.eigener_index:
                r = _eigene_nachziehen(vault, modell, frist, limit,
                                       getattr(client, "embed_options", None))
                if r:
                    res[modell.name] = r
    except OllamaUnavailable as e:
        res.update(status="abgebrochen", grund=f"Ollama fiel aus: {e}")
    except sqlite3.OperationalError as e:
        res.update(status="abgebrochen", grund=f"Index gesperrt: {e}")
    return res


# -- Lauf mit Sperre, Entprellen, Marke ---------------------------------------

def _marke_alter(marke: Path) -> float | None:
    try:
        return time.time() - marke.stat().st_mtime
    except OSError:
        return None


def _entprellen(marke: Path, ruhe_s: float, max_warten_s: float,
                schlafen=time.sleep) -> None:
    start = time.monotonic()
    while time.monotonic() - start < max_warten_s:
        alter = _marke_alter(marke)
        if alter is None or alter >= ruhe_s:
            return
        schlafen(min(1.0, max(0.05, ruhe_s - alter)))


def lauf(vault: Path, sofort: bool = False, client=None, ollama_url: str | None = None,
         ruhe_s: float = RUHE_S, max_warten_s: float = MAX_WARTEN_S,
         frist_s: float = FRIST_S, limit: int = MAX_NOTIZEN) -> list[dict]:
    """Sperre, entprellen, Durchgaenge. Rueckgabe: Ergebnis je Durchgang ([] = nichts zu tun
    oder ein anderer Lauf besitzt die Sperre)."""
    vault = Path(vault)
    zustand = zustandsdir(vault)
    zustand.mkdir(parents=True, exist_ok=True)
    marke = marke_pfad(vault)
    ergebnisse: list[dict] = []
    for _ in range(RUNDEN):
        with open(zustand / "nachbetten.lock", "a+") as sperre:
            try:
                fcntl.flock(sperre, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return ergebnisse        # ein anderer Lauf sieht die Marke selbst
            pidfile = zustand / "nachbetten.pid"
            pidfile.write_text(str(os.getpid()))
            try:
                if not sofort and not marke.exists():
                    break
                if not sofort:
                    _entprellen(marke, ruhe_s, max_warten_s)
                with contextlib.suppress(FileNotFoundError):
                    marke.unlink()
                start = time.monotonic()
                res = durchgang(vault, client=client, ollama_url=ollama_url,
                                frist_s=frist_s, limit=limit)
                res["dauer_s"] = round(time.monotonic() - start, 2)
                ergebnisse.append(res)
                _log(vault, json.dumps(res, ensure_ascii=False))
                with contextlib.suppress(OSError):
                    (zustand / "nachbetten-last.json").write_text(
                        json.dumps({"zeit": dt.datetime.now().isoformat(timespec="seconds"),
                                    **res}, ensure_ascii=False, indent=1))
            finally:
                with contextlib.suppress(FileNotFoundError):
                    pidfile.unlink()
        # Pid-Datei ist weg, Sperre frei: eine Marke, die der Hook seit dem letzten
        # Blick setzte, bekommt einen weiteren Durchgang (Reihenfolge siehe Hook).
        sofort = False
        if not marke.exists():
            break
    return ergebnisse


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m braincli.nachbetten",
        description="Geaenderte Notizen nach einem Commit neu einbetten (Hook-Lauf).")
    ap.add_argument("--vault", default=str(Path.home() / "Knowledge"))
    ap.add_argument("--sofort", action="store_true",
                    help="ohne Marke und ohne Entprellen einen Durchgang machen")
    ap.add_argument("--ruhe", type=float,
                    default=float(os.environ.get(RUHE_ENV, RUHE_S)),
                    help="Sekunden Ruhe (Entprellen)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    with contextlib.suppress(OSError):
        os.setsid()      # vom Hook-Prozess loesen; scheitert harmlos als Gruppenfuehrer
    ergebnisse = lauf(Path(args.vault).expanduser(), sofort=args.sofort, ruhe_s=args.ruhe)
    if args.json or args.sofort:
        print(json.dumps(ergebnisse, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
