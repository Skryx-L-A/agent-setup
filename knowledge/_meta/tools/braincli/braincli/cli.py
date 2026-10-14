"""brain: CLI over the Knowledge vault + Gardener.

`brain dream` ist der zweite Lauf neben dem Gaertner: er liest Vault,
Transkripte, Worker-Ergebnisse und die freigegebene Projektdokumentation, zieht
daraus einzelne belegte Aussagen, laesst jede vorgeschlagene Aenderung von
`claude-opus-5` beurteilen und uebernimmt sie erst, wenn deterministischer Code
jede Regel noch einmal bestaetigt hat. Was er NIE tut: er loescht keine Notiz,
er aendert keinen handgeschriebenen Satz - er haengt nur in seinem eigenen
Markerblock an - und er pusht nie.

Usage:
    brain search <query> [-k N] [--json] [--no-validity] [--space NAME]
    brain frage <frage> [--motor peer|claude] [--modell M] [-k N] [--space NAME] [--json]
                          # kurze Antwort, jeder Satz mit pfad:zeile, jedes Zitat
                          # deterministisch geprueft; sonst "Nicht im Vault belegt."
                          # Exit 1 ohne belegten Satz. Nicht fuer Hooks.
                          # Abgeloeste Treffer (Frontmatter status/superseded-by/
                          # valid-until, sonst claims.db) tragen [~], werden
                          # abgewertet und nie ausgeblendet; ein fehlender Nachfolger
                          # wird eingereiht [+] (BRAIN_VALIDITY_NACHFOLGER=0 aus); --no-validity oder
                          # BRAIN_VALIDITY=0 schaltet das ab, ohne den Index
                          # anzufassen. --space filtert auf einen gemounteten
                          # Space (`kern` = Wurzel), braucht `brain spaces sync`
                          # BRAIN_EMBED_MODELL waehlt das Einbettungsmodell
                          # (embeddinggemma | qwen3-embedding-0.6b); ohne
                          # passenden eigenen Index laeuft embeddinggemma
                          # Fragt zuerst den warmen Suchprozess (warm.py: Unix-
                          # Socket nur fuer den Nutzer, Ende nach 30 min Leerlauf,
                          # gleiche Ausgabe); BRAIN_WARM=0 = immer kalt
    brain index bauen [--modell M] [--voll] [--json]
                          # eigenen Index des Modells daneben bauen, dann atomar
                          # tauschen (unveraenderte Vektoren werden uebernommen)
    brain index status [--modell M] [--json]
    brain spaces status                  # clean/ahead/behind je gemountetem Space
    brain spaces sync [--dry-run] [--manifest-only] [--push]
                          # fehlende Spaces klonen (nie in einen nicht-leeren
                          # Ordner), vorhandene per `git pull --ff-only`
                          # aktualisieren, Manifest .brain/spaces.lock +
                          # .gitignore-Block schreiben (S1, siehe gardener.spaces)
    brain run [status] [--profil all|gardener|lehren|dream] [--stufen S,S] [--limit N]
              [--klassen transkript,worker,doku,memory] [--projekt P]
              [--dry-run [--mit-modell]] [--json] [--budget-minutes N] [--remote HOST]
                          # die eine lokale Pipeline (Brain 5): eine Sperre, eine
                          # Lauf-ID, ein Bericht, ein Commit. Profil `lehren` =
                          # Ernte -> Detektor -> Extraktion -> Abgleich -> Schreiben
                          # (nur Vorschlaege). --dry-run laedt kein Modell und
                          # schreibt nichts; --mit-modell misst dabei die Modellstufen.
                          # --json: Ereigniszeilen + Abschlussobjekt (Brain.app)
    brain runner --klon <vault-klon> (--einmal | --bis-leer) [--dienst URL]
                 [--token-datei F] [--space S] [--push] [--ohne-doctor]
                          # holt Pipeline-Jobs der Brain-App beim Brain-Dienst ab
                          # und fuehrt `brain run --json` im eigenen Klon aus
                          # (braincli/runner.py); kein Dauerprozess
    brain abo-bruecke [pruefen] (--einmal | --bis-leer | --dauer 2h) [--dienst URL]
                 [--token-datei F] [--programme claude,codex,opencode]
                          # beantwortet Brain-Chat-Auftraege der eigenen Person mit
                          # dem eigenen Abo (claude -p, codex exec, opencode run)
                          # auf diesem Rechner (braincli/abo_bruecke.py)
    brain pipeline run [--dry-run] [--verbose] [--budget-minutes N]
                          # Alias: brain run --profil all
                          # die ganze Kette in einem Befehl: erst der Gaertner
                          # (alle Phasen), dann der Traum (`dream run`).
                          # --dry-run prueft nur (Speicher, Modelle lokal
                          # vorhanden, Sperre, Vault-Sauberkeit, grobe
                          # Dauer-Schaetzung) und startet nichts.
                          # --budget-minutes ueberschreibt das Gaertner-
                          # Zeitbudget nur fuer diesen Lauf (Voreinstellung
                          # unveraendert, siehe `gardener run --help`).
    brain gardener run [--phase embed|linking|consolidate|maintain|synth|all] [--dry-run]
                       # --phase embed: nur den Einbettungs-Index neu bauen,
                       #   ohne Bericht, Commit oder Schreibzugriff auf Notizen
                       [--audit] [--topic T] [--min-notes N] [--budget-minutes N]
    brain gardener status [--json]
    brain dream run [--limit N] [--dry-run] [--json]   # Alias: brain run --profil dream
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
    brain index nachbetten     # veraltete Notizen jetzt nachbetten (wie der Commit-Hook)
    brain server status [--frisch] [--json]
    brain server waehlen [--still] [--frisch]
                          # Client-Fallback (F6): peer oder my-server-Standby per
                          # /health pruefen (2 s je Server, Ergebnis 10 min
                          # zwischengespeichert) und Git repo-lokal per
                          # url.<standby>.insteadOf umleiten bzw. zurueck
                          # (braincli/server.py, Liste in braincli/server.json)
    brain stats [--json]
    brain pruefen <notiz> [--von HANDLE] [--dry-run]
                          # kanonische Seite (type system|decision|pitfall|term, KERN/STATUS)
                          # als geprueft markieren: verified, verified-by, review-after +3 Monate;
                          # nur Frontmatter; verweigert Sessions, secrets, fremde Autoren
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
import time
from pathlib import Path

from gardener import config
from gardener import contradict as contradict_mod
from gardener import mlx_server
from gardener import sidecar as sidecar_mod
from gardener import spaces as spaces_mod
from gardener.grug_client import GrugJudgeClient
from gardener.linking import embed_notes
from gardener.ollama import OllamaClient, OllamaError, OllamaUnavailable
from gardener.runtime import Deadline, LockHeldError
from gardener.store import Store
from gardener.vault import VaultWriter, load_notes

from . import (abo_bruecke as abo_mod, frage as frage_mod, gardener_wrap, ingest as ingest_mod,
               pipeline as pipeline_mod, search as search_mod, stats as stats_mod,
               doctor as doctor_mod, runner as runner_mod, server as server_mod,
               kontext as kontext_mod, pruefen as pruefen_mod, rerank as rerank_mod,
               eval_gate as eval_gate_mod, llm_sort as llm_sort_mod, rangkern,
               hinweis as hinweis_mod)

DEFAULT_VAULT = config.DEFAULT_VAULT


def _protokolliere_suche(vault: Path, query: str, hits: list, dauer_ms: float,
                        fallback: bool) -> None:
    """Nutzungsprotokoll, Kanal search (Firmenniveau-Plan M3). Ruft der Recall-Hook die Suche
    (BRAIN_NUTZUNGSLOG_QUELLE=hook), protokolliert er selbst als Kanal recall."""
    if os.environ.get("BRAIN_NUTZUNGSLOG_QUELLE") == "hook":
        return
    from . import nutzungslog
    nutzungslog.protokolliere(
        "search", vault, anfrage=query, treffer=[(h.rel, h.score) for h in hits],
        grund=None if hits else "keine_treffer", dauer_ms=dauer_ms, rolle_=nutzungslog.rolle(),
        detail="fallback" if fallback else None)


def cmd_search(args) -> int:
    vault = Path(args.vault)
    # --rerank/--no-rerank gewinnt, sonst der Standard (BRAIN_SEARCH_RERANK); vor dem warmen Weg,
    # damit beide Wege dasselbe tun.
    if getattr(args, "rerank", None) is None:
        args.rerank = rerank_mod.search_default()
    # Erst der warme Suchprozess (warm.py, E4 vom 28.09.); None heisst: kalter Weg wie bisher.
    from . import warm
    rc = warm.try_search(vault, args)
    if rc is not None:
        return rc
    validity = False if getattr(args, "no_validity", False) else None
    reranking = bool(getattr(args, "rerank", False))
    # LLM-Listensortierung (BRAIN_SEARCH_LLM, llm_sort) nur hinter dem Reranker: der Recall-Hook
    # ruft --no-rerank und bekommt sie also nie.
    llm_info: dict = {}
    llm = llm_sort_mod.aktiv(reranking, llm_info)
    pool = llm_sort_mod.POOL if llm else rerank_mod.TOP_N
    stand_token = rangkern.STAND_MIT_LLM.set(llm)
    try:
        return _cmd_search_kalt(args, vault, validity, reranking, llm, pool, llm_info)
    finally:
        rangkern.STAND_MIT_LLM.reset(stand_token)


def _cmd_search_kalt(args, vault: Path, validity, reranking: bool, llm: bool, pool: int,
                     llm_info: dict) -> int:
    t0 = time.perf_counter()
    hits, used_fallback = search_mod.search(
        vault, args.query, max(args.k, pool) if reranking else args.k, validity,
        getattr(args, "space", None))
    rerank_info: dict = {}
    werte = hinweis_mod.Werte()
    hinweis_an = reranking and hinweis_mod.enabled()
    hinweis_text = hinweis_sig = None
    if reranking:
        passage = rerank_mod.vault_passage(vault)
        hits = rerank_mod.umsortieren(args.query, hits, passage,
                                      url=rerank_mod.cli_url(), budget_s=rerank_mod.cli_budget_s(),
                                      info=rerank_info, top_n=pool, werte=werte)
        if llm:
            hits = llm_sort_mod.sortieren(args.query, hits, passage, lambda h: h.rel, info=llm_info)
        # Standseiten nach dem Umsortieren wieder vorn (BRAIN_SEARCH_STAND, rangkern)
        hits = rangkern.apply_stand_rang(hits, args.query, top_n=rerank_mod.TOP_N)[:args.k]
        # Hinweis bei unsicherem Platz 1 (BRAIN_SEARCH_HINWEIS, hinweis.py): liest nur, ordnet nichts um.
        if hinweis_an:
            hinweis_text, hinweis_sig = hinweis_mod.bewerten(hits, werte, llm_info, llm_sort_mod.abgeloest)
            if hinweis_sig and hinweis_mod.signale_gewuenscht():  # Messlauf: BGE-Reihenfolge fuer die Dienst-Sicht
                hinweis_sig["bge_reihe"] = [h.rel for h in werte.reihe[:10]]
    _protokolliere_suche(vault, args.query, hits, (time.perf_counter() - t0) * 1000, used_fallback)
    # Suchkorpus aus der Suche selbst wiederverwenden (nur fuer eigene Indizes
    # relevant; embeddinggemma prueft gegen den Gaertner-Korpus).
    idx = stats_mod.index_health(vault, notes=list(search_mod.LAST_NOTES))
    if args.json:
        # Compact (no indent): this payload is read by agents/hooks far more
        # often than by a human eye, and pretty-print whitespace alone was
        # roughly a third of its token cost. See search.hit_to_json for the
        # other half (dropping always-default optional fields).
        print(json.dumps({
            "query": args.query,
            "fallback": used_fallback,
            "index_stale": idx["stale"],
            "index_stale_reasons": idx["reasons"],
            # Modell der semantischen Seite ("" = nur BM25); die cosine-Werte
            # der Treffer sind nur innerhalb eines Modells vergleichbar.
            "embed_model": search_mod.LAST_EMBED["modell"],
            **({"embed_model_fallback": search_mod.LAST_EMBED["grund"]}
               if search_mod.LAST_EMBED["grund"] else {}),
            **({"rerank": rerank_info} if reranking else {}),
            **({"llm_sort": llm_info} if llm_info else {}),
            **(hinweis_mod.json_felder(hinweis_text, hinweis_sig) if hinweis_an else {}),
            "hits": [search_mod.hit_to_json(h) for h in hits],
        }, ensure_ascii=False))
        return 0
    if idx["stale"]:
        print("[!] Such-Index veraltet auf dieser Maschine - semantischer Treffer "
              "kann fehlen oder daneben liegen:")
        for reason in idx["reasons"]:
            print(f"    {reason}")
        print(f"    -> `{idx.get('fix', 'brain gardener run')}` nachziehen. `brain stats` fuer Details.\n")
    if search_mod.LAST_EMBED["grund"]:
        print(f"[!] {search_mod.LAST_EMBED['grund']} - semantische Suche lief mit "
              f"{search_mod.LAST_EMBED['modell']}; `brain index bauen` baut ihn.\n")
    if reranking and rerank_info.get("grund"):
        print(f"[!] Umsortieren aus ({rerank_info['grund']}) - Reihenfolge des Rangkerns.\n")
    if llm_info.get("grund") == "gesamtlauf":
        print("[!] ohne LLM-Sortierung (Gesamtlauf aktiv) - Reihenfolge des Rerankers; "
              "BRAIN_SEARCH_LLM=1 erzwingt sie.\n")
    elif llm_info.get("grund"):
        print(f"[!] LLM-Sortierung aus ({llm_info['grund']}) - Reihenfolge des Rerankers.\n")
    if used_fallback:
        print("Ollama nicht erreichbar - rg-Volltextsuche als Fallback:\n")
    if not hits:
        print("Keine Treffer.")
        return 0
    for h in hits:
        flag = "[!] " if h.contradiction else ""
        flag += "[~] " if h.retired or h.status else ""
        space_tag = f" ({h.space})" if h.space and h.space != "kern" else ""
        print(f"{flag}{h.rel}{space_tag}")
        if h.title:
            tag = f" [{h.match}]" if h.match else ""
            print(f"  Titel: {h.title}  (score {h.score:.3f}){tag}")
        if h.contradiction:
            print("  [!] traegt einen offenen Widerspruch - siehe review-queue.md")
        if h.status:
            print(f"  [~] {_status_zeile(h)}")
        if h.match == "nachfolger":
            print("  [+] Nachfolger eines abgeloesten Treffers, eingereiht")
        if h.retired:
            verb = "ist" if h.retired_claims == 1 else "sind"
            seit = f" (zuletzt {h.retired_since})" if h.retired_since else ""
            print(f"  [~] {h.retired_claims} von {h.total_claims} Aussagen dieser "
                  f"Notiz {verb} abgeloest{seit} - der Text steht noch da, gilt "
                  f"aber nicht mehr.")
        if h.snippet:
            print(f"  {h.snippet}")
        print()
    if hinweis_text:
        print(hinweis_text)
    return 0


def _status_zeile(h) -> str:
    """Frontmatter-Gueltigkeit eines Treffers als eine Zeile."""
    if h.superseded_by:
        ziele = ", ".join(f"[[{t}]]" for t in h.superseded_by)
        return f"abgelöst durch {ziele} - der Text steht noch da, gilt aber nicht mehr."
    if h.status == "archived":
        return "archiviert - nur zur Herkunft, gilt nicht mehr."
    if h.status == "expired":
        return "abgelaufen (valid-until) - gilt nicht mehr."
    return "abgelöst - der Text steht noch da, gilt aber nicht mehr."


def cmd_index_bauen(args) -> int:
    from . import einbettung
    vault = Path(args.vault)
    modell = einbettung.aktives_modell(args.modell)
    if not modell.eigener_index:
        print(f"{modell.name} nutzt den Gaertner-Index: `brain gardener run --phase embed`.",
              file=sys.stderr)
        return 2
    t0 = dt.datetime.now()

    def fortschritt(i, n):
        print(f"  {i}/{n} Notizen", file=sys.stderr, flush=True)

    try:
        stand = einbettung.bauen(vault, modell, voll=args.voll, fortschritt=fortschritt)
    except OllamaError as e:
        print(f"Index nicht gebaut, alter Stand bleibt: {e}", file=sys.stderr)
        return 1
    stand["sekunden"] = round((dt.datetime.now() - t0).total_seconds(), 1)
    stand["modell"] = modell.name
    if args.json:
        print(json.dumps(stand, ensure_ascii=False))
    else:
        print(f"{modell.name}: {stand['notizen']} Notizen ({stand['uebernommen']} uebernommen, "
              f"{stand['eingebettet']} neu) in {stand['sekunden']} s -> {stand['pfad']}")
        for f in stand["fehlgeschlagen"]:
            print(f"  fehlgeschlagen: {f}")
    return 1 if stand["fehlgeschlagen"] else 0


def cmd_index_nachbetten(args) -> int:
    from . import nachbetten
    return nachbetten.main(["--vault", str(args.vault), "--sofort"])


def cmd_index_status(args) -> int:
    from . import einbettung
    vault = Path(args.vault)
    modell = einbettung.aktives_modell(args.modell)
    health = stats_mod.index_health(vault, modell=modell)
    kopf = (einbettung.lies_kopf(einbettung.index_pfad(vault, modell))
            if modell.eigener_index else {})
    out = {"modell": modell.name, "aktiv": einbettung.aktives_modell().name,
           "kopf": kopf, **health}
    if args.json:
        print(json.dumps(out, ensure_ascii=False))
        return 0
    print(f"Modell: {modell.name} (aktiv: {out['aktiv']})")
    for k in ("ollama", "ollama_digest", "dimension", "erstellt", "notizen"):
        if k in kopf:
            print(f"  {k}: {kopf[k]}")
    print(f"  veraltet: {health['stale_notes_total']}/{health['embed_corpus_total']}")
    for r in health["reasons"]:
        print(f"  [!] {r}")
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

    # `client` bleibt bei Ollama - nur fuer die Embeddings (embeddinggemma)
    # und die 48-GB-Vorpruefung. Das eigentliche Urteil (judge_pair) laeuft
    # seit Auftrag "startklar" (03.09.2026) ueber `smart` (Qwen3.8-27B via
    # MLX, siehe grug_client.GrugJudgeClient) - contradict.judge_pair's
    # Aufgabe gehoert zur SMART-Klasse aus denselben Gruenden wie linking,
    # siehe gardener/config.py bei CONTRADICT_TOP_K und contradict.py's
    # Modul-Docstring ("die Judge ist ein 9B lokales Modell und erfindet
    # froehlich ein plausibel klingendes Zitat").
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

    checkable = [n for n in to_check if n.rel in vectors]

    # Nur provisionieren, wenn tatsaechlich etwas zu urteilen ist - ein
    # `--queue`-Lauf mit lauter unbekannten Notizen braucht den MLX-Server
    # nie. Eigentuemerschaft wie beim Gaertner (gardener/mlx_server.py):
    # `release()` beendet nur einen Server, den DIESER Aufruf selbst
    # provisioniert hat, nie einen, den jemand anders gerade benutzt.
    smart = GrugJudgeClient()
    mlx_owned = False   # only set True by a successful ensure() - release()
                       # below must stay a no-op otherwise, same rule as
                       # gardener/cli.py's five smart phases
    try:
        if checkable:
            try:
                mlx_owned = mlx_server.ensure()
            except mlx_server.MlxServerError as e:
                # Sichtbar und mit Grund, nicht dasselbe stille Uebergehen
                # wie ein Modell, das mitten im Lauf ausfaellt (Auftrag
                # "startklar", 03.09.2026, Punkt 1b) - contradict hat keine
                # modellfreie Teilarbeit, auf die es ausweichen koennte, also
                # bricht der Befehl hier klar ab statt "0 Befunde"
                # vorzutaeuschen.
                print(f"MLX-Server konnte nicht bereitgestellt werden: {e}")
                return 2
        cstore = contradict_mod.ContradictionStore(vault / config.CONTRADICTIONS_FILE)
        result = contradict_mod.run_contradict(
            checkable, notes, vectors, smart, cstore,
            top_k=args.k, deadline=deadline)
    except OllamaUnavailable as e:
        # Unterscheidet sich bewusst von der MlxServerError oben: der Server
        # ist hier erfolgreich gestartet und erst WAEHREND des Laufs
        # gestorben - "ist unterwegs gestorben" statt "konnte nicht starten"
        # (Auftrag "startklar", Punkt 1b, sinngemaess auch fuer contradict).
        print(f"MLX-Server ist waehrend des Laufs ausgefallen: {e}")
        return 2
    finally:
        mlx_server.release(mlx_owned)

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


def cmd_pipeline_run(args) -> int:
    vault = Path(args.vault)
    return pipeline_mod.run(vault, dry_run=args.dry_run, verbose=args.verbose,
                            budget_minutes=getattr(args, "budget_minutes", None),
                            json_mode=getattr(args, "json", False))


def cmd_run(args) -> int:
    from gardener.lauf import lauf as lauf_mod
    vault = Path(args.vault)
    if args.aktion == "abgleich-nachlauf":
        if not args.bis_lauf:
            print("brain run abgleich-nachlauf: --bis-lauf <lauf-id> fehlt", file=sys.stderr)
            return 2
        try:
            info = lauf_mod.abgleich_nachlauf(vault, args.bis_lauf, dry_run=args.dry_run)
        except (ValueError, LockHeldError) as exc:
            print(f"brain run abgleich-nachlauf: {exc}", file=sys.stderr)
            return 4 if isinstance(exc, LockHeldError) else 2
        if args.json:
            print(json.dumps(info, ensure_ascii=False))
            return 0
        print(f"{'wuerde zuruecksetzen' if args.dry_run else 'zurueckgesetzt'}: "
              f"{info['pakete']} Pakete, {info['einheiten']} Einheiten (bis Lauf {info['bis_lauf']})")
        if not args.dry_run:
            print("weiter mit: brain run --profil lehren --stufen abgleichen,schreiben")
        return 0
    if args.aktion == "uebernehmen":
        from gardener.lauf import uebernehmen as ueb_mod
        from gardener.lauf.freigabe import NichtBerechtigt
        listen = [Path(x) for x in args.liste] if args.liste else None
        ok = [t for x in args.ok for t in x.replace(",", " ").split()] if args.ok else None
        try:
            info = lauf_mod.uebernehmen(vault, ok=ok, dry_run=args.dry_run, listen=listen,
                                        zellen=Path(args.zellen) if args.zellen else None,
                                        buch=Path(args.buch) if args.buch else None,
                                        einbetten=not args.ohne_einbettung)
        except NichtBerechtigt as exc:
            print(f"brain run uebernehmen: {exc}", file=sys.stderr)
            return 3
        except (ValueError, LockHeldError) as exc:
            print(f"brain run uebernehmen: {exc}", file=sys.stderr)
            return 4 if isinstance(exc, LockHeldError) else 2
        if args.json:
            print(json.dumps(info, ensure_ascii=False, indent=2))
            return 0
        if info["modus"] == "vorschlaege":
            print(f"Vorschlaege zur Uebernahme: {len(info['vorschlaege'])} (nichts geschrieben; "
                  "uebernehmen nur ein Orchestrator oder der Mensch: brain run uebernehmen --ok <id>[,<id>]")
            for v in info["vorschlaege"]:
                h = v["herkunft"]
                print(f"- {v['id']}  {v['projekt']}/{v['typ']} -> {v['ziel']}  Auswahl: {v['auswahl']}")
                print(f"    Herkunft: {h['klasse']} {h['pfad']} ({h['einheit']})")
                print(f"    {v['aussage']}" + (f"  | Gegenmittel: {v['gegenmittel']}" if v["gegenmittel"] else ""))
            if info["uebersprungen"]:
                print("uebersprungen: " + ", ".join(f"{k} {v}" for k, v in sorted(info["uebersprungen"].items())))
            return 0
        print(f"Freigabe: {info['freigabe']}")
        wort = "wuerde uebernehmen" if args.dry_run else "uebernommen"
        print(f"{wort}: {info['uebernommen']} Pakete, Duplikate zusammengefuehrt: {info['duplikate']}"
              f" (Einbettung: {'ja' if info['einbettung'] else 'nein, nur Textgleichheit'})")
        if info["zellen"]:
            print("belegte Zellen: " + ", ".join(info["zellen"]))
        for rel, arten in sorted(info["je_datei"].items()):
            print(f"  {rel}: " + ", ".join(f"{k} {v}" for k, v in sorted(arten.items())))
        for rel in info["kern_voll"]:
            print(f"  {rel}: nichts unter ## Gilt (Grenze {ueb_mod.KERN_MAX} Zeichen, KERN.md fehlt "
                  "oder schon vorhanden)")
        for rel, why in info["verweigert"]:
            print(f"  NICHT geschrieben: {rel} ({why})")
        for item in info["handkorrekturen"]:
            fields = ", ".join(item["felder"])
            action = "Handkorrektur aufgehoben" if item.get("aufgehoben") else "Handkorrektur behalten"
            print(f"  {action}: {item['datei']} {item['paket_id']} ({fields})")
        for item in info["unzugeordnet"]:
            print(f"  unzugeordnet behalten: {item['datei']} {item.get('id', item.get('zeile'))}")
        for item in info["wiederhergestellt"]:
            print(f"  wiederhergestellt: {item['datei']} {item['paket_id']} (aus: {item['aus']})")
        if info["uebersprungen"]:
            print("uebersprungen: " + ", ".join(f"{k} {v}" for k, v in sorted(info["uebersprungen"].items())))
        # Wie Befund 12 (14.10.2026): ein gescheiterter Commit gilt nicht als Erfolg.
        fehl = [c for c in info.get("commits") or [] if c.get("error")]
        for c in fehl:
            print(f"  NICHT committet: {c.get('repo') or '.'} ({c['error']})")
        return 0 if not info["verweigert"] and not fehl else 1
    if args.aktion == "status":
        info = lauf_mod.status(vault)
        if args.json:
            print(json.dumps(info, ensure_ascii=False, indent=2, default=str))
            return 0
        print(f"laeuft: {info['laeuft']}")
        print("Einheiten: " + (", ".join(f"{k} {v}" for k, v in info["einheiten"].items()) or "keine"))
        print("Pakete: " + (", ".join(f"{k} {v}" for k, v in info["pakete"].items()) or "keine"))
        last = info.get("letzter_lauf")
        if last:
            print(f"letzter Lauf: {last.get('lauf_id')} [{last.get('profil')}] {last.get('status')}"
                  f" -> {last.get('bericht')}")
        return 0
    lauf_mod.main_signals()
    stufen = [s.strip() for s in args.stufen.split(",") if s.strip()] if args.stufen else None
    gardener_args = {"phase": args.phase, "audit": args.audit, "verbose": args.verbose,
                     "topic": args.topic, "min_notes": args.min_notes}
    klassen = [k.strip() for k in args.klassen.split(",") if k.strip()] if args.klassen else None
    try:
        lauf_mod.klassen_aus(klassen)
    except ValueError as exc:
        print(f"brain run: {exc}", file=sys.stderr)
        return 2
    return lauf_mod.run(vault, profil=args.profil, stufen=stufen, limit=args.limit,
                        dry_run=args.dry_run, mit_modell=args.mit_modell, json_mode=args.json,
                        budget_minutes=args.budget_minutes, remote=args.remote,
                        gardener_args=gardener_args, klassen=klassen, projekt=args.projekt)


def cmd_gardener_run(args) -> int:
    vault = Path(args.vault)
    return gardener_wrap.run(vault, phase=args.phase, dry_run=args.dry_run,
                             audit=args.audit, verbose=args.verbose,
                             topic=getattr(args, "topic", None),
                             min_notes=getattr(args, "min_notes", None),
                             budget_minutes=getattr(args, "budget_minutes", None))


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


def cmd_spaces_status(args) -> int:
    vault = Path(args.vault)
    entries = spaces_mod.status(vault)
    if not entries:
        print("Kein Manifest (.brain/spaces.lock) - `brain spaces sync` ausfuehren.")
        return 0
    for s in entries:
        detail = f" {s.detail}" if s.detail else ""
        print(f"{s.name}  [{s.mount}]  {s.state}{detail}")
    return 0


def cmd_spaces_sync(args) -> int:
    vault = Path(args.vault)
    try:
        result = spaces_mod.sync(vault, dry_run=args.dry_run,
                                 manifest_only=args.manifest_only,
                                 push=args.push)
    except (spaces_mod.SpaceConfigError, spaces_mod.ForgejoError) as e:
        print(f"FEHLER: {e}")
        return 1
    # Der Timer (--push) zieht auch die Kern-Arbeitskopie per Fast-Forward nach (09.10.2026, spaces.kern_vorziehen).
    if args.push and not args.dry_run and not args.manifest_only:
        result.outcomes.insert(0, spaces_mod.kern_vorziehen(vault))
    for o in result.outcomes:
        detail = f": {o.detail}" if o.detail else ""
        print(f"{o.name}  [{o.mount}]  {o.action}{detail}")
    if not result.outcomes:
        print("Keine Spaces (weder Forgejo-Umgebung noch .brain/spaces.yml).")
    return 0 if result.ok else 1


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
    excluded = result.get("notes_excluded_by_reason") or {}
    excluded_total = sum(excluded.values())
    if excluded_total:
        print(f"  auf der Platte, aber nicht mitgezaehlt: {excluded_total}")
        for reason, n in sorted(excluded.items(), key=lambda kv: -kv[1]):
            print(f"    {reason}: {n}")
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
    idx = result["index_health"]
    if idx["stale"]:
        print("Such-Index: VERALTET")
        for reason in idx["reasons"]:
            print(f"  {reason}")
        print("  -> `brain index nachbetten` auf dieser Maschine nachziehen.")
    else:
        print(f"Such-Index: aktuell ({idx['vectors_total']} Vektoren, "
              f"{idx['stale_notes_total']}/{idx['embed_corpus_total']} veraltet)")
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
    p_search.add_argument("--space", default=None,
                          help="nur Treffer aus diesem Space (`kern` fuer die "
                               "Wurzel); braucht .brain/spaces.lock "
                               "(`brain spaces sync`)")
    p_search.add_argument("--rerank", action="store_true", default=None,
                          help="Top 20 vom Umsortier-Dienst auf peer umsortieren lassen "
                               "(BRAIN_RERANK_URL, Budget BRAIN_RERANK_BUDGET_MS=1000); "
                               "bei Stoerung unveraenderte Reihenfolge. Standard seit 29.09. "
                               "(BRAIN_SEARCH_RERANK=0 schaltet ab). Danach ordnet haiku per `claude -p` "
                               "die Top 30 (BRAIN_SEARCH_LLM=0 schaltet ab, ~2 s)")
    p_search.add_argument("--no-rerank", dest="rerank", action="store_false",
                          help="ohne Umsortier-Dienst (Reihenfolge des Rangkerns)")
    p_search.set_defaults(func=cmd_search)
    p_frage = frage_mod.argumente(sub.add_parser(
        "frage", help="kurze Antwort mit pfad:zeile-Zitaten (Motor peer oder claude)"))
    p_frage.set_defaults(func=frage_mod.cmd_frage)

    p_run = sub.add_parser(
        "run", help="the one local pipeline (gardener care + lessons), see `brain run --help`")
    p_run.add_argument("aktion", nargs="?", choices=["status", "abgleich-nachlauf", "uebernehmen"],
                       default=None,
                       help="status: Buch und letzten Lauf zeigen (nur lesend); abgleich-nachlauf: "
                            "Pakete aus Laeufen bis --bis-lauf wieder auf `neu` setzen (nur Status, "
                            "nichts geloescht), danach --stufen abgleichen,schreiben; uebernehmen: "
                            "ohne --ok nur die Vorschlagsliste mit Herkunft (cloud-geprueft, Zellen); "
                            "mit --ok <id> genau diese Pakete in FALLEN.yaml, Entscheidungsnotiz und "
                            "KERN -- nur ein Orchestrator oder der Mensch (gemessen, der Nutzer 10.10.)")
    p_run.add_argument("--ok", action="append", default=None,
                       help="mit uebernehmen: Paket-IDs (brain-<id> oder Praefix ab 10 Zeichen, mehrfach "
                            "oder mit Komma), die uebernommen werden; nur Orchestrator oder Mensch")
    p_run.add_argument("--liste", action="append", default=None,
                       help="mit uebernehmen: Datei mit einzeln geprueften Paket-IDs (mehrfach; Vorgabe "
                            "eval/vorschlaege-stichprobe/richtig.tsv und eval/vorschlaege-qualitaet/"
                            "kontrolle-richtig.tsv)")
    p_run.add_argument("--zellen", default=None,
                       help="mit uebernehmen: Zellen-Beleg (JSON) der Kontrollstichprobe; nur Zellen mit "
                            ">= 90 %% und Untergrenze >= 0,8 zaehlen")
    p_run.add_argument("--buch", default=None,
                       help="mit uebernehmen --dry-run: eine Buchkopie statt state/dream/dream.db lesen")
    p_run.add_argument("--ohne-einbettung", action="store_true",
                       help="mit uebernehmen: Duplikate nur ueber Textgleichheit zusammenfuehren")
    p_run.add_argument("--bis-lauf", default=None,
                       help="mit abgleich-nachlauf: letzte Lauf-ID, deren Pakete neu abgeglichen werden")
    p_run.add_argument("--profil", choices=["all", "gardener", "lehren", "dream"], default="all")
    p_run.add_argument("--stufen", default=None,
                       help="nur diese Stufen, Komma-getrennt: gardener, ernte, erkennen, "
                            "extrahieren, grossmodell, projektwahl, abgleichen, pruefen, schreiben")
    p_run.add_argument("--limit", type=int, default=None, help="hoechstens N Einheiten je Stufe")
    p_run.add_argument("--klassen", default=None,
                       help="nur diese Quellklassen, Komma-getrennt: transkript, worker, doku, memory "
                            "(Vorgabe alle; Reihenfolge immer memory, transkript neueste zuerst, "
                            "worker, doku, darin a machine-bound project zuerst)")
    p_run.add_argument("--projekt", default=None,
                       help="nur Einheiten dieses Vault-Projekts (20-projects/<p>) bearbeiten; "
                            "die Ernte bleibt vollstaendig")
    p_run.add_argument("--dry-run", action="store_true",
                       help="nichts schreiben, kein Modell laden (Buch nur im Speicher)")
    p_run.add_argument("--mit-modell", action="store_true",
                       help="mit --dry-run: Modellstufen trotzdem rechnen (Zeitmessung), "
                            "weiterhin ohne jeden Schreibzugriff")
    p_run.add_argument("--json", action="store_true",
                       help="Ereigniszeilen (JSON) auf stdout, zuletzt ein Abschlussobjekt")
    p_run.add_argument("--budget-minutes", type=float, default=None)
    p_run.add_argument("--remote", default=None,
                       help="auch Transkripte und Auto-Memory dieser Maschine per ssh ernten "
                            "(nur lesend), z.B. peer")
    p_run.add_argument("--phase", choices=list(gardener_wrap.VALID_PHASES), default="all",
                       help="Gaertner-Phase fuer Profil gardener/all")
    p_run.add_argument("--audit", action="store_true")
    p_run.add_argument("--topic", default=None)
    p_run.add_argument("--min-notes", type=int, default=None)
    p_run.add_argument("--verbose", action="store_true")
    p_run.set_defaults(func=cmd_run)

    p_pipeline = sub.add_parser(
        "pipeline", help="alias of `brain run --profil all`")
    pipesub = p_pipeline.add_subparsers(dest="pcmd", required=True)

    p_prun = pipesub.add_parser(
        "run", help="run the full chain, or --dry-run to only check readiness")
    p_prun.add_argument("--dry-run", action="store_true",
                        help="check readiness only (memory, models present, "
                             "lock, vault cleanliness, duration estimate) - "
                             "starts nothing")
    p_prun.add_argument("--verbose", action="store_true")
    p_prun.add_argument("--json", action="store_true")
    p_prun.add_argument("--budget-minutes", type=float, default=None,
                        help="override the gardener's time budget for this "
                             "run only (default: unchanged, see "
                             "`gardener run --help`)")
    p_prun.set_defaults(func=cmd_pipeline_run)

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
    p_grun.add_argument("--budget-minutes", type=float, default=None,
                        help="Zeitbudget nur fuer diesen Lauf ueberschreiben "
                             "(Vorgabe unveraendert, siehe `gardener run --help`) "
                             "- der direktere Weg fuer einen langen Nachlauf, "
                             "wenn der Traum nicht mitlaufen soll")
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

    p_spaces = sub.add_parser(
        "spaces", help="other git repos mounted inside this vault (S1)")
    spsub = p_spaces.add_subparsers(dest="spcmd", required=True)

    p_sp_status = spsub.add_parser(
        "status", help="clean/ahead/behind je gemountetem Space")
    p_sp_status.set_defaults(func=cmd_spaces_status)

    p_sp_sync = spsub.add_parser(
        "sync", help="fehlende Spaces klonen, vorhandene ff-only aktualisieren")
    p_sp_sync.add_argument("--dry-run", action="store_true",
                           help="nur pruefen, nichts klonen/aktualisieren/schreiben")
    p_sp_sync.add_argument("--manifest-only", action="store_true",
                           help="Manifest + .gitignore aus dem aktuellen Stand "
                                "neu schreiben, ohne zu klonen oder zu aktualisieren")
    p_sp_sync.add_argument("--push", action="store_true",
                           help="in beide Richtungen abgleichen: eigene Commits pushen, bei "
                                "beidseitigen Aenderungen rebasen (nie force, nie ungesicherte "
                                "Arbeit anfassen); fuer den Timer (Nr. 42)")
    p_sp_sync.set_defaults(func=cmd_spaces_sync)

    p_index = sub.add_parser(
        "index", help="eigener Such-Index je Einbettungsmodell (BRAIN_EMBED_MODELL)")
    isub = p_index.add_subparsers(dest="index_cmd", required=True)
    p_ibau = isub.add_parser("bauen", help="Index des Modells neben dem alten bauen, dann atomar tauschen")
    p_ibau.add_argument("--modell", default=None,
                        help="Vorgabe: BRAIN_EMBED_MODELL bzw. Standard; z.B. qwen3-embedding-0.6b")
    p_ibau.add_argument("--voll", action="store_true",
                        help="alles neu einbetten statt unveraenderte Vektoren zu uebernehmen")
    p_ibau.add_argument("--json", action="store_true")
    p_ibau.set_defaults(func=cmd_index_bauen)
    p_istat = isub.add_parser("status", help="Kopf und Veraltung des Index (nur lesend)")
    p_istat.add_argument("--modell", default=None)
    p_istat.add_argument("--json", action="store_true")
    p_istat.set_defaults(func=cmd_index_status)
    p_inach = isub.add_parser("nachbetten", help="veraltete Notizen jetzt nachbetten (wie der Commit-Hook)")
    p_inach.set_defaults(func=cmd_index_nachbetten)

    p_stats = sub.add_parser("stats", help="vault health stats")
    p_stats.add_argument("--json", action="store_true")
    p_stats.set_defaults(func=cmd_stats)

    p_doctor = sub.add_parser("doctor", help="compact vault ageing signals")
    p_doctor.add_argument("--json", action="store_true")
    p_doctor.add_argument("--cache", action="store_true",
                          help="write the machine-readable doctor cache")
    p_doctor.set_defaults(func=lambda args: doctor_mod.run(Path(args.vault), args.json))

    runner_mod.add_parser(sub)
    abo_mod.add_parser(sub)
    server_mod.add_parser(sub)
    kontext_mod.add_parser(sub)
    pruefen_mod.add_parser(sub)
    eval_gate_mod.add_parser(sub)

    p_mcp = sub.add_parser("mcp", help="read-only MCP server over a vault (stdio)")
    p_mcp.set_defaults(func=lambda args: __import__(
        "braincli.mcp_server", fromlist=["main"]).main(["--vault", args.vault]))

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
    if rest[0] == "run":
        return _dream_run_alias(Path(args.vault), rest[1:])
    return dream_main(rest)


def _dream_run_alias(vault: Path, rest: list[str]) -> int:
    """`brain dream run` = `brain run --profil dream` (Brain 5). The old
    cloud/budget flags have no meaning in the local pipeline and are ignored
    with a note; the individual dream steps stay reachable as before."""
    from gardener.lauf import lauf as lauf_mod
    p = argparse.ArgumentParser(prog="brain dream run")
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--mit-modell", action="store_true")
    p.add_argument("--json", action="store_true")
    p.add_argument("--budget-minutes", type=float, default=None)
    p.add_argument("--remote", default=None)
    p.add_argument("--vault", default=None)
    args, unknown = p.parse_known_args(rest)
    if unknown:
        print(f"brain dream run: ignoriert (lokale Pipeline): {' '.join(unknown)}", file=sys.stderr)
    lauf_mod.main_signals()
    return lauf_mod.run(Path(args.vault) if args.vault else vault, profil="dream", limit=args.limit,
                        dry_run=args.dry_run, mit_modell=args.mit_modell, json_mode=args.json,
                        budget_minutes=args.budget_minutes, remote=args.remote)


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(eval_gate_mod.trenner(list(sys.argv[1:] if argv is None else argv)))
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
