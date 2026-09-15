"""`brain pipeline`: the one command for the whole vault pipeline - the
gardener, then the dream, in that order - plus the dry-run that answers
"is the machine ready?" without starting anything.

Auftrag "startklar" (03.09.2026): before this, a human had to know by hand
that the gardener runs first and the dream second, and which switches
matter. This module holds that logic; `braincli/cli.py`'s `pipeline`
subcommand is the thin CLI wrapper around it, same pattern as
`gardener_wrap.py` for `brain gardener`.

The dry-run (`brain pipeline run --dry-run`) is deliberately the more
carefully built half: it reads live machine state (free memory, which
models are pulled/present on disk, whether a lock is already held, whether
the vault has uncommitted foreign changes) and answers plainly whether a
real run would even get going - but it NEVER starts a server, NEVER calls a
model, and NEVER touches the vault. The real run (no `--dry-run`) just
chains `gardener run --phase all` then `dream run`, both already-tested
commands; this module adds no new way to write to the vault.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from gardener import config as gcfg
from gardener.dream import config as dcfg
from gardener.grug_client import GRUG_MODEL_PATH
from gardener.ollama import OllamaClient
from gardener.runtime import dirty_paths

from . import gardener_wrap

# Gemessen 02.09.2026 (Auftrag "modellwege", 20-Paar-Stichprobe, linking ohne
# Denken, derselbe MLX-Weg wie heute): 5,78 s je Verknuepfungsurteil. Ein
# Volllauf urteilt grob ueber 300 bis 600 Paare (die fuenf schlauen Phasen
# linking/consolidate/maintain/synth/mine zusammen) - eine Spanne, keine
# Scheingenauigkeit, siehe `estimate_duration`. Extraktion, Einbetten und der
# Traum selbst sind hier NICHT gemessen und stehen deshalb nicht in der Zahl.
MEASURED_SECONDS_PER_JUDGMENT = 5.78
ESTIMATED_JUDGMENTS_LOW = 300
ESTIMATED_JUDGMENTS_HIGH = 600

# wb-belegungs eigene Untergrenze (MIN_FREE_MIB im Quelltext von
# `wb-belegung`) - derselbe Boden, den der echte Serverstart ohnehin
# durchsetzt. Dieser Preflight rechnet bewusst NICHT die volle Buchung von
# `wb-belegung darf` nach (Gewicht + KV-Cache + Zuschlag je Kontext/
# Parallelitaet) - das waere eine zweite, driftende Kopie derselben Formel.
# Er ist ein grober Vorabcheck; die echte, massgebliche Pruefung macht
# `wb-mlx-server ensure` selbst beim wirklichen Start.
MIN_FREE_MIB = 20480


@dataclass
class CheckResult:
    name: str
    ok: bool
    detail: str
    blocking: bool = True   # False: eine Warnung, kein Start-Hindernis


@dataclass
class Preflight:
    checks: list[CheckResult] = field(default_factory=list)
    estimated_minutes: tuple[float, float] = (0.0, 0.0)

    @property
    def ready(self) -> bool:
        return all(c.ok for c in self.checks if c.blocking)


def _lock_status(path: Path) -> dict:
    """Read-only: haelt gerade jemand diese Sperre? Nimmt sie NIE selbst -
    dieselbe Logik wie `gardener_wrap._lock_status`, hier fuer eine beliebige
    Sperr-Datei (Gaertner UND Traum haben je ihre eigene)."""
    if not path.exists():
        return {"held": False, "path": str(path)}
    try:
        pid_str, *_ = path.read_text().split()
        pid = int(pid_str)
        os.kill(pid, 0)
        held = True
    except ProcessLookupError:
        held = False   # Halter tot - eine stehen gebliebene Sperre, keine aktive
    except (OSError, ValueError, IndexError):
        held = None     # Datei unlesbar - unbekannt, nicht "frei"
    return {"held": bool(held) if held is not None else None, "path": str(path)}


def check_memory(check_resources_bin: str = "check-resources") -> CheckResult:
    exe = shutil.which(check_resources_bin)
    if exe is None:
        return CheckResult("Speicher", False,
                           f"'{check_resources_bin}' nicht gefunden - kann den "
                           "freien Speicher nicht pruefen.")
    try:
        proc = subprocess.run([exe], capture_output=True, text=True, timeout=30)
        data = json.loads(proc.stdout)
        free_mib = data["vram"]["free_mib"]
    except (OSError, subprocess.SubprocessError, ValueError, KeyError) as e:
        return CheckResult("Speicher", False,
                           f"'{check_resources_bin}' lieferte keinen brauchbaren "
                           f"Wert: {e}")
    if free_mib < MIN_FREE_MIB:
        return CheckResult(
            "Speicher", False,
            f"{free_mib} MiB frei, gebraucht werden mindestens {MIN_FREE_MIB} "
            "MiB fuer den MLX-Server (grober Vorabcheck, keine echte Buchung - "
            "siehe MIN_FREE_MIB im Quelltext).")
    return CheckResult("Speicher", True, f"{free_mib} MiB frei (Boden {MIN_FREE_MIB} MiB).")


def check_mlx_model_present() -> CheckResult:
    p = Path(GRUG_MODEL_PATH)
    if not (p / "config.json").exists():
        return CheckResult(
            "MLX-Modell", False,
            f"{p} liegt nicht (vollstaendig) vor - kein config.json gefunden. "
            "Die fuenf schlauen Gaertner-Phasen und `brain contradict` "
            "brauchen dieses Modell.")
    return CheckResult("MLX-Modell", True, f"{p} liegt lokal vor.")


def check_ollama_models(client=None) -> CheckResult:
    client = client or OllamaClient()
    missing = [name for name in (gcfg.EMBED_MODEL, gcfg.SMALL_MODEL)
              if not client.has_model(name)]
    if missing:
        return CheckResult(
            "Ollama-Modelle", False,
            f"nicht lokal vorhanden: {', '.join(missing)} (`ollama pull "
            f"{missing[0]}`). Gebraucht fuer Einbettungen und Sidecar-/"
            "Ingest-Zusammenfassungen.")
    return CheckResult("Ollama-Modelle", True,
                       f"{gcfg.EMBED_MODEL}, {gcfg.SMALL_MODEL} lokal vorhanden.")


def check_locks() -> CheckResult:
    gardener_lock = _lock_status(gcfg.STATE_DIR / "gardener.lock")
    dream_lock = _lock_status(dcfg.DREAM_LOCK)
    held = [name for name, status in
            (("Gaertner", gardener_lock), ("Traum", dream_lock))
            if status["held"]]
    if held:
        return CheckResult(
            "Sperre", False,
            f"laeuft schon: {', '.join(held)} - siehe `brain gardener status`.")
    return CheckResult("Sperre", True, "keine der beiden Sperren ist gehalten.")


def check_vault_clean(vault: Path) -> CheckResult:
    dirty = dirty_paths(vault)
    if dirty:
        # Kein Start-Hindernis (der Gaertner laesst fremde Dateien ohnehin in
        # Ruhe, siehe VaultWriter) - aber der Mensch soll es vorher sehen,
        # nicht erst im Bericht danach.
        beispiele = ", ".join(dirty[:5]) + (" ..." if len(dirty) > 5 else "")
        return CheckResult(
            "Vault sauber", False,
            f"{len(dirty)} unversionierte Aenderung(en) im Vault ({beispiele}) - "
            "der Lauf laesst sie in Ruhe, meldet sie aber im Bericht als fremd.",
            blocking=False)
    return CheckResult("Vault sauber", True, "keine uncommitteten Aenderungen.")


def estimate_duration() -> tuple[float, float]:
    low_s = ESTIMATED_JUDGMENTS_LOW * MEASURED_SECONDS_PER_JUDGMENT
    high_s = ESTIMATED_JUDGMENTS_HIGH * MEASURED_SECONDS_PER_JUDGMENT
    return (low_s / 60, high_s / 60)


def preflight(vault: Path, *, ollama_client=None,
             check_resources_bin: str = "check-resources") -> Preflight:
    """Alle Pruefungen, nichts angefasst - kein Serverstart, kein Modellaufruf,
    kein Schreibzugriff auf den Vault."""
    p = Preflight()
    p.checks.append(check_memory(check_resources_bin))
    p.checks.append(check_mlx_model_present())
    p.checks.append(check_ollama_models(ollama_client))
    p.checks.append(check_locks())
    p.checks.append(check_vault_clean(vault))
    p.estimated_minutes = estimate_duration()
    return p


def format_preflight_report(p: Preflight) -> str:
    lines = ["brain pipeline run --dry-run", ""]
    for c in p.checks:
        tag = "OK" if c.ok else ("WARNUNG" if not c.blocking else "NICHT BEREIT")
        lines.append(f"[{tag}] {c.name}: {c.detail}")
    low, high = p.estimated_minutes
    lines += ["",
             f"Geschaetzte Dauer (nur der urteilslastige Teil des "
             f"Gaertnerlaufs - Verknuepfung, Konsolidierung, Pflege, "
             f"Synthese, Mining zusammen; ohne Extraktion/Einbetten/Traum, "
             f"die hier nicht gemessen sind): grob {low:.0f} bis {high:.0f} "
             "Minuten."]
    lines += ["",
             "BEREIT" if p.ready else "NICHT BEREIT - siehe die Zeilen oben."]
    return "\n".join(lines)


def run(vault: Path, dry_run: bool, verbose: bool = False,
       budget_minutes: float | None = None) -> int:
    """`brain pipeline run`: Trockenlauf prueft nur (siehe `preflight`), sonst
    die echte Kette - erst `gardener run --phase all`, dann `dream run`. Der
    Traum startet nur, wenn der Gaertner sauber durchgelaufen ist (Exit 0);
    ein `partial`-Lauf (Exit 0, aber Modell/Ollama unterwegs ausgefallen)
    zaehlt hier als "gut genug zum Weitermachen" - nur ein echter Fehler-Exit
    haelt die Kette an.

    `budget_minutes` reicht Auftrag "zeitgrenze" Punkt 6s Gaertner-Schalter
    durch - der Trockenlauf-Schaetzwert oben (29-58 Minuten, gegen ein
    45-Minuten-Budget) ist genau der Grund, warum die Kette hier verstellbar
    sein muss, nicht nur `gardener run` selbst."""
    if dry_run:
        result = preflight(vault)
        print(format_preflight_report(result))
        return 0 if result.ready else 1

    rc = gardener_wrap.run(vault, phase="all", dry_run=False, verbose=verbose,
                           budget_minutes=budget_minutes)
    if rc != 0:
        print(f"gardener run beendet mit Exit {rc} - der Traum-Lauf startet "
              "deshalb nicht. `brain gardener status` fuer Details.")
        return rc

    from gardener.dream.cli import main as dream_main
    argv = ["run", "--vault", str(vault)]
    if verbose:
        argv.append("--verbose")
    return dream_main(argv)
