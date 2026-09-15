"""Gardener CLI. Runs manually only (no launchd timer).

A full run is: ingest -> sidecar -> linking -> consolidation -> maintenance ->
synth -> mining -> lint. Everything is local (Ollama); git snapshot before and
after; never pushes.

Usage:
    uv run gardener --dry-run                 # report only: zero writes anywhere
    uv run gardener --once                    # one real run (all phases)
    uv run gardener --phase lint              # single phase
    uv run gardener --once --audit            # force the health report
"""
from __future__ import annotations

import argparse
import datetime as dt
import logging
import sys
from pathlib import Path

from . import (audit as audit_mod, config, consolidate, ingest as ingest_mod,
               lint as lint_mod, linking, maintain, mine as mine_mod,
               mlx_server, owner as owner_mod, sidecar as sidecar_mod,
               synth as synth_mod, topics)
from .contradict import ContradictionStore
from .grug_client import GrugJudgeClient
from .heat import load_heat
from .ollama import OllamaClient, OllamaError, OllamaUnavailable
from .queue import ReviewQueue
from .runtime import (Deadline, Lock, LockHeldError, dirty_paths,
                      foreign_changes, git_commit, record_attempt,
                      setup_logging, write_last_run)
from .store import Store
from .vault import VaultWriter, load_notes

log = logging.getLogger("gardener")

# which phases need embeddings
EMBED_PHASES = {"embed", "linking", "consolidate", "maintain", "synth", "all"}
# which phases judge via `smart` (GrugJudgeClient, Qwen3.8-27B over the MLX
# server `mlx_server.ensure()` provisions) - the gardener must have that
# server up before ANY of these run, see `run()`.
SMART_PHASES = {"linking", "consolidate", "maintain", "synth", "mine"}
# `--phase embed` baut NUR den Einbettungs-Index neu: kein Verlinken, kein
# Zusammenfuehren, keine Themenseiten, kein Bericht, kein git-Commit, keine
# Zeile in einer Notiz. Der Anlass ist der Indexverlust vom 2026-08-04 - danach
# muss der Index wiederherstellbar sein, ohne dass ein voller Lauf gleichzeitig
# 38 Verlinkungen und 23 Themenseiten in den Vault schreibt. Wer den Index nur
# reparieren will, soll ihn nur reparieren koennen.
EMBED_ONLY_PHASE = "embed"


def wants(phase: str, name: str) -> bool:
    return phase in ("all", name)


# Lesbare Phasennamen fuer den "ANGEHALTEN"-Abschnitt - phase-Schluessel wie
# von Deadline.expired() vermerkt, siehe runtime.py.
DEADLINE_PHASE_LABELS = {
    "embed": "Einbetten (embed)",
    "linking": "Verlinken (linking)",
    "consolidate": "Zusammenfuehren (consolidate)",
    "sidecar": "Sidecars (sidecar)",
    "mine": "Transcript-Mining (mine)",
    "contradict": "Widerspruchspruefung (contradict)",
}
# Phasen, deren Ergebnis von einer verkuerzten embed-Phase mitbetroffen ist -
# sie arbeiten auf `embedded` (nur was tatsaechlich einen Vektor bekam), nicht
# auf dem vollen Notizbestand. Auftrag "zeitgrenze" (04.09.2026), Punkt 5: das
# ist die gefaehrlichste Variante, weil diese Phasen selbst nicht anhalten -
# sie sehen einfach weniger Notizen und laufen scheinbar vollstaendig durch.
EMBED_DEPENDENT_PHASES = "linking, consolidate, Themen-Hub-Vorschlaege und Themen-Synthese (synth)"


def build_report(link_res, cons_res, maint_res, topic_res, ingest_res, mine_res,
                 findings, audit_rel, phase: str, dry_run: bool,
                 writer: VaultWriter, ollama_failures: int = 0,
                 sidecar_res=None, synth_res=None, owner_res=None,
                 ollama_dead: str | None = None,
                 ollama_skipped: list[str] | None = None,
                 mlx_start_failed: str | None = None,
                 mlx_skipped: list[str] | None = None,
                 deadline_stops: list[dict] | None = None,
                 budget_override_minutes: float | None = None,
                 mlx_dry_run_status: str | None = None) -> str:
    today = dt.date.today().isoformat()
    lines = [
        "---", f"title: gardener-report-{today}", "type: report", "---", "",
        f"# Gardener-Report {today}" + (" (DRY-RUN)" if dry_run else "")
        + (" (PARTIAL - Ollama nicht erreichbar)" if ollama_dead else "")
        + (" (PARTIAL - MLX-Server nicht verfuegbar)" if mlx_start_failed else "")
        + (" (ANGEHALTEN - Zeitbudget erschoepft)" if deadline_stops else ""), "",
        f"Phase: {phase}" + (
            f" | Zeitbudget: {budget_override_minutes:g} Minuten "
            f"(Vorgabe: {config.RUN_BUDGET_SECONDS / 60:g} Minuten, per "
            "--budget-minutes gesetzt)" if budget_override_minutes is not None
            else ""), "",
        f"Neue Links: {len(link_res.added)} | abgelehnt: {len(link_res.rejected)} | "
        f"Merges: {len(cons_res.merged)} | Review-Queue: {len(cons_res.queued)} | "
        f"Orphans in Queue: {len(maint_res.orphans_queued)} | "
        f"Lint-Findings: {len(findings)}", "",
        "## Neue Links",
    ]
    lines += [f"- {a} <-> {b} ({t})" for a, b, t in link_res.added] or ["- keine"]
    lines += ["", "## Abgelehnt (Blockliste)"]
    lines += [f"- {a} / {b}: {r}" for a, b, r in link_res.rejected[:30]] or ["- keine"]
    lines += ["", "## Merges"]
    lines += [f"- {b} -> {a}" for a, b in cons_res.merged] or ["- keine"]
    lines += ["", "## Review-Queue-Eintraege"]
    lines += [f"- {a} vs {b}: {r}" for a, b, r in cons_res.queued] or ["- keine"]
    lines += ["", "## Drop-Ingest"]
    lines += [f"- {src} -> {dst}" for src, dst in ingest_res.ingested] or ["- keine"]
    lines += ["", "## Asset-Stubs angereichert"]
    lines += [f"- {rel}" for rel in ingest_res.enriched] or ["- keine"]
    if dry_run:
        # Auftrag "zeitgrenze" dritte Runde (05.09.2026), Punkt 2: ein
        # Trockenlauf, der stumm nichts tut, ist von einem ohne Arbeit nicht
        # zu unterscheiden - und genau diese Verwechslung hat verdeckt, dass
        # ingest und sidecar bis hierher weiter Modelle riefen. Die Zeile
        # steht deshalb auch bei 0 da: dann heisst sie "geprueft, nichts
        # offen", statt gar nichts zu heissen.
        lines.append(
            f"- Trockenlauf: {len(ingest_res.would_describe)} Datei(en) im "
            "Eingang bzw. Stub(s) ohne Beschreibung - die wuerde ein echter "
            "Lauf hier zusaetzlich beschreiben (je ein Modellaufruf)")
    if sidecar_res is not None:
        lines += ["", "## Sidecars",
                  f"- neu erzeugt: {len(sidecar_res.generated)}",
                  f"- aktualisiert (Hash geaendert): {len(sidecar_res.updated)}",
                  f"- Legacy-Stubs ergaenzt: {len(sidecar_res.legacy_enriched)}",
                  f"- ohne lokale Beschreibung (Metadaten-only): "
                  f"{len(sidecar_res.metadata_only)}",
                  f"- als extern markiert (> {config.SIDECAR_EXTERNAL_MB} MB): "
                  f"{len(sidecar_res.external)}",
                  f"- human-edited uebersprungen: "
                  f"{len(sidecar_res.skipped_human_edited)}"]
        if dry_run:
            lines.append(
                f"- Trockenlauf: {len(sidecar_res.would_describe)} Datei(en) "
                "ohne aktuelle Beschreibung - die wuerde ein echter Lauf hier "
                "zusaetzlich beschreiben (je ein Modellaufruf)")
    lines += ["", "## Topic-Hubs"]
    lines += [f"- aktualisiert: {rel}" for rel in topic_res.mocs_updated] or ["- keine"]
    lines += [f"- Vorschlag `30-topics/{name}/`: {len(rels)} Notes"
              for name, rels in topic_res.hubs_suggested]
    if synth_res is not None:
        lines += ["", "## Themen-Synthese (30-topics, class: derived)",
                  f"- geschrieben: {', '.join(synth_res.written) or 'keine'}",
                  f"- unveraendert (Quellen gleich): {len(synth_res.unchanged)}",
                  f"- zu klein fuer eine Seite: {len(synth_res.skipped_small)}",
                  f"- handgeaendert, nicht ueberschrieben: "
                  f"{', '.join(synth_res.skipped_hand_edited) or 'keine'}",
                  f"- handgeschrieben (nicht `class: derived`), nicht angefasst: "
                  f"{', '.join(synth_res.skipped_hand_written) or 'keine'}",
                  f"- Zeilen verworfen (ohne Quelle): {synth_res.lines_dropped_no_link}",
                  f"- Zeilen verworfen (toter Wikilink): {synth_res.lines_dropped_dead_link}",
                  f"- Zeilen verworfen (Projektstand, gehoert in die STATUS-Notiz): "
                  f"{synth_res.lines_dropped_status}"]
    if owner_res is not None:
        lines += ["", "## Projekt-Eigner (`owner:` im MOC)"]
        lines += [f"- {rel}: {person}" for rel, person in owner_res.stamped]
        lines += [f"- {rel}: leer ({reason})" for rel, reason in owner_res.empty]
        lines += [f"- {rel}: uebersprungen ({reason})"
                  for rel, reason in owner_res.skipped]
        lines += [f"- unveraendert (Feld war schon da): {len(owner_res.kept)}"]
    lines += ["", "## Transcript-Mining"]
    lines += [f"- {rel} (UNVERIFIED)" for rel in mine_res.candidates] or ["- keine"]
    hot_line = "aktualisiert" if maint_res.hot_updated else "unveraendert"
    if maint_res.hot_updated and maint_res.hot_degraded:
        hot_line += " (ohne lokales Modell - Ollama nicht erreichbar)"
    lines += ["", "## Pflege",
              f"- MOCs aktualisiert: {', '.join(maint_res.mocs_updated) or 'keine'}",
              f"- DECISIONS.md: {', '.join(maint_res.decisions_written) or 'keine'}",
              f"- OPEN-QUESTIONS.md: {maint_res.open_questions} offene Fragen",
              f"- HOT.md: {hot_line}",
              f"- Vergessene Schaetze: {', '.join(maint_res.resurfaced) or 'keine'}",
              f"- Recency-Marker ergaenzt: {len(maint_res.markers_added)}",
              f"- Orphans -> Review-Queue: {len(maint_res.orphans_queued)}",
              f"- Lange ungelesen -> Review-Queue: {len(maint_res.cold_queued)}"]
    if writer.conflicts:
        lines += ["", "## Nicht ueberschrieben (waehrend des Laufs geaendert)"]
        lines += [f"- {rel}" for rel in sorted(set(writer.conflicts))]
    if ollama_failures:
        lines += ["", "## Ollama-Aussetzer (toleriert, naechster Lauf holt es nach)",
                  f"- {ollama_failures} Aufruf(e) fehlgeschlagen/timeout"]
    if ollama_dead:
        # Point 1, 2026-09-02: an Ollama outage used to throw the WHOLE run
        # away (nothing after the failing phase ever ran). Now only the
        # phases that actually need a model are dropped - named here, so a
        # half-finished run cannot pass for a full one at a glance.
        lines += ["", "## Ollama nicht erreichbar - Phasen uebersprungen",
                  f"- Grund: {ollama_dead}"]
        if ollama_skipped:
            lines.append("- uebersprungen (brauchen ein lokales Modell): "
                         + ", ".join(ollama_skipped))
        else:
            lines.append("- keine der gelaufenen Phasen brauchte dafuer ein Modell")
    if mlx_start_failed:
        # Bewusst ein EIGENER Abschnitt, nicht in "Ollama nicht erreichbar"
        # verschmolzen: das hier ist "konnte nicht starten" (Provisionierung
        # ist gescheitert, BEVOR eine schlaue Phase lief), nicht "ist
        # unterwegs gestorben" (waere weiterhin obiger Abschnitt, ueber die
        # bestehende OllamaUnavailable-Kreisunterbrecher-Meldung) - Auftrag
        # "startklar" (03.09.2026), Punkt 1b.
        lines += ["", "## MLX-Server konnte nicht bereitgestellt werden - Phasen uebersprungen",
                  f"- Grund: {mlx_start_failed}"]
        if mlx_skipped:
            lines.append("- uebersprungen (brauchen den MLX-Server): "
                         + ", ".join(mlx_skipped))
        else:
            lines.append("- keine der gelaufenen Phasen brauchte dafuer den MLX-Server")
    if mlx_dry_run_status:
        # Auftrag "zeitgrenze" Nachtrag Punkt 5 (04.09.2026): ein Trockenlauf
        # provisioniert den MLX-Server nicht - er meldet nur, ob ein echter
        # Lauf ihn starten muesste, und ruft linking/consolidate/maintain/
        # synth/mine gar nicht erst auf.
        lines += ["", "## MLX-Server (Trockenlauf - nicht provisioniert)",
                  f"- Status: {mlx_dry_run_status}",
                  "- linking/consolidate/maintain/synth/mine wurden nicht "
                  "aufgerufen (Trockenlauf ruft kein Modell)"]
    if deadline_stops:
        lines += ["", "## Zeitbudget erschoepft - Phasen angehalten"]
        for hit in deadline_stops:
            done, total = hit.get("done"), hit.get("total")
            if total is not None:
                progress = f" ({done}/{total})"
            elif done is not None:
                progress = f" (bei {done})"
            else:
                progress = ""
            label = DEADLINE_PHASE_LABELS.get(hit["phase"], hit["phase"])
            lines.append(f"- {label}: angehalten{progress}")
        embed_hit = next((h for h in deadline_stops if h["phase"] == "embed"), None)
        if embed_hit is not None:
            lines.append(
                f"- Achtung: embed wurde verkuerzt ({embed_hit.get('done')}/"
                f"{embed_hit.get('total')}) - {EMBED_DEPENDENT_PHASES} haben "
                "nur mit den bis dahin eingebetteten Notizen gearbeitet, "
                "nicht mit dem vollen Bestand")
    if findings:
        by_kind: dict[str, int] = {}
        for f in findings:
            by_kind[f.kind] = by_kind.get(f.kind, 0) + 1
        lines += ["", "## Lint"]
        lines += [f"- {kind}: {count}" for kind, count in sorted(by_kind.items())]
    if audit_rel:
        lines += ["", f"## Health-Report\n- {audit_rel}"]
    if dry_run and writer.planned:
        lines += ["", "## Geplante Schreibzugriffe (dry-run)"]
        lines += [f"- {p}" for p in sorted(set(writer.planned))]
    lines.append("")
    return "\n".join(lines)


def run(args) -> int:
    vault = Path(args.vault).expanduser().resolve()
    phase = args.phase
    logfile = setup_logging(config.LOG_DIR, args.verbose)
    log.info("gardener start (vault=%s, phase=%s, dry_run=%s)",
             vault, phase, args.dry_run)

    client = OllamaClient()
    # MODELLWEGE (02.09.2026): ein zweiter, engerer Client fuer die
    # Aufrufstellen, deren Fehlurteil Unsinn in den Vault schreibt oder eine
    # Struktur behauptet, die nicht da ist - linking, consolidate,
    # maintain's HOT.md-Zusammenfassung, mine, synth. `client` (Ollama,
    # SMALL_MODEL) bleibt fuer Embeddings, Vision und die reine
    # Textzusammenfassung bei ingest/sidecar; `smart` (Qwen3.8-27B via MLX,
    # `regeln/orchestrierung.md` "Modellwahl") uebernimmt nur die sechs
    # Urteils-/Schreib-Stellen. `contradict` (brain contradict) ist ebenso
    # klassifiziert, aber sein Client wird ausserhalb dieses Tools in
    # braincli konstruiert - siehe config.py bei CONTRADICT_TOP_K.
    smart = GrugJudgeClient()
    # NACHTRAG 2 (02.09.2026), gemessen an der 20-Paar-Stichprobe dieses
    # Auftrags: fuer linking stimmen die Urteile mit und ohne Denken in 19
    # von 20 Faellen ueberein, der eine Unterschied ist eine ausgelassene
    # statt einer erfundenen Verknuepfung (der guenstige Fehler), und ohne
    # Denken ist ~15x schneller (5,78 s gegen 84,67 s je Urteil). Nur linking
    # bekommt deshalb eine EIGENE Instanz mit `enable_thinking=False` - "je
    # Klasse einstellbar", wie der Auftrag es verlangt. Die anderen vier
    # schlauen Stellen sind dafuer nicht gemessen (zwei davon, consolidate
    # und synth, schreiben generativ in den Vault) und bleiben auf `smart`
    # (Denken an, unveraendert).
    smart_linking = GrugJudgeClient(enable_thinking=False)
    # Point 1, 2026-09-02: Ollama being unreachable here used to abort before
    # a single phase ran - not even lint/owner, which need no model at all.
    # "a big model is already loaded" stays a hard defer (a resource conflict,
    # not an outage: running now risks fighting that model for the GPU), but
    # "Ollama did not answer this probe" now just means the model-dependent
    # phases sit this run out; everything else still runs, see `ollama_dead`.
    ollama_dead: str | None = None
    try:
        big = client.big_model_loaded()
    except OllamaError as e:
        log.warning("%s - model-dependent phases will be skipped, the rest "
                    "of the run still runs", e)
        ollama_dead = str(e)
        big = None
    if big:
        log.error("48-GB rule: %s is loaded (>15 GB) - deferring run", big)
        return 3

    lock = Lock(config.STATE_DIR / "gardener.lock")
    try:
        lock.acquire()
    except LockHeldError as e:
        log.error("%s", e)
        return 4

    # Letzter VERSUCH, getrennt vom letzten ERFOLG unten (write_last_run):
    # geschrieben, sobald der Lauf wirklich beginnt, damit ein Abbruch danach
    # sichtbar bleibt, statt hinter einem alten Erfolg zu verschwinden. Ein
    # getoeteter Prozess erreicht keinen der Punkte, die diesen Eintrag
    # spaeter ueberschreiben - die "running"-Marke ohne "finished" bleibt
    # dann selbst das sichtbare Zeichen des Abbruchs.
    started = dt.datetime.now().isoformat(timespec="seconds")
    if not args.dry_run:
        record_attempt(config.STATE_DIR, {"started": started, "phase": phase,
                                          "status": "running"})

    store = None
    mlx_owned = False   # only set True by a successful mlx_server.ensure() -
                        # release() below must stay a no-op otherwise
    try:
        # Kein Vorab-Schnappschuss mehr. Er stellte den ganzen Baum ein und war
        # damit genau der Weg, auf dem fremde, halbfertige Arbeit in einen
        # Gaertner-Commit geriet (10.08.2026, `9b7829f`). Was er schuetzen
        # sollte, schuetzt jetzt die Regel selbst: der Lauf fasst fremde
        # Dateien nicht an, also braucht es keinen Schnappschuss davor.
        #
        # Auftrag "zeitgrenze" Punkt 6 (04.09.2026): `--budget-minutes`
        # ueberschreibt das Budget NUR fuer diesen Lauf - config.RUN_BUDGET_
        # SECONDS bleibt die Voreinstellung fuer jeden Lauf ohne den Schalter.
        # Weicht der tatsaechlich genutzte Wert davon ab, traegt build_report()
        # ihn sichtbar, sonst waere spaeter nicht nachvollziehbar, unter
        # welcher Grenze ein Lauf stand.
        budget_minutes_arg = getattr(args, "budget_minutes", None)
        budget_seconds = (budget_minutes_arg * 60 if budget_minutes_arg is not None
                          else config.RUN_BUDGET_SECONDS)
        budget_override_minutes = (budget_minutes_arg
                                   if budget_seconds != config.RUN_BUDGET_SECONDS
                                   else None)
        deadline = Deadline(budget_seconds)
        # dry-run: the store is read-only too, so a dry-run cannot poison the
        # blocklist / embedding cache of the next real run
        store = Store(config.STATE_DIR / "gardener.db", read_only=args.dry_run)
        # Was VOR dem Lauf uncommittet im Baum liegt, gehoert jemand anderem.
        # Der Writer laesst diese Dateien in Ruhe, damit der Lauf am Ende
        # nichts einzustellen hat, was er nicht selbst geschrieben hat.
        writer = VaultWriter(vault, dry_run=args.dry_run,
                             foreign=dirty_paths(vault))
        queue = ReviewQueue(writer)

        link_res = linking.LinkResult()
        cons_res = consolidate.ConsolidateResult()
        maint_res = maintain.MaintainResult()
        topic_res = topics.TopicResult()
        ingest_res = ingest_mod.IngestResult()
        mine_res = mine_mod.MineResult()
        sidecar_res = sidecar_mod.SidecarResult()
        synth_res = synth_mod.SynthResult()
        owner_res = owner_mod.OwnerResult()
        findings: list = []
        audit_rel = None
        ollama_skipped: list[str] = []

        def _guard(name: str, fn):
            """Run one model-dependent phase step. Point 1, 2026-09-02: an
            Ollama outage used to propagate straight out of `run()` as an
            uncaught OllamaUnavailable, throwing away every phase after the
            one that hit it - including phases (lint, owner, and most of
            maintain) that need no model at all. Now only THIS step is
            skipped, and once Ollama is known dead, later steps here are
            skipped without even trying (no point burning the run budget on
            a retry that can only fail the same way again)."""
            nonlocal ollama_dead
            if ollama_dead:
                ollama_skipped.append(name)
                return None
            try:
                return fn()
            except OllamaUnavailable as e:
                ollama_dead = str(e)
                ollama_skipped.append(name)
                log.error("ollama unavailable during %s: %s - skipping this "
                          "phase, the run continues without it", name, e)
                return None

        # ingest first: dropped files become notes/assets the later phases see
        notes = load_notes(vault)
        if wants(phase, "ingest"):
            res = _guard("ingest", lambda: ingest_mod.run_ingest(
                vault, notes, writer, client, queue, dry_run=args.dry_run))
            if res is not None:
                ingest_res = res
                if ingest_res.ingested and not args.dry_run:
                    notes = load_notes(vault)
        log.info("%d notes in corpus", len(notes))

        if wants(phase, "sidecar"):
            res = _guard("sidecar", lambda: sidecar_mod.run_sidecar_phase(
                vault, notes, writer, client, queue, deadline,
                dry_run=args.dry_run))
            if res is not None:
                sidecar_res = res

        heat = load_heat(vault)
        vectors: dict[str, list[float]] = {}
        embedded = []
        hubs = topics.load_hubs(vault)
        if phase in EMBED_PHASES:
            res = _guard("embed", lambda: linking.embed_notes(
                notes + hubs, store, client, deadline, dry_run=args.dry_run))
            vectors = res if res is not None else {}
            # deadline may have cut embedding short: only fully embedded notes
            # take part in similarity-based stages
            embedded = [n for n in notes if n.rel in vectors]

        if phase == EMBED_ONLY_PHASE:
            # Hier ist Schluss: kein Bericht, kein Commit - der Lauf hat
            # nichts getan, was ein Mensch nachlesen muesste, und nichts, was
            # in einer Notiz steht. `last_run` (der letzte VOLLSTAENDIGE
            # Gaertnerlauf) bleibt deshalb unangetastet, ein embed-Lauf ist
            # keiner. Der VERSUCH muss trotzdem abgeschlossen werden - sonst
            # bleibt die "running"-Marke von oben stehen, und ein sauber
            # durchgelaufener embed-Lauf sieht aus wie ein abgestuerzter.
            if not args.dry_run:
                attempt = {"started": started,
                          "finished": dt.datetime.now().isoformat(timespec="seconds"),
                          "phase": phase,
                          "status": ("ollama_unavailable" if ollama_dead
                                     else "partial" if deadline.stops else "ok"),
                          "embedded": len(vectors), "total": len(notes) + len(hubs),
                          # Auftrag "zeitgrenze" Punkt 7a (04.09.2026): immer
                          # eingetragen, nicht nur bei Abweichung - ein
                          # "angehalten bei 200/413" ist nur halb lesbar ohne
                          # die Grenze, gegen die gemessen wurde.
                          "budget_seconds": budget_seconds}
                if ollama_dead:
                    attempt["detail"] = ollama_dead
                if deadline.stops:
                    attempt["deadline_stops"] = deadline.stops
                record_attempt(config.STATE_DIR, attempt)
            log.info("done: gardener[embed]: %d/%d Vektoren im Index (log: %s)",
                     len(vectors), len(notes) + len(hubs), logfile)
            return 0

        # Auftrag "startklar" (03.09.2026): the gardener never provisioned
        # the MLX server its five smart phases depend on - a server that is
        # not running made every one of those calls fail exactly like an
        # Ollama outage (see mlx_server.py's module docstring), and for a
        # phase judging fewer pairs than the failure threshold, not even
        # that: every call silently returned {} and the phase "succeeded"
        # with nothing found. `mlx_start_failed` keeps that failure visibly
        # DISTINCT from a server that answered fine here and died mid-run
        # (still `ollama_dead`/`_guard`, unchanged, below).
        mlx_start_failed: str | None = None
        mlx_skipped: list[str] = []
        mlx_dry_run_status: str | None = None
        if any(wants(phase, name) for name in SMART_PHASES):
            if args.dry_run:
                # Auftrag "zeitgrenze" Nachtrag Punkt 5 (04.09.2026): `ensure()`
                # provisions ~20 GB - exactly the free memory a dry run exists
                # to report on, so it must never provision anything itself.
                # Instead it reports whether a real run WOULD have to (the
                # server not already up) or not (already serving, a guest
                # situation an ensure() would have left alone anyway).
                # `mlx_owned` deliberately stays False here: this run started
                # nothing, so `release()` below is a no-op, not a stop of a
                # server this run never touched.
                try:
                    mlx_dry_run_status = (
                        "bereits erreichbar (kein Start noetig)"
                        if mlx_server.already_serving()
                        else "nicht erreichbar - ein echter Lauf muesste ihn "
                             "starten (~20 GB)")
                except mlx_server.MlxServerError as e:
                    mlx_dry_run_status = f"Status nicht lesbar: {e}"
            else:
                try:
                    mlx_owned = mlx_server.ensure()
                except mlx_server.MlxServerError as e:
                    mlx_start_failed = str(e)
                    log.error("mlx server could not be provisioned for this run "
                              "- the phases that need it are skipped, the rest "
                              "of the run still runs: %s", e)

        def _smart_guard(name: str, fn):
            """Like `_guard`, but for the phases that need the MLX server
            specifically - skipped up front, without even trying, when
            `ensure()` itself already failed, or (Nachtrag Punkt 5) when
            this is a dry run: a dry run calls no model, it only reports."""
            if mlx_start_failed or args.dry_run:
                mlx_skipped.append(name)
                return None
            return _guard(name, fn)

        if wants(phase, "linking"):
            res = _smart_guard("linking", lambda: linking.run_linking(
                embedded, vectors, store, smart_linking, writer, deadline))
            if res is not None:
                link_res = res
        if wants(phase, "consolidate"):
            res = _smart_guard("consolidate", lambda: consolidate.run_consolidation(
                embedded, vectors, store, smart, writer, deadline, queue))
            if res is not None:
                cons_res = res
        if wants(phase, "maintain"):
            # maintain needs no model for orphan healing, MOC updates,
            # recency markers or the decision/open-question indexes - only
            # its HOT.md summary prefers one, and regenerate_hot() already
            # falls back to a plain listing when the judge is unavailable
            # (see maintain.py) or missing entirely (`client is None`, same
            # function) - so maintain always runs, model or not. When the
            # MLX server itself could not be provisioned, `smart` is
            # guaranteed to fail every call anyway - passing None instead
            # skips straight to the degraded listing rather than burning a
            # doomed HTTP timeout first. A dry run (Nachtrag Punkt 5) gets
            # the same None: it must call no model either.
            maint_res = maintain.run_maintenance(
                notes, writer, None if (mlx_start_failed or args.dry_run)
                else smart, queue, heat)
            topic_res = topics.run_topics(hubs, embedded, vectors, writer, queue)
        if wants(phase, "synth"):
            contra_store = ContradictionStore(vault / config.CONTRADICTIONS_FILE)
            res = _smart_guard("synth", lambda: synth_mod.run_synth(
                vault, embedded, hubs, vectors, writer, smart, contra_store,
                min_sources=args.min_notes, only_topic=args.topic))
            if res is not None:
                synth_res = res
        if wants(phase, "mine"):
            res = _smart_guard("mine", lambda: mine_mod.run_mining(
                vault, notes, writer, smart, store, deadline))
            if res is not None:
                mine_res = res
        if wants(phase, "owner"):
            owner_res = owner_mod.run_owner(vault, writer)
        lint_ran = wants(phase, "lint") or args.audit
        if lint_ran:
            findings = lint_mod.run_lint(vault, notes, heat)
            lint_mod.queue_findings(findings, queue)
            audit_rel = audit_mod.run_audit(notes, writer, findings=findings,
                                            heat=heat)

        # `smart`/`smart_linking`s Fehlschlaege sind toleriert-lokale
        # Ausfaelle genau wie `client`s - alle drei zaehlen hier zusammen,
        # sonst verschwindet ein MLX-Aussetzer spurlos aus dem Bericht, den
        # nur die Ollama-Seite je gemeldet hat.
        ollama_failures = (getattr(client, "transient_failures", 0)
                          + getattr(smart, "transient_failures", 0)
                          + getattr(smart_linking, "transient_failures", 0))
        report = build_report(link_res, cons_res, maint_res, topic_res, ingest_res,
                              mine_res, findings, audit_rel, phase, args.dry_run,
                              writer, ollama_failures, sidecar_res, synth_res,
                              owner_res, ollama_dead, ollama_skipped,
                              mlx_start_failed, mlx_skipped, deadline.stops,
                              budget_override_minutes, mlx_dry_run_status)
        report_rel = f"00-sources/gardener-report-{dt.date.today().isoformat()}.md"
        # Wer parallel im Vault arbeitet, soll im Bericht stehen - und deshalb
        # muss die Liste VOR dem Schreiben feststehen. Eigen ist, was der
        # Writer angefasst hat, dazu der Bericht selbst; alles andere ist
        # fremd, bleibt unangetastet und wird nur genannt.
        foreign = foreign_changes(vault, set(writer.written) | {report_rel})
        if foreign:
            report += ("\n\nFremde Aenderungen im Baum (nicht committet, "
                       f"nicht angefasst): {len(foreign)}\n"
                       + "\n".join(f"  {f}" for f in foreign[:20]) + "\n")
            log.info("gardener: %d fremde Aenderung(en) unangetastet gelassen",
                     len(foreign))
        if writer.foreign_skipped:
            report += ("\nNotizen, die dieser Lauf aendern wollte und nicht "
                       "angefasst hat, weil dort jemand anderes uncommittet "
                       f"arbeitet: {len(writer.foreign_skipped)}\n"
                       + "\n".join(f"  {p}" for p in
                                   writer.foreign_skipped[:20]) + "\n")
        if args.dry_run:
            # never write into the vault on a dry-run: the report goes to the
            # (gitignored) log dir and to stdout
            (config.LOG_DIR / Path(report_rel).name).write_text(report)
            print(report)
        else:
            writer.write(vault / report_rel, report)

        msg = (f"gardener[{phase}]" + (" (PARTIAL, ollama down)" if ollama_dead else "")
               + (" (PARTIAL, mlx-server konnte nicht starten)" if mlx_start_failed else "")
               + (" (ANGEHALTEN, Zeitbudget erschoepft)" if deadline.stops else "")
               + f": {len(link_res.added)} links, "
               f"{len(cons_res.merged)} merges, "
               f"{len(cons_res.queued) + len(maint_res.orphans_queued)} queued, "
               f"{len(ingest_res.ingested)} ingested, "
               f"{len(sidecar_res.generated) + len(sidecar_res.updated)} sidecars, "
               f"{len(mine_res.candidates)} mined, {len(findings)} findings, "
               f"{len(synth_res.written)} topic pages, "
               f"{len(owner_res.stamped)} owners")
        # Eingestellt wird, was DIESER Lauf geschrieben hat - `writer.written`
        # ist die Liste, die der VaultWriter ohnehin fuehrt.
        commit = git_commit(vault, msg, writer.written, dry_run=args.dry_run)
        if not args.dry_run:
            finished = dt.datetime.now().isoformat(timespec="seconds")
            attempt = {"started": started, "finished": finished, "phase": phase,
                      "status": "partial" if (ollama_dead or mlx_start_failed
                                              or deadline.stops) else "ok",
                      # Punkt 7a: immer eingetragen, nicht nur bei Abweichung
                      # von der Vorgabe - siehe die embed-only-Stelle oben.
                      "budget_seconds": budget_seconds}
            if ollama_dead:
                attempt["detail"] = ollama_dead
                attempt["skipped_phases"] = ollama_skipped
            if mlx_start_failed:
                # Eigenes Feld, nicht in "detail"/"skipped_phases" verschmolzen -
                # Auftrag "startklar" (03.09.2026), Punkt 1b: "konnte nicht
                # starten" muss vom bestehenden "ist unterwegs gestorben"
                # (ollama_dead, oben) unterscheidbar bleiben, auch hier im
                # Status, nicht nur im Bericht.
                attempt["mlx_start_failed"] = mlx_start_failed
                attempt["mlx_skipped_phases"] = mlx_skipped
            if deadline.stops:
                # Auftrag "zeitgrenze" (04.09.2026), Punkt 4: ein Lauf, den das
                # Zeitbudget abgeschnitten hat, muss im last-run-Zustand
                # erkennbar bleiben, genau wie ein Ollama- oder MLX-Ausfall
                # oben - sonst sieht ein spaeterer Blick auf state/ einen
                # unvollstaendigen Lauf als ganz normalen Erfolg an.
                attempt["deadline_stops"] = deadline.stops
            if ollama_dead or mlx_start_failed or deadline.stops:
                # Point 1, 2026-09-02: a run that only got through because
                # several model-dependent phases sat out is not "the last
                # SUCCESS" (see runtime.record_attempt's docstring) - only
                # the last ATTEMPT. Writing it into `last_run`'s top-level
                # fields would let a half-finished pass pass for a full one;
                # the previous real success stays there untouched instead.
                record_attempt(config.STATE_DIR, attempt)
            else:
                # Brain.app reads this instead of parsing the log
                write_last_run(config.STATE_DIR, {
                    "finished": finished,
                    "phase": phase,
                    "status": "ok",
                    "links": len(link_res.added),
                    "merges": len(cons_res.merged),
                    "queued": len(cons_res.queued) + len(maint_res.orphans_queued),
                    "ingested": len(ingest_res.ingested),
                    "mined": len(mine_res.candidates),
                    "findings": len(findings),
                    "topic_pages": len(synth_res.written),
                    "conflicts": len(set(writer.conflicts)),
                    "ollama_failures": ollama_failures,
                    "report": report_rel,
                    "summary": msg,
                    # last ATTEMPT == last SUCCESS here; still written so a
                    # reader only ever has to look at "last_attempt" to know
                    # whether the newest run went through.
                    "last_attempt": attempt,
                })
        if writer.conflicts:
            log.warning("%d note(s) changed on disk mid-run and were NOT "
                        "overwritten: %s", len(set(writer.conflicts)),
                        ", ".join(sorted(set(writer.conflicts))))
        log.info("done: %s (log: %s)", msg, logfile)
        return 0
    except OllamaError as e:
        log.error("ollama failure mid-run: %s - aborting", e)
        if not args.dry_run:
            record_attempt(config.STATE_DIR, {
                "started": started,
                "finished": dt.datetime.now().isoformat(timespec="seconds"),
                "phase": phase, "status": "ollama_unavailable", "detail": str(e)})
        return 2
    except Exception as e:
        # Ein Bug oder sonst eine unerwartete Ausnahme mitten im Lauf darf
        # denselben Effekt nicht haben wie ein sauber abgefangener Ollama-
        # Fehler: verschwinden, weil last-run.json nur den letzten Erfolg
        # kennt. Nach dem Vermerk laeuft der Absturz unveraendert weiter.
        if not args.dry_run:
            record_attempt(config.STATE_DIR, {
                "started": started,
                "finished": dt.datetime.now().isoformat(timespec="seconds"),
                "phase": phase, "status": "error", "detail": str(e)})
        raise
    finally:
        if store is not None:
            store.close()
        # Nur der Server, den DIESER Lauf tatsaechlich provisioniert hat
        # (mlx_owned bleibt False, wenn `ensure()` nie erfolgreich war -
        # weder ausgelassen noch fehlgeschlagen) - siehe mlx_server.py.
        mlx_server.release(mlx_owned)
        lock.release()


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="gardener", description=__doc__)
    p.add_argument("--vault", default=str(config.DEFAULT_VAULT))
    p.add_argument("--phase", choices=list(config.PHASES), default="all",
                   help="run a single phase instead of the full pass")
    p.add_argument("--dry-run", action="store_true",
                   help="report only: no vault writes, no state writes, no commits")
    p.add_argument("--once", action="store_true",
                   help="explicit single run (default behavior; for clarity)")
    p.add_argument("--audit", action="store_true",
                   help="force the health report")
    p.add_argument("--topic", default=None,
                   help="phase synth: only (re)generate this one topic page")
    p.add_argument("--min-notes", type=int, default=None,
                   help="phase synth: override the minimum source-note gate")
    p.add_argument("--budget-minutes", type=float, default=None,
                   help="override config.RUN_BUDGET_SECONDS for this run only - "
                        "the default (45 min) is unchanged when omitted; a "
                        "value that differs from the default shows up in the "
                        "report, so a later reader can see what deadline a "
                        "run actually stood under")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args(argv)
    # Zustand an den Vault binden, BEVOR Logfile, Lock oder Store aufgemacht
    # werden - siehe config.bind_vault.
    config.bind_vault(args.vault)
    try:
        return run(args)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
