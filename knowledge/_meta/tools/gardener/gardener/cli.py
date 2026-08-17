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
               owner as owner_mod, sidecar as sidecar_mod, synth as synth_mod,
               topics)
from .contradict import ContradictionStore
from .heat import load_heat
from .ollama import OllamaClient, OllamaError
from .queue import ReviewQueue
from .runtime import (Deadline, Lock, LockHeldError, dirty_paths,
                      foreign_changes, git_commit, setup_logging,
                      write_last_run)
from .store import Store
from .vault import VaultWriter, load_notes

log = logging.getLogger("gardener")

# which phases need embeddings
EMBED_PHASES = {"embed", "linking", "consolidate", "maintain", "synth", "all"}
# `--phase embed` baut NUR den Einbettungs-Index neu: kein Verlinken, kein
# Zusammenfuehren, keine Themenseiten, kein Bericht, kein git-Commit, keine
# Zeile in einer Notiz. Der Anlass ist der Indexverlust vom 2026-08-04 - danach
# muss der Index wiederherstellbar sein, ohne dass ein voller Lauf gleichzeitig
# 38 Verlinkungen und 23 Themenseiten in den Vault schreibt. Wer den Index nur
# reparieren will, soll ihn nur reparieren koennen.
EMBED_ONLY_PHASE = "embed"


def wants(phase: str, name: str) -> bool:
    return phase in ("all", name)


def build_report(link_res, cons_res, maint_res, topic_res, ingest_res, mine_res,
                 findings, audit_rel, phase: str, dry_run: bool,
                 writer: VaultWriter, ollama_failures: int = 0,
                 sidecar_res=None, synth_res=None, owner_res=None) -> str:
    today = dt.date.today().isoformat()
    lines = [
        "---", f"title: gardener-report-{today}", "type: report", "---", "",
        f"# Gardener-Report {today}" + (" (DRY-RUN)" if dry_run else ""), "",
        f"Phase: {phase}", "",
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
    lines += ["", "## Pflege",
              f"- MOCs aktualisiert: {', '.join(maint_res.mocs_updated) or 'keine'}",
              f"- DECISIONS.md: {', '.join(maint_res.decisions_written) or 'keine'}",
              f"- OPEN-QUESTIONS.md: {maint_res.open_questions} offene Fragen",
              f"- HOT.md: {'aktualisiert' if maint_res.hot_updated else 'unveraendert'}",
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
    try:
        big = client.big_model_loaded()
    except OllamaError as e:
        log.error("%s - aborting", e)
        return 2
    if big:
        log.error("48-GB rule: %s is loaded (>15 GB) - deferring run", big)
        return 3

    lock = Lock(config.STATE_DIR / "gardener.lock")
    try:
        lock.acquire()
    except LockHeldError as e:
        log.error("%s", e)
        return 4

    store = None
    try:
        # Kein Vorab-Schnappschuss mehr. Er stellte den ganzen Baum ein und war
        # damit genau der Weg, auf dem fremde, halbfertige Arbeit in einen
        # Gaertner-Commit geriet (10.08.2026, `9b7829f`). Was er schuetzen
        # sollte, schuetzt jetzt die Regel selbst: der Lauf fasst fremde
        # Dateien nicht an, also braucht es keinen Schnappschuss davor.
        deadline = Deadline(config.RUN_BUDGET_SECONDS)
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

        # ingest first: dropped files become notes/assets the later phases see
        notes = load_notes(vault)
        if wants(phase, "ingest"):
            ingest_res = ingest_mod.run_ingest(vault, notes, writer, client, queue)
            if ingest_res.ingested and not args.dry_run:
                notes = load_notes(vault)
        log.info("%d notes in corpus", len(notes))

        if wants(phase, "sidecar"):
            sidecar_res = sidecar_mod.run_sidecar_phase(vault, notes, writer,
                                                        client, queue, deadline)

        heat = load_heat(vault)
        vectors: dict[str, list[float]] = {}
        embedded = []
        hubs = topics.load_hubs(vault)
        if phase in EMBED_PHASES:
            vectors = linking.embed_notes(notes + hubs, store, client, deadline)
            # deadline may have cut embedding short: only fully embedded notes
            # take part in similarity-based stages
            embedded = [n for n in notes if n.rel in vectors]

        if phase == EMBED_ONLY_PHASE:
            # Hier ist Schluss: kein Bericht, kein Commit, kein last-run.json -
            # der Lauf hat nichts getan, was ein Mensch nachlesen muesste, und
            # nichts, was in einer Notiz steht.
            log.info("done: gardener[embed]: %d/%d Vektoren im Index (log: %s)",
                     len(vectors), len(notes) + len(hubs), logfile)
            return 0

        if wants(phase, "linking"):
            link_res = linking.run_linking(embedded, vectors, store, client, writer,
                                           deadline)
        if wants(phase, "consolidate"):
            cons_res = consolidate.run_consolidation(embedded, vectors, store, client,
                                                     writer, deadline, queue)
        if wants(phase, "maintain"):
            maint_res = maintain.run_maintenance(notes, writer, client, queue, heat)
            topic_res = topics.run_topics(hubs, embedded, vectors, writer, queue)
        if wants(phase, "synth"):
            contra_store = ContradictionStore(vault / config.CONTRADICTIONS_FILE)
            synth_res = synth_mod.run_synth(vault, embedded, hubs, vectors, writer,
                                            client, contra_store,
                                            min_sources=args.min_notes,
                                            only_topic=args.topic)
        if wants(phase, "mine"):
            mine_res = mine_mod.run_mining(vault, notes, writer, client, store,
                                           deadline)
        if wants(phase, "owner"):
            owner_res = owner_mod.run_owner(vault, writer)
        lint_ran = wants(phase, "lint") or args.audit
        if lint_ran:
            findings = lint_mod.run_lint(vault, notes, heat)
            lint_mod.queue_findings(findings, queue)
            audit_rel = audit_mod.run_audit(notes, writer, findings=findings,
                                            heat=heat)

        ollama_failures = getattr(client, "transient_failures", 0)
        report = build_report(link_res, cons_res, maint_res, topic_res, ingest_res,
                              mine_res, findings, audit_rel, phase, args.dry_run,
                              writer, ollama_failures, sidecar_res, synth_res,
                              owner_res)
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

        msg = (f"gardener[{phase}]: {len(link_res.added)} links, "
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
            # Brain.app reads this instead of parsing the log
            write_last_run(config.STATE_DIR, {
                "finished": dt.datetime.now().isoformat(timespec="seconds"),
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
            })
        if writer.conflicts:
            log.warning("%d note(s) changed on disk mid-run and were NOT "
                        "overwritten: %s", len(set(writer.conflicts)),
                        ", ".join(sorted(set(writer.conflicts))))
        log.info("done: %s (log: %s)", msg, logfile)
        return 0
    except OllamaError as e:
        log.error("ollama failure mid-run: %s - aborting", e)
        return 2
    finally:
        if store is not None:
            store.close()
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
