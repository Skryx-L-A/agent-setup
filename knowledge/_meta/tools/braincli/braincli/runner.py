"""`brain runner`: holt einen Pipeline-Job beim Brain-Dienst ab und fuehrt ihn aus.

Die App reiht Jobs im Dienst ein (`POST /pipeline/jobs`); ausgefuehrt werden sie
nie im Dienst, sondern hier, im eigenen Vault-Klon dieser Maschine (Mac oder
peer), mit den Modellen dieser Maschine (Architektur 3.2, BRAIN5-PLAN
Entscheidung 15: Pull-Runner). Ablauf:

0. Der Vault-Klon wird mit `--klon` ausdruecklich genannt (nie stillschweigend
   `~/Knowledge`).
1. Vault-Sperre nehmen (`.git/brain-runner.lock`, flock). Haelt sie ein
   anderer Laeufer, wird KEIN Job abgeholt.
2. `POST /runner/jobs/holen` mit dem Laeufer-Token. 204 = nichts zu tun.
3. `brain --vault <vault> run --profil ... --json` starten, jede JSON-Zeile
   gesammelt (hoechstens `--takt` Sekunden alt) an `/runner/jobs/<id>/zeilen`
   senden, mindestens jede Minute ein Lebenszeichen.
4. Ende melden (`fertig` bei Exit 0, sonst `fehler` mit den letzten
   stderr-Zeilen), danach `brain doctor --json` und `brain run status --json`
   als Kurzwerte an `/runner/zustand`.

Kein Dauerprozess (der Nutzer: keine Dauerprozesse auf Vorrat): `--einmal` holt
hoechstens einen Job und endet, `--bis-leer` arbeitet, bis nichts mehr wartet.
`--nur-zustand` holt keinen Job und meldet nur Schritt 4 (Ampel der App auf
aktuellem `brain doctor`-Stand, ohne dafuer einen Pipeline-Lauf zu brauchen).
Der Token kommt aus `--token-datei` oder `BRAIN_RUNNER_TOKEN`, nie von der
Kommandozeile (waere in `ps` sichtbar). Nie Push, ausser mit `--push`
(dann vorher `fetch` + `merge --ff-only`, nachher `push`, nie force).
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import queue
import re
import shlex
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path

PROFILE = ("all", "gardener", "lehren", "dream")
KLASSEN = ("transkript", "worker", "doku", "memory")
STUFE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
PROJEKT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
HTTP_TIMEOUT = 30.0
LEBENSZEICHEN = 60.0
STDERR_ZEILEN = 40
MAX_PUFFER = 5000


class DienstFehler(Exception):
    def __init__(self, status: int | None, text: str) -> None:
        super().__init__(f"HTTP {status}: {text}" if status else text)
        self.status = status


class Dienst:
    """Duenner JSON-Client fuer die Laeufer-Endpunkte (nur Standardbibliothek)."""

    def __init__(self, base_url: str, token: str) -> None:
        self.base = base_url.rstrip("/")
        self._token = token

    def post(self, path: str, body: dict, *, versuche: int = 3) -> tuple[int, dict | None]:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        last: Exception | None = None
        for attempt in range(versuche):
            req = urllib.request.Request(
                self.base + path, data=data, method="POST",
                headers={"Authorization": f"Bearer {self._token}",
                         "Content-Type": "application/json", "Accept": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                    raw = resp.read()
                    return resp.status, (json.loads(raw) if raw else None)
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", "replace")[:300]
                if exc.code < 500:
                    raise DienstFehler(exc.code, detail) from None
                last = DienstFehler(exc.code, detail)
            except (urllib.error.URLError, OSError, TimeoutError) as exc:
                last = DienstFehler(None, f"Dienst nicht erreichbar: {exc}")
            time.sleep(min(8.0, 0.5 * 2 ** attempt))
        raise last or DienstFehler(None, "unbekannter Fehler")


def _token(args) -> str:
    if args.token_datei:
        path = Path(args.token_datei).expanduser()
        mode = path.stat().st_mode & 0o777
        if mode & 0o077:
            print(f"brain runner: Warnung: {path} ist fuer andere lesbar ({oct(mode)}), "
                  "besser chmod 600", file=sys.stderr)
        return path.read_text(encoding="utf-8").strip()
    return os.environ.get("BRAIN_RUNNER_TOKEN", "").strip()


def argv_fuer(job: dict, brain: list[str], vault: Path) -> list[str]:
    """Job-Spezifikation -> `brain run`-Argumente. Jeder Wert wird hier noch
    einmal geprueft (der Dienst prueft auch): nichts darf eine Option werden."""
    profil = job.get("profil") or "all"
    if profil not in PROFILE:
        raise ValueError(f"unbekanntes Profil {profil!r}")
    argv = [*brain, "--vault", str(vault), "run", "--profil", profil, "--json"]
    stufen = job.get("stufen") or []
    if stufen:
        if not all(isinstance(s, str) and STUFE_RE.match(s) for s in stufen):
            raise ValueError("ungueltige Stufe")
        argv += ["--stufen", ",".join(stufen)]
    klassen = job.get("klassen") or []
    if klassen:
        if not all(k in KLASSEN for k in klassen):
            raise ValueError("ungueltige Quellklasse")
        argv += ["--klassen", ",".join(klassen)]
    projekt = job.get("projekt")
    if projekt:
        if not isinstance(projekt, str) or not PROJEKT_RE.match(projekt):
            raise ValueError("ungueltiges Projekt")
        argv += ["--projekt", projekt]
    limit = job.get("limit")
    if limit is not None:
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise ValueError("ungueltiges Limit")
        argv += ["--limit", str(limit)]
    if job.get("dry_run", True) is not False:
        argv.append("--dry-run")
    return argv


class VaultSperre:
    """flock auf eine Datei im Vault-Klon: ein Laeufer je Vault und Maschine."""

    def __init__(self, vault: Path) -> None:
        git = vault / ".git"
        self.path = (git if git.is_dir() else vault) / "brain-runner.lock"
        self._fh = None

    def __enter__(self) -> "VaultSperre":
        self._fh = open(self.path, "a+")
        try:
            fcntl.flock(self._fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._fh.close()
            self._fh = None
            raise
        self._fh.seek(0)
        self._fh.truncate()
        self._fh.write(f"{os.getpid()}\n")
        self._fh.flush()
        return self

    def __exit__(self, *exc) -> None:
        if self._fh is not None:
            fcntl.flock(self._fh, fcntl.LOCK_UN)
            self._fh.close()


def _lesen(stream, ziel: queue.Queue) -> None:
    for line in iter(stream.readline, ""):
        ziel.put(line)
    ziel.put(None)


def _stderr_lesen(stream, puffer: deque) -> None:
    for line in iter(stream.readline, ""):
        puffer.append(line.rstrip("\n"))
        sys.stderr.write(line)


def _zeile(text: str) -> dict:
    text = text.rstrip("\n")
    try:
        data = json.loads(text)
        if isinstance(data, dict) and isinstance(data.get("ereignis"), str):
            return data
    except ValueError:
        pass
    return {"ereignis": "text", "text": text[:2000]}


def _git(vault: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(vault), *args], capture_output=True, text=True,
                          timeout=300)


def job_ausfuehren(dienst: Dienst, job: dict, *, vault: Path, brain: list[str],
                   takt: float = 1.0, push: bool = False) -> str:
    """Einen abgeholten Job ausfuehren und melden. Liefert den gemeldeten Status."""
    job_id = job["id"]
    try:
        argv = argv_fuer(job, brain, vault)
    except ValueError as exc:
        dienst.post(f"/runner/jobs/{job_id}/ende", {"status": "fehler", "fehler": f"Job abgelehnt: {exc}"})
        return "fehler"

    if push and not job.get("dry_run", True):
        fetch = _git(vault, "fetch", "--quiet")
        merge = _git(vault, "merge", "--ff-only", "--quiet", "@{u}") if fetch.returncode == 0 else fetch
        if merge.returncode != 0:
            dienst.post(f"/runner/jobs/{job_id}/ende", {
                "status": "fehler",
                "fehler": "Vault-Klon laesst sich nicht vorspulen (fetch/merge --ff-only): "
                          + (merge.stderr or merge.stdout).strip()[:500]})
            return "fehler"

    env = dict(os.environ, PYTHONUNBUFFERED="1", BRAIN_RUN_AUSGELOEST_VON=str(job.get("ausgeloest_von", "")))
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            bufsize=1, env=env, cwd=str(vault))
    zeilen: queue.Queue = queue.Queue()
    fehlerzeilen: deque = deque(maxlen=STDERR_ZEILEN)
    threads = [threading.Thread(target=_lesen, args=(proc.stdout, zeilen), daemon=True),
               threading.Thread(target=_stderr_lesen, args=(proc.stderr, fehlerzeilen), daemon=True)]
    for t in threads:
        t.start()

    abgebrochen = {"grund": None}

    def stop(signum, _frame):
        abgebrochen["grund"] = f"Signal {signum}"
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)  # `brain run` bricht sicher ab und setzt spaeter fort

    alte = {}
    try:
        alte = {s: signal.signal(s, stop) for s in (signal.SIGINT, signal.SIGTERM)}
    except ValueError:
        pass  # nicht im Hauptfaden (Tests): Signale bleiben beim Aufrufer
    puffer: list[dict] = []
    abschluss: dict | None = None
    gesendet = time.monotonic()
    offen = True
    try:
        while offen:
            try:
                item = zeilen.get(timeout=max(0.05, takt))
            except queue.Empty:
                item = ""
            if item is None:
                offen = False
            elif item:
                zeile = _zeile(item)
                if zeile.get("ereignis") == "abschluss":
                    abschluss = zeile
                puffer.append(zeile)
                del puffer[:-MAX_PUFFER]
            faellig = time.monotonic() - gesendet >= takt
            if (puffer and (faellig or not offen or len(puffer) >= 50)) or \
                    time.monotonic() - gesendet >= LEBENSZEICHEN:
                try:
                    dienst.post(f"/runner/jobs/{job_id}/zeilen", {"zeilen": puffer[:1000]})
                    del puffer[:1000]
                    gesendet = time.monotonic()
                except DienstFehler as exc:
                    if exc.status == 409:
                        # Job gehoert nicht mehr uns (verwaist erklaert): sauber aufhoeren.
                        abgebrochen["grund"] = "Der Dienst hat den Job entzogen."
                        if proc.poll() is None:
                            proc.send_signal(signal.SIGTERM)
                        puffer.clear()
                    else:
                        print(f"brain runner: {exc} (Zeilen bleiben gepuffert)", file=sys.stderr)
        rc = proc.wait()
        for t in threads:
            t.join(timeout=5)
        while puffer:
            dienst.post(f"/runner/jobs/{job_id}/zeilen", {"zeilen": puffer[:1000]})
            del puffer[:1000]
    except DienstFehler as exc:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=120)
        if exc.status == 409:
            return "fehler"
        raise
    finally:
        for s, h in alte.items():
            signal.signal(s, h)

    fehler = None
    if rc == 0 and abgebrochen["grund"] is None and push and not job.get("dry_run", True):
        pushed = _git(vault, "push", "--quiet")
        if pushed.returncode != 0:
            fehler = "Lauf ok, Push abgelehnt (lokaler Commit bleibt): " + \
                (pushed.stderr or pushed.stdout).strip()[:500]
    if rc != 0 or abgebrochen["grund"]:
        tail = "\n".join(fehlerzeilen)
        fehler = (f"{abgebrochen['grund'] + ' ' if abgebrochen['grund'] else ''}"
                  f"brain run endete mit Exit {rc}." + (f"\n{tail}" if tail else ""))[-4000:]
    status = "fertig" if rc == 0 and not fehler else "fehler"
    try:
        dienst.post(f"/runner/jobs/{job_id}/ende", {"status": status, "exit_code": rc,
                                                   "abschluss": abschluss, "fehler": fehler})
    except DienstFehler as exc:
        if exc.status != 409:
            raise
    return status


def _json_von(argv: list[str], vault: Path, timeout: float = 180.0) -> dict | None:
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=str(vault))
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def zustand_melden(dienst: Dienst, *, vault: Path, brain: list[str], maschine: str,
                   doctor: bool = True) -> None:
    body: dict = {"maschine": maschine}
    status = _json_von([*brain, "--vault", str(vault), "run", "status", "--json"], vault)
    if status is not None:
        body["brain_run"] = status
    if doctor:
        doc = _json_von([*brain, "--vault", str(vault), "doctor", "--json"], vault)
        if doc is not None:
            body["doctor"] = doc
    try:
        dienst.post("/runner/zustand", body)
    except DienstFehler as exc:
        print(f"brain runner: Zustand nicht gemeldet: {exc}", file=sys.stderr)


def run(args, vault: Path) -> int:
    if not (args.einmal or args.bis_leer or args.nur_zustand):
        print("brain runner: nur mit --einmal, --bis-leer oder --nur-zustand (kein Dauerprozess)",
              file=sys.stderr)
        return 2
    dienst_url = args.dienst or os.environ.get("BRAIN_DIENST_URL", "")
    if not dienst_url:
        print("brain runner: --dienst oder BRAIN_DIENST_URL fehlt", file=sys.stderr)
        return 2
    try:
        token = _token(args)
    except OSError as exc:
        print(f"brain runner: Token-Datei nicht lesbar: {exc}", file=sys.stderr)
        return 2
    if not token:
        print("brain runner: kein Token (--token-datei oder BRAIN_RUNNER_TOKEN)", file=sys.stderr)
        return 2
    brain = shlex.split(args.brain_befehl or os.environ.get("BRAIN_RUNNER_BRAIN", "")) or \
        [sys.executable, "-m", "braincli.cli"]
    maschine = args.maschine or socket.gethostname().split(".")[0]
    dienst = Dienst(dienst_url, token)
    if args.nur_zustand:
        zustand_melden(dienst, vault=vault, brain=brain, maschine=maschine, doctor=True)
        return 0

    try:
        sperre = VaultSperre(vault).__enter__()
    except BlockingIOError:
        print("brain runner: ein anderer Laeufer arbeitet gerade in diesem Vault", file=sys.stderr)
        return 3
    erledigt = 0
    rc = 0
    try:
        while True:
            try:
                status, job = dienst.post("/runner/jobs/holen",
                                          {"spaces": args.space or None, "maschine": maschine})
            except DienstFehler as exc:
                print(f"brain runner: Job holen fehlgeschlagen: {exc}", file=sys.stderr)
                return 1
            if status == 204 or not job:
                if erledigt == 0:
                    print("brain runner: kein Job wartet")
                break
            print(f"brain runner: Job {job['id']} ({job.get('profil')}, "
                  f"{'Trockenlauf' if job.get('dry_run', True) else 'schreibend'}, "
                  f"von {job.get('ausgeloest_von')})")
            try:
                ergebnis = job_ausfuehren(dienst, job, vault=vault, brain=brain, takt=args.takt,
                                          push=args.push)
            except DienstFehler as exc:
                print(f"brain runner: Dienst nicht erreichbar: {exc}", file=sys.stderr)
                return 1
            erledigt += 1
            print(f"brain runner: Job {job['id']} {ergebnis}")
            if ergebnis != "fertig":
                rc = 1
            zustand_melden(dienst, vault=vault, brain=brain, maschine=maschine,
                           doctor=not args.ohne_doctor)
            if args.einmal:
                break
    finally:
        sperre.__exit__(None, None, None)
    return rc


def add_parser(sub) -> None:
    p = sub.add_parser("runner", help="einen Pipeline-Job beim Brain-Dienst abholen und ausfuehren",
                       description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--einmal", action="store_true", help="hoechstens einen Job, dann Ende")
    mode.add_argument("--bis-leer", action="store_true", help="Jobs abarbeiten, bis keiner mehr wartet")
    mode.add_argument("--nur-zustand", action="store_true",
                      help="keinen Job holen, nur `brain doctor`/`brain run status` an den Dienst melden")
    p.add_argument("--klon", required=True,
                   help="eigener Vault-Klon dieses Laeufers (Pflicht; bewusst nicht --vault)")
    p.add_argument("--dienst", default=None, help="Basis-URL des Brain-Dienstes (oder BRAIN_DIENST_URL)")
    p.add_argument("--token-datei", default=None,
                   help="Datei mit dem Laeufer-Token (0600); sonst BRAIN_RUNNER_TOKEN")
    p.add_argument("--space", action="append", default=None,
                   help="Space-ID, die dieser Vault-Klon bedient (mehrfach; Vorgabe: jeder)")
    p.add_argument("--maschine", default=None, help="Name in der Zustandsanzeige (Vorgabe: Hostname)")
    p.add_argument("--brain-befehl", default=None,
                   help="Befehl fuer `brain` (Vorgabe: dieses Python, -m braincli.cli)")
    p.add_argument("--takt", type=float, default=1.0, help="Zeilen hoechstens so alt senden (s)")
    p.add_argument("--ohne-doctor", action="store_true", help="nach dem Job kein `brain doctor`")
    p.add_argument("--push", action="store_true",
                   help="vorher fetch + merge --ff-only, nach schreibendem Lauf push (nie force)")
    p.set_defaults(func=lambda args: run(args, Path(args.klon).expanduser().resolve()))
