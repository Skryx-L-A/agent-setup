"""brain: CLI over the Knowledge vault + Gardener.

`brain dream` ist der zweite Lauf neben dem Gaertner: er liest Vault,
Transkripte, Worker-Ergebnisse und die freigegebene Projektdokumentation, zieht
daraus einzelne belegte Aussagen, laesst jede vorgeschlagene Aenderung von
`claude-opus-5` beurteilen und uebernimmt sie erst, wenn deterministischer Code
jede Regel noch einmal bestaetigt hat. Was er NIE tut: er loescht keine Notiz,
er aendert keinen handgeschriebenen Satz - er haengt nur in seinem eigenen
Markerblock an - und er pusht nie.

Usage:
    brain search <query> [-k N] [--json] [--no-validity]
                          # Treffer mit abgeloesten Aussagen tragen [~], werden
                          # abgewertet und nie ausgeblendet; --no-validity oder
                          # BRAIN_VALIDITY=0 schaltet das ab, ohne den Index
                          # anzufassen
    brain gardener run [--phase embed|linking|consolidate|maintain|synth|all] [--dry-run]
                       # --phase embed: nur den Einbettungs-Index neu bauen,
                       #   ohne Bericht, Commit oder Schreibzugriff auf Notizen
                       [--audit] [--topic T] [--min-notes N]
    brain gardener status [--json]
    brain dream run [--limit N] [--budget-points P] [--dry-run] [--no-cloud]
    brain dream status | harvest | extract | reconcile | shadow | review |
                 apply | projects   (die einzelnen Schritte, siehe dream --help)
    brain sidecar scan [--path P] [--json]
    brain sidecar generate [--path P] [--force] [--model M] [--dry-run]
    brain sidecar check [--path P]
    brain contradict [--note P] [--since ISO-DATE] [--all] [--write] [--json] [-k N]
    brain contradict --queue-add <pfad>...              # anhaengen, dedupliziert, keine Prüfung
    brain contradict --queue [--write] [--json] [-k N]  # Warteschlange abarbeiten (+leeren)
    brain contradict --resolve <id> --by <wer> --why <text> [--rule N] [--write]
    brain ingest <quelle> [--branch P] [--title T] [--source URL] [--write] [--json]
                          [--no-contradict]
    brain stats [--json]
    brain undo <satz> [--all] [--limit N] [--yes] [--json]
    brain undo --list [--json] | --last
                          # nimmt zurueck, was Traum oder Gaertner geschrieben
                          # haben: zeigt immer erst den Plan, loescht nie, und
                          # prueft nach der Ruecknahme, ob auch der Index dem
                          # frueheren Stand folgt (siehe braincli/undo.py)
"""
from __future__ import annotations

import argparse
import os
import datetime as dt
import json
import sys
from pathlib import Path

from gardener import config
from gardener import contradict as contradict_mod
from gardener import sidecar as sidecar_mod
from gardener.linking import embed_notes
from gardener.ollama import OllamaClient, OllamaError, OllamaUnavailable
from gardener.runtime import Deadline
from gardener.store import Store
from gardener.vault import VaultWriter, load_notes

from . import gardener_wrap, ingest as ingest_mod, search as search_mod, stats as stats_mod

DEFAULT_VAULT = config.DEFAULT_VAULT


def cmd_search(args) -> int:
    vault = Path(args.vault)
    validity = False if getattr(args, "no_validity", False) else None
    hits, used_fallback = search_mod.search(vault, args.query, args.k, validity)
    if args.json:
        print(json.dumps({
            "query": args.query,
            "fallback": used_fallback,
            "hits": [h.__dict__ for h in hits],
        }, ensure_ascii=False, indent=2))
        return 0
    if used_fallback:
        print("Ollama nicht erreichbar - rg-Volltextsuche als Fallback:\n")
    if not hits:
        print("Keine Treffer.")
        return 0
    for h in hits:
        flag = "[!] " if h.contradiction else ""
        flag += "[~] " if h.retired else ""
        print(f"{flag}{h.rel}")
        if h.title:
            tag = f" [{h.match}]" if h.match else ""
            print(f"  Titel: {h.title}  (score {h.score:.3f}){tag}")
        if h.contradiction:
            print("  [!] traegt einen offenen Widerspruch - siehe review-queue.md")
        if h.retired:
            verb = "ist" if h.retired_claims == 1 else "sind"
            seit = f" (zuletzt {h.retired_since})" if h.retired_since else ""
            print(f"  [~] {h.retired_claims} von {h.total_claims} Aussagen dieser "
                  f"Notiz {verb} abgeloest{seit} - der Text steht noch da, gilt "
                  f"aber nicht mehr.")
        if h.snippet:
            print(f"  {h.snippet}")
        print()
    return 0


def cmd_contradict(args) -> int:
    # Doppelt gesichert (main() bindet auch schon): dies ist der eine Befehl,
    # dessen Embedding-Pass mit `prune_embeddings` endet. Wer ihn als Bibliothek
    # ueber `args.func(args)` aufruft, umgeht main() - und genau dieser Weg hat
    # am 2026-08-04 den echten Index geloescht.
    config.bind_vault(args.vault)
    if getattr(args, "resolve", None):
        # Aufloesen ist kein Scan: kein Modell, keine Nachbarsuche, nur der
        # Eintrag wer/wann/warum plus das Umschreiben der beiden Marker.
        if not args.why:
            print("FEHLER: --why fehlt - eine Aufloesung ohne Begruendung ist "
                  "im Protokoll wertlos.", file=sys.stderr)
            return 2
        vault = Path(args.vault)
        store = contradict_mod.ContradictionStore(vault / contradict_mod.config.CONTRADICTIONS_FILE
                                                  if not str(contradict_mod.config.CONTRADICTIONS_FILE).startswith("/")
                                                  else contradict_mod.config.CONTRADICTIONS_FILE)
        if store.get(args.resolve) is None:
            print(f"FEHLER: kein Befund mit der id {args.resolve!r}.", file=sys.stderr)
            return 1
        writer = VaultWriter(vault, dry_run=not args.write)
        finding = contradict_mod.resolve_finding(
            store, args.resolve, by=args.by, why=args.why, rule=args.rule,
            vault=vault, writer=writer)
        if args.write:
            store.save()
        # Die Queue mitschreiben, sonst steht ein aufgeloester Befund dort fuer
        # immer weiter (gemessen 2026-07-29: Marker sagte `resolved`, die Queue
        # meldete ihn unveraendert als offen). Der Schreiber fasst nur seinen
        # eigenen markierten Abschnitt an, Fremdeintraege bleiben stehen.
        contradict_mod.write_review_queue(vault, store.open_findings(),
                                          dry_run=not args.write)
        out = {"resolved": args.resolve, "status": finding.get("status"),
               "by": args.by, "why": args.why, "rule": args.rule,
               "written": bool(args.write)}
        print(json.dumps(out, ensure_ascii=False, indent=2) if args.json
              else f"Befund {args.resolve}: {finding.get('status')}"
                   + ("" if args.write else "  (Trockenlauf - nichts geschrieben)"))
        return 0

    vault = Path(args.vault)

    if getattr(args, "queue_add", None):
        # Reines Datei-Anhaengen: kein Vault-Load, kein Ollama, Millisekunden -
        # das ist der Schritt, der jetzt an Stelle des Scans im Session-Ende steht.
        added = contradict_mod.queue_add(vault, args.queue_add)
        if args.json:
            print(json.dumps({"queued": added}, ensure_ascii=False))
        else:
            print(f"{len(added)} Pfad(e) neu in der Warteschlange." if added
                  else "keine neuen Pfade (bereits in der Warteschlange).")
        return 0

    queue_entries: list[str] = []
    if getattr(args, "queue", False):
        queue_entries = contradict_mod.queue_read(vault)
        if not queue_entries:
            if args.json:
                print(json.dumps({"checked_notes": 0, "queue": [], "found": 0}, ensure_ascii=False))
            else:
                print("Warteschlange leer - nichts zu tun.")
            return 0

    client = OllamaClient()
    try:
        big = client.big_model_loaded()
    except OllamaError as e:
        print(f"Ollama nicht erreichbar: {e}")
        return 2
    if big:
        print(f"48-GB-Regel: {big} ist geladen (>15 GB) - Lauf verschoben.")
        return 3

    notes = load_notes(vault)
    by_rel = {n.rel: n for n in notes}

    unresolved: list[str] = []
    if args.note:
        target = contradict_mod.resolve_note_arg(vault, args.note, notes)
        if target is None:
            print(f"Notiz nicht gefunden: {args.note}")
            return 1
        to_check = [target]
    elif args.all:
        to_check = notes
    elif getattr(args, "queue", False):
        to_check = []
        seen: set[str] = set()
        for entry in queue_entries:
            n = contradict_mod.resolve_note_arg(vault, entry, notes)
            if n is None:
                unresolved.append(entry)
            elif n.rel not in seen:
                seen.add(n.rel)
                to_check.append(n)
        for u in unresolved:
            print(f"uebersprungen (Notiz nicht gefunden): {u}", file=sys.stderr)
    elif args.since:
        to_check = contradict_mod.changed_since(notes, dt.datetime.fromisoformat(args.since))
    else:
        cutoff = contradict_mod.load_last_run(vault) or dt.datetime.fromtimestamp(0)
        to_check = contradict_mod.changed_since(notes, cutoff)

    # Ein Vollscan ueber den ganzen Korpus dauert Stunden (gemessen: ~19 s je
    # Paar, 210 Notizen mal 5 Nachbarn). Das 45-Minuten-Budget ist fuer den
    # taeglichen --since-Lauf richtig und fuer einen unbeaufsichtigten Vollscan
    # zu knapp - deshalb ueberschreibbar, statt den Lauf jedes Mal auf einem
    # Sechstel abzuschneiden.
    budget = config.RUN_BUDGET_SECONDS
    env_budget = os.environ.get("BRAIN_CONTRADICT_BUDGET_SECONDS")
    if env_budget:
        try:
            budget = max(60, int(env_budget))
        except ValueError:
            pass
    deadline = Deadline(budget)
    embed_store = Store(config.STATE_DIR / "gardener.db", read_only=not args.write)
    try:
        vectors = embed_notes(notes, embed_store, client, deadline)
    except OllamaUnavailable as e:
        print(f"Ollama nicht erreichbar: {e}")
        return 2
    finally:
        embed_store.close()

    cstore = contradict_mod.ContradictionStore(vault / config.CONTRADICTIONS_FILE)
    result = contradict_mod.run_contradict(
        [n for n in to_check if n.rel in vectors], notes, vectors, client, cstore,
        top_k=args.k, deadline=deadline)

    writer = VaultWriter(vault, dry_run=not args.write)
    for finding in result.findings:
        a, b = by_rel.get(finding["note_a"]["rel"]), by_rel.get(finding["note_b"]["rel"])
        if a is not None and b is not None:
            contradict_mod.apply_markers(writer, a, b, finding)

    cstore.save(dry_run=not args.write)
    contradict_mod.write_review_queue(vault, cstore.open_findings(), dry_run=not args.write)
    contradict_mod.save_last_run(vault, dt.datetime.now(), dry_run=not args.write)

    if getattr(args, "queue", False) and args.write:
        # Der ganze angetroffene Stapel gilt als abgearbeitet, auch die
        # unresolved-Eintraege (fuer die gibt es sonst nichts mehr zu tun) -
        # was inzwischen NEU dazukam, bleibt stehen (queue_clear_processed
        # liest die Datei frisch statt den alten Stand zurueckzuschreiben).
        contradict_mod.queue_clear_processed(vault, queue_entries)

    if args.json:
        print(json.dumps({
            "checked_notes": len(to_check),
            "pairs_checked": result.pairs_checked,
            "found": len(result.findings),
            "compatible": result.compatible,
            "below_threshold": result.below_threshold,
            "hallucinated": result.hallucinated,
            "judge_failed": result.judge_failed,
            "dry_run": not args.write,
            "findings": result.findings,
        }, ensure_ascii=False, indent=2))
        return 0

    print(f"geprueft: {len(to_check)} Notiz(en), {result.pairs_checked} Paar(e)")
    print(f"Befunde: {len(result.findings)}  "
          f"(kompatibel: {result.compatible}, unter Schwelle: {result.below_threshold}, "
          f"halluziniert verworfen: {result.hallucinated})")
    for f in result.findings:
        tag = "ESKALIERT" if f["status"] == "escalated" else f["verdict"]
        print(f"  [{tag}] {f['note_a']['title']} <-> {f['note_b']['title']} "
              f"(Konfidenz {f['confidence']:.2f}, id {f['id']})")
    if not args.write:
        print("(dry-run: keine Schreibzugriffe - siehe --write)")
    return 0


def cmd_ingest(args) -> int:
    vault = Path(args.vault)
    client = OllamaClient()
    outcome = ingest_mod.run_ingest(
        vault, args.quelle, branch=args.branch, title_override=args.title,
        origin=args.origin,
        write=args.write, check_contradict=not args.no_contradict, client=client)
    if args.json:
        print(json.dumps(outcome, ensure_ascii=False, indent=2))
        return 0
    if outcome["duplicate"]:
        print(f"bereits eingelesen: {outcome['note']} ({outcome['title']})")
        return 0
    tag = " (dry-run)" if not args.write else ""
    print(f"Notiz: {outcome['note']}{tag}")
    print(f"extrahiert: {outcome['extracted']} ({outcome['extractor'] or 'kein Extraktor'})")
    if outcome["extraction_error"]:
        print(f"Hinweis: {outcome['extraction_error']}")
    if outcome["related_notes"]:
        print("verwandte Notizen:")
        for r in outcome["related_notes"]:
            print(f"  - {r['title']} ({r['rel']})")
    cr = outcome["contradictions"]
    if cr["checked"]:
        print(f"Widerspruchspruefung: {cr['found']} Befund(e) von {cr['pairs_checked']} Paar(en)")
    elif cr["skipped_reason"]:
        print(f"Widerspruchspruefung uebersprungen: {cr['skipped_reason']}")
    if not args.write:
        print("(dry-run: keine Schreibzugriffe - siehe --write)")
    return 0


def cmd_gardener_run(args) -> int:
    vault = Path(args.vault)
    return gardener_wrap.run(vault, phase=args.phase, dry_run=args.dry_run,
                             audit=args.audit, verbose=args.verbose,
                             topic=getattr(args, "topic", None),
                             min_notes=getattr(args, "min_notes", None))


def cmd_gardener_status(args) -> int:
    vault = Path(args.vault)
    result = gardener_wrap.status(vault)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    lock = result["lock"]
    print(f"laeuft: {lock['running']}")
    if lock.get("lock_age_seconds") is not None:
        print(f"lock-alter: {lock['lock_age_seconds']:.0f}s ({lock['lock_path']})")
    last = result["last_run"]
    if last:
        print(f"letzter lauf: {last['finished']} - {last['summary']}")
        if last.get("conflicts"):
            print(f"  nicht ueberschrieben (waehrend des Laufs geaendert): "
                  f"{last['conflicts']}")
    else:
        print("letzter lauf: keiner")
    report = result["latest_report"]
    print(f"letzter report: {report['path']} ({report['modified']})" if report
          else "letzter report: keiner")
    log = result["latest_log"]
    print(f"letztes log: {log['path']} ({log['modified']})" if log
          else "letztes log: keins")
    return 0


def cmd_sidecar_scan(args) -> int:
    vault = Path(args.vault)
    entries = sidecar_mod.scan(vault, path=args.path)
    by_status: dict[str, int] = {}
    for e in entries:
        by_status[e.status] = by_status.get(e.status, 0) + 1
    if args.json:
        print(json.dumps({"entries": [e.__dict__ for e in entries],
                          "by_status": by_status}, ensure_ascii=False, indent=2))
        return 0
    print(f"Assets gesamt: {len(entries)}")
    for status, count in sorted(by_status.items()):
        print(f"  {status}: {count}")
    for e in entries:
        if e.status in ("missing", "stale"):
            print(f"- [{e.status}] {e.rel}")
    return 0


def cmd_sidecar_generate(args) -> int:
    vault = Path(args.vault)
    client = OllamaClient(judge_model=args.model) if args.model else OllamaClient()
    writer = VaultWriter(vault, dry_run=args.dry_run)
    result = sidecar_mod.generate(vault, writer, client, path=args.path,
                                  force=args.force)
    print(f"neu erzeugt: {len(result.generated)}")
    print(f"aktualisiert: {len(result.updated)}")
    print(f"Legacy-Stubs ergaenzt: {len(result.legacy_enriched)}")
    print(f"ohne Beschreibung (Metadaten-only): {len(result.metadata_only)}")
    if result.external:
        print(f"extern (> {config.SIDECAR_EXTERNAL_MB} MB, nicht committen - "
              f".gitignore/.gitattributes pruefen): {len(result.external)}")
        for rel in result.external:
            print(f"  - {rel}")
    if result.skipped_human_edited:
        print(f"human-edited uebersprungen: {len(result.skipped_human_edited)}")
    if result.skipped_malformed:
        print(f"malformte Marker uebersprungen: {len(result.skipped_malformed)}")
    if args.dry_run:
        print("(dry-run: keine Schreibzugriffe)")
    return 0


def cmd_sidecar_check(args) -> int:
    vault = Path(args.vault)
    entries = sidecar_mod.scan(vault, path=args.path)
    bad = [e for e in entries if e.status in ("missing", "stale")]
    if bad:
        for e in bad:
            print(f"[{e.status}] {e.rel}")
        print(f"{len(bad)} Sidecar(s) fehlen oder sind veraltet.")
        return 1
    print("alle Sidecars aktuell.")
    return 0


def cmd_stats(args) -> int:
    vault = Path(args.vault)
    result = stats_mod.collect(vault)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    print(f"Notes gesamt: {result['notes_total']}")
    print("Pro Branch:")
    for b, n in result["notes_per_branch"].items():
        print(f"  {b}: {n}")
    print(f"  davon in Gardeners Link-Korpus: {result['link_corpus_notes_total']} "
          "(schliesst MOC.md/DECISIONS.md/review-queue.md aus, siehe stats.collect docstring)")
    print(f"Wikilinks gesamt: {result['wikilinks_total']}")
    # Getrennt, weil nur die erste Zahl handlungsfaehig macht: Quellnotizen
    # (00-sources/, sessions/) werden ueber die Suche gefunden, nicht ueber Links.
    print(f"Orphans (Wissen, verlinkenswert): {len(result['orphans_knowledge'])}")
    for rel in result["orphans_knowledge"]:
        print(f"  {rel}")
    print(f"Orphans (Quellen, erwartbar): {len(result['orphans_source'])}")
    print(f"Assets: {result['assets_total']}")
    mb = result["lfs_object_size_bytes"] / (1024 * 1024)
    print(f"LFS-Objekte lokal: {mb:.1f} MB")
    print(f"Letztes Backup-Bundle: {result['last_backup_bundle'] or 'keins'}")
    return 0


def cmd_undo(args) -> int:
    """Ruecknahme eines Maschinenschreibvorgangs, in der Sprache der Frage.

    Der Ablauf ist immer derselbe und in dieser Reihenfolge zwingend: planen,
    ZEIGEN, bestaetigen lassen, ausfuehren, Index nachziehen, pruefen. Ohne
    `--yes` und ohne Terminal wird nur gezeigt - ein Werkzeug, das auf einen
    unscharfen Satz hin ungefragt Dateien zuruecksetzt, ist gefaehrlicher als
    das Problem, das es loest.
    """
    from . import undo as undo_mod

    vault = Path(args.vault)

    if args.last:
        eintrag = undo_mod.last_undo(vault)
        if not eintrag:
            print("Keine frueher ausgefuehrte Ruecknahme gefunden.")
            return 2
        print(f"Nimmt die Ruecknahme {eintrag['undo_id']} zurueck "
              f"({len(eintrag.get('entries', []))} Datei(en)).")
        if not (args.yes or _bestaetigt()):
            print("Abgebrochen, nichts geaendert.")
            return 0
        ergebnis = undo_mod.revert_undo(vault, eintrag)
        print(f"Zurueckgenommen: {', '.join(ergebnis['reverted']) or 'nichts'}")
        return 0

    if args.list:
        writes = undo_mod.anchor(vault, undo_mod.load_applied(vault))
        if args.json:
            print(json.dumps([{"run_id": w.run_id, "rel": w.rel, "op": w.op,
                               "at": w.at.isoformat(), "commit": w.commit}
                              for w in writes], ensure_ascii=False, indent=2))
            return 0
        for w in sorted(writes, key=lambda w: (w.at, w.rel), reverse=True):
            anker = w.commit[:9] if w.commit else "unverankert"
            print(f"{w.at:%Y-%m-%d %H:%M}  {w.rel}  (Lauf {w.run_id}, {anker})")
        if not writes:
            print("Kein uebernommener Schreibvorgang in _meta/state/dream/*/applied.json.")
        return 0

    if not args.satz:
        print("brain undo <satz>  - zum Beispiel: "
              "\"nimm zurueck, was der Traum gestern an der Notiz zu den "
              "Wortgrenzen getan hat\"")
        return 2

    intent, plans = undo_mod.plan_undo(vault, " ".join(args.satz), limit=args.limit)
    if args.json:
        print(json.dumps({"intent": {"actor": intent.actor,
                                     "since": intent.since.isoformat() if intent.since else None,
                                     "until": intent.until.isoformat() if intent.until else None},
                          "plans": [p.to_dict() for p in plans]},
                         ensure_ascii=False, indent=2))
        return 0

    print(undo_mod.render_plans(intent, plans))
    machbar = [p for p in plans if p.ok][:1] if not args.all else [p for p in plans if p.ok]
    if not machbar:
        return 2
    if not (args.yes or _bestaetigt()):
        print("\nAbgebrochen, nichts geaendert.")
        return 0

    eintrag = undo_mod.apply_plans(vault, machbar)
    print(f"\nWiederhergestellt: {len(eintrag['entries'])} Datei(en), "
          f"Ruecknahme {eintrag['undo_id']}"
          + (", committet" if eintrag.get("committed") else ", nicht committet"))
    for rel, was, _ in undo_mod.refresh_index(vault, [e["rel"] for e in eintrag["entries"]]):
        print(f"  Index: {rel} - {was}")
    befunde = undo_mod.verify(vault, eintrag, machbar)
    print(undo_mod.render_verify(befunde))
    return 3 if any(b["status"] != undo_mod.OK for b in befunde) else 0


def _bestaetigt() -> bool:
    """Ohne Terminal wird nie ausgefuehrt: ein Lauf aus einem Skript oder einem
    Hook heraus soll die Vorschau bekommen und sonst nichts."""
    if not sys.stdin.isatty():
        return False
    try:
        return input("\nAusfuehren? [j/N] ").strip().lower() in ("j", "ja", "y", "yes")
    except EOFError:
        return False


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="brain", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--vault", default=str(DEFAULT_VAULT))
    sub = p.add_subparsers(dest="cmd", required=True)

    p_search = sub.add_parser("search", help="semantic search over the vault")
    p_search.add_argument("query")
    p_search.add_argument("-k", type=int, default=5)
    p_search.add_argument("--json", action="store_true")
    p_search.add_argument("--no-validity", action="store_true",
                          help="abgeloeste Aussagen weder kennzeichnen noch "
                               "abwerten (auch: BRAIN_VALIDITY=0); der Index "
                               "bleibt unberuehrt")
    p_search.set_defaults(func=cmd_search)

    p_gardener = sub.add_parser("gardener", help="gardener control")
    gsub = p_gardener.add_subparsers(dest="gcmd", required=True)

    p_grun = gsub.add_parser("run", help="run gardener in the foreground")
    p_grun.add_argument("--phase", choices=list(gardener_wrap.VALID_PHASES),
                        default="all")
    p_grun.add_argument("--dry-run", action="store_true")
    p_grun.add_argument("--audit", action="store_true")
    p_grun.add_argument("--verbose", action="store_true")
    p_grun.add_argument("--topic", default=None,
                        help="nur diese eine Themenseite (Phase synth)")
    p_grun.add_argument("--min-notes", type=int, default=None,
                        help="Mindestzahl Quellnotizen je Themenseite (Phase synth)")
    p_grun.set_defaults(func=cmd_gardener_run)

    p_gstatus = gsub.add_parser("status", help="last gardener run / lock status")
    p_gstatus.add_argument("--json", action="store_true")
    p_gstatus.set_defaults(func=cmd_gardener_status)

    p_dream = sub.add_parser(
        "dream", help="dream control: the second run beside the gardener - "
                      "never deletes, never rewrites a hand-written sentence, "
                      "never pushes")
    p_dream.add_argument("dream_args", nargs=argparse.REMAINDER,
                         help="everything after `brain dream` goes to the "
                              "dream CLI unchanged (run, status, harvest, "
                              "extract, reconcile, shadow, review, apply, "
                              "projects)")
    p_dream.set_defaults(func=cmd_dream)

    p_sidecar = sub.add_parser("sidecar", help="asset sidecar layer (per-file .md description)")
    ssub = p_sidecar.add_subparsers(dest="scmd", required=True)

    p_sscan = ssub.add_parser("scan", help="report missing/stale sidecars (read-only)")
    p_sscan.add_argument("--path", default=None)
    p_sscan.add_argument("--json", action="store_true")
    p_sscan.set_defaults(func=cmd_sidecar_scan)

    p_sgen = ssub.add_parser("generate", help="write missing/stale sidecars")
    p_sgen.add_argument("--path", default=None)
    p_sgen.add_argument("--force", action="store_true")
    p_sgen.add_argument("--model", default=None)
    p_sgen.add_argument("--dry-run", action="store_true")
    p_sgen.set_defaults(func=cmd_sidecar_generate)

    p_scheck = ssub.add_parser(
        "check", help="exit != 0 if sidecars are missing/stale (pre-commit gate)")
    p_scheck.add_argument("--path", default=None)
    p_scheck.set_defaults(func=cmd_sidecar_check)

    p_contradict = sub.add_parser(
        "contradict", help="find knowledge contradictions between notes (not write conflicts)")
    p_contradict.add_argument("--note", default=None,
                              help="check only this note (vault-relative or absolute path)")
    p_contradict.add_argument("--since", default=None,
                              help="check notes changed since this ISO date/datetime")
    p_contradict.add_argument("--all", action="store_true",
                              help="check every note, ignoring the last-run timestamp")
    p_contradict.add_argument("--queue", action="store_true",
                              help="check only the notes queued via --queue-add, then (with "
                                   "--write) empty the queue")
    p_contradict.add_argument("--queue-add", nargs="+", default=None, metavar="PATH",
                              help="append path(s) to the queue, deduplicated, and exit "
                                   "(no scan, no model call)")
    p_contradict.add_argument("--write", action="store_true",
                              help="persist findings + marker blocks (default: dry-run)")
    p_contradict.add_argument("--json", action="store_true")
    p_contradict.add_argument("-k", type=int, default=config.CONTRADICT_TOP_K,
                              help="semantic neighbors checked per note")
    # Aufloesen: kein Scan, nur der Eintrag wer/wann/warum plus das Umschreiben
    # der beiden Marker. Ohne dieses Kommando bliebe jeder Befund fuer immer
    # offen - genau der Zustand, den 10-global/contradiction-rules.md vermeiden will.
    p_contradict.add_argument("--resolve", default=None, metavar="ID",
                              help="Befund als aufgeloest eintragen")
    p_contradict.add_argument("--by", default="orchestrator",
                              help="wer aufgeloest hat")
    p_contradict.add_argument("--why", default="",
                              help="warum - ein Satz, kommt ins Protokoll")
    p_contradict.add_argument("--rule", default="",
                              help="welche Regel aus 10-global/contradiction-rules.md griff")
    p_contradict.set_defaults(func=cmd_contradict)

    p_ingest = sub.add_parser(
        "ingest", help="pull external material (file/URL/YouTube/stdin) into 00-sources/")
    p_ingest.add_argument("quelle", help="path, URL, or - for stdin")
    p_ingest.add_argument("--branch", default=None,
                          help="context hint recorded in frontmatter (default: 00-sources)")
    p_ingest.add_argument("--title", default=None)
    p_ingest.add_argument("--source", dest="origin", default=None,
                          help="echte Herkunft, wenn gelesen wird aus einer "
                               "Kopie (heruntergeladenes Transkript, entpacktes "
                               "Archiv). Wird als source: vermerkt.")
    p_ingest.add_argument("--write", action="store_true",
                          help="persist the note + links + log (default: dry-run)")
    p_ingest.add_argument("--json", action="store_true")
    p_ingest.add_argument("--no-contradict", action="store_true",
                          help="skip the post-write contradiction check")
    p_ingest.set_defaults(func=cmd_ingest)

    p_undo = sub.add_parser(
        "undo", help="nimm zurueck, was Traum oder Gaertner geschrieben haben")
    p_undo.add_argument("satz", nargs="*",
                        help="die Ruecknahme in natuerlicher Sprache, z.B. "
                             "\"was der Traum gestern an der Notiz zu den "
                             "Wortgrenzen getan hat\"")
    p_undo.add_argument("--list", action="store_true",
                        help="alle uebernommenen Maschinenschreibvorgaenge zeigen")
    p_undo.add_argument("--last", action="store_true",
                        help="die zuletzt ausgefuehrte Ruecknahme zuruecknehmen")
    p_undo.add_argument("--all", action="store_true",
                        help="alle passenden Dateien statt nur der besten")
    p_undo.add_argument("--limit", type=int, default=5,
                        help="wieviele Kandidaten die Vorschau zeigt")
    p_undo.add_argument("--yes", action="store_true",
                        help="ohne Rueckfrage ausfuehren (nur fuer Skripte, die "
                             "die Vorschau bereits ausgewertet haben)")
    p_undo.add_argument("--json", action="store_true",
                        help="Vorschau maschinenlesbar ausgeben und nichts tun")
    p_undo.set_defaults(func=cmd_undo)

    p_stats = sub.add_parser("stats", help="vault health stats")
    p_stats.add_argument("--json", action="store_true")
    p_stats.set_defaults(func=cmd_stats)

    return p


def cmd_dream(args) -> int:
    """Reicht alles hinter `brain dream` unveraendert an die Traum-CLI weiter.

    Ein duenner Durchreicher wie `gardener_wrap`: die Unterbefehle, ihre Flags
    und ihre Rueckgabewerte stehen an einer Stelle, in
    `gardener.dream.cli`, und nicht zweimal.
    """
    from gardener.dream.cli import main as dream_main
    rest = list(args.dream_args or [])
    if not rest:
        rest = ["--help"]
    return dream_main(rest)


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    # Zustand an den Vault binden, BEVOR ein Unterbefehl einen Store aufmacht.
    # `brain --vault <wegwerf> contradict --write` hat am 2026-08-04 den
    # Embedding-Index des ECHTEN Vaults geloescht, weil nur der Korpus dem
    # --vault folgte und der Store nicht - siehe config.bind_vault.
    config.bind_vault(args.vault)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
