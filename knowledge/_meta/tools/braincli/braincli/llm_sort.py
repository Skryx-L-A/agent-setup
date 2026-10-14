"""LLM-Listensortierung nach dem Reranker (b10-llm-sort, 29.09.2026).

Stufen der Suche mit `BRAIN_SEARCH_LLM=1` (gemeinsam fuer `brain search` und den Dienst):
Rangkern-Fusion Top `POOL` (50) -> BGE-Reranker ueber alle `POOL` -> die ersten `tiefe()` (30)
ordnet ein Claude-Modell als Liste neu -> Stand-Weiche (`rangkern.apply_stand_rang`; mit dieser Stufe an,
ausser `BRAIN_SEARCH_STAND=0`). Danach stehen abgeloeste Notizen hinter den gueltigen (`BRAIN_SEARCH_LLM_GUELTIG=0` schaltet das ab).

Der Aufruf ist der magere `claude -p` (Abo, ohne Hooks, Einstellungen, Werkzeuge, MCP und
Denkbudget; API-Schluessel werden aus der Umgebung entfernt, wie in `abo_bruecke`). Frist
`BRAIN_SEARCH_LLM_FRIST_MS`; bei jeder Stoerung (Programm fehlt, Frist, Fehler, Antwort ohne
Nummern) bleibt die Reihenfolge des Rerankers, der Grund steht in `info["grund"]`.

Messung auf Dev: `_meta/tools/eval/ziel/BEFUNDE.md` (b9) und `_meta/tools/eval/llm-sort/BEFUNDE.md` (b10).
Nicht fuer den Recall-Hook: er ruft `--no-rerank`, und ohne Reranker laeuft diese Stufe nie."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Callable, Sequence, TypeVar

T = TypeVar("T")

ENV = "BRAIN_SEARCH_LLM"
# Standard AN seit der Messung auf v4-Test (29.09., b10, einmal, gepaart gegen den Reranker-Standard, n 120):
# nDCG@10 +0,089 [95 %: +0,052; +0,127], hit@1 +0,058 [-0,017; +0,133], hit@5 +0,033 [-0,008; +0,083];
# `brain eval gate` bestanden (eval/llm-sort/BEFUNDE.md). BRAIN_SEARCH_LLM=0 oder `--no-rerank` schaltet ab.
DEFAULT = True
MODELL_ENV = "BRAIN_SEARCH_LLM_MODELL"
# Effort fuer Modelle mit Effort-Stufen (Haiku 5.5). Leer = kein `--effort` (heute fuer claude-haiku-4-5). Nachfolgeplan
# (eval/jev-dienst/BEFUNDE.md, 09.10.): faellt 4.5 weg, BRAIN_SEARCH_LLM_MODELL=claude-haiku-5-5 und EFFORT=medium.
EFFORT_ENV = "BRAIN_SEARCH_LLM_EFFORT"
# Fest auf das gemessene Modell: der Alias "haiku" zeigte am 09.10. (gemessen) auf claude-haiku-5-5; damit dauerte eine
# Suche im Median 9,1 s statt 3,6 s und die Stufe lief teils in FRIST_MS (Rueckfall auf die Reranker-Reihenfolge).
# Gemessen und beschlossen wurde die Stufe am 29.09. mit dem damaligen haiku (4.5). Wechsel nur mit neuer Messung.
MODELL = "claude-haiku-4-5"
TIEFE_ENV = "BRAIN_SEARCH_LLM_TIEFE"
TIEFE = 30  # Dev-Wahl b10 (29.09.): Tiefe 30 vor 20 (Top 5 +0,029 bei Top 1 -0,010, llm-sort/BEFUNDE.md)
FRIST_ENV = "BRAIN_SEARCH_LLM_FRIST_MS"
FRIST_MS = 8000.0
ZEICHEN = 1500   # Passage je Kandidat (BGE-Fenster, gekuerzt), wie gemessen
POOL = 50        # Fusion-Kandidaten, die der Reranker vor dieser Stufe sieht
BIN_ENV = "BRAIN_SEARCH_LLM_BIN"  # nur fuer Tests: anderes Programm statt `claude`
# Gueltig vor abgeloest (b12-gueltig-llm, 30.09.): der Prompt zeigt kein Frontmatter, deshalb stellte das LLM per
# `status: superseded|archived` (oder `superseded-by`, abgelaufenes `valid-until`) abgeloeste Notizen wieder auf
# Platz 1, obwohl der Rangkern sie vorher abgewertet hatte (5 Dev-Verfehlungen, eval/rest/BEFUNDE.md). Mit dem
# Schalter reiht diese Stufe nach der LLM-Ordnung stabil alle gueltigen Treffer des Kopfs vor die abgeloesten.
# Gueltigkeitsquelle wie im Rangkern: `hit.status` aus `rangkern.apply_validity` (Frontmatter).
GUELTIG_ENV = "BRAIN_SEARCH_LLM_GUELTIG"
GUELTIG_DEFAULT = True   # 30.09.: behebt den Rueckschritt der LLM-Stufe (abgeloeste Notizen auf Platz 1); Dev +0,019, 0 Verluste

SYSTEM = ("Du bist ein Relevanz-Ranker fuer eine Notizsuche. Du bekommst eine Frage und nummerierte Notizen "
          "(Pfad, Titel, Auszug). Ordne die Notizen danach, wie direkt sie die Frage beantworten: zuerst die Notiz, "
          "die die konkrete, gueltige Antwort enthaelt; abgeloeste oder nur thematisch verwandte Notizen nach hinten. "
          "Antworte nur mit allen Nummern in neuer Reihenfolge, kommagetrennt, ohne weiteren Text.")
# v2 (Dev-Variante): dieselbe Aufgabe plus die in b9 gefundenen Top-1-Fehler (Sitzung oder Plan vor der
# Entscheidung, aeltere Notiz vor der geltenden, Stand-Fragen).
SYSTEM_V2 = (SYSTEM[:SYSTEM.index("Antworte nur")]
             + "Bei gleichem Thema geht die Notiz vor, die die Antwort selbst festhaelt (Entscheidung, Falle, Fakt, "
             "KERN/STATUS), vor Sitzungsprotokollen, Plaenen, Uebersichten und Sammelseiten, die sie nur erwaehnen; "
             "die geltende oder neuere Aussage vor der aelteren. Fragt jemand nach dem Stand, zuerst die aktuelle "
             "Standseite des Projekts. "
             + SYSTEM[SYSTEM.index("Antworte nur"):])
SYSTEME = {"v1": SYSTEM, "v2": SYSTEM_V2}
PROMPT_ENV = "BRAIN_SEARCH_LLM_PROMPT"
# Nur fuer Messlaeufe: Verzeichnis, in dem jede LLM-Antwort unter dem Hash von Modell, System und Prompt
# liegt. Der Torlauf auf der Testhaelfte sieht so dieselben Antworten wie die Sammlung vor dem Nachurteil
# (das LLM antwortet nicht deterministisch). Nie im Betrieb setzen.
CACHE_ENV = "BRAIN_SEARCH_LLM_CACHE"
_OFF = {"0", "false", "no", "off", "nein", "aus"}
_ON = {"1", "true", "yes", "on", "ja", "an"}

# Pause waehrend eines Gesamtlaufs (WorkbenchOrchestrator, 13.10.2026): jede Sortierung startete
# `claude -p` in $TMPDIR und kostete rund 10 CPU-Sekunden. Seit dem leeren Arbeitsordner (803ce0f9)
# sind es im Gesamtlauf rund 0,5 (GL#45, 14.10.); die Pause ist seitdem ein Schalter mit Vorgabe aus
# (`BRAIN_SEARCH_LLM_GL_PAUSE=1` schaltet sie an, WorkbenchOrchestrator 14.10.). Ist sie an und haelt
# die Tafel einen Platz mit Art `gesamtlauf` oder `gesamtlauf-lokal`, laeuft die Suche ohne diese Stufe
# und sagt das. Fail-open: ist die Tafel nicht lesbar, wird sortiert. `BRAIN_SEARCH_LLM=1` erzwingt.
# Der Recall ist nicht betroffen (er sucht ohne Reranker, also nie mit dieser Stufe).
GESAMTLAUF_ARTEN = ("gesamtlauf", "gesamtlauf-lokal")
GL_PAUSE_ENV = "BRAIN_SEARCH_LLM_GL_PAUSE"
TAFEL_STATE_ENV = "WB_TAFEL_STATE"


def tafel_datei() -> Path:
    raw = os.environ.get(TAFEL_STATE_ENV, "").strip()
    base = Path(raw) if raw else Path.home() / ".local" / "state" / "wb-tafel"
    return base / "tafel.json"


def gesamtlauf_aktiv(jetzt: float | None = None) -> bool:
    """Haelt die Tafel dieser Maschine gerade einen Gesamtlauf? Jeder Lesefehler heisst nein."""
    try:
        daten = json.loads(tafel_datei().read_text(encoding="utf-8"))
        jetzt = time.time() if jetzt is None else jetzt
        for e in daten.get("eintraege") or []:
            if isinstance(e, dict) and e.get("art") in GESAMTLAUF_ARTEN and float(e.get("bis") or 0) > jetzt:
                return True
    except (OSError, ValueError, TypeError, AttributeError):
        return False
    return False


def erzwungen() -> bool:
    return os.environ.get(ENV, "").strip().lower() in _ON


def gl_pause() -> bool:
    """Pausiert die Stufe waehrend eines Gesamtlaufs? Vorgabe nein (14.10.2026)."""
    return os.environ.get(GL_PAUSE_ENV, "").strip().lower() in _ON


_SCHLUESSEL = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")


def enabled() -> bool:
    raw = os.environ.get(ENV, "").strip().lower()
    return DEFAULT if not raw else raw not in _OFF


def gueltig_enabled() -> bool:
    raw = os.environ.get(GUELTIG_ENV, "").strip().lower()
    return GUELTIG_DEFAULT if not raw else raw not in _OFF


def abgeloest(hit) -> bool:
    """Per Frontmatter abgeloest (`rangkern.STATUS_DEMOTED`); claims.db zaehlt nicht (still seit 17.08.)."""
    from .rangkern import STATUS_DEMOTED
    return (getattr(hit, "status", "") or "") in STATUS_DEMOTED


def gueltig_vorn(hits: Sequence[T]) -> list[T]:
    """Stabil: gueltige Treffer in ihrer Reihenfolge, dahinter die abgeloesten in ihrer Reihenfolge."""
    return [h for h in hits if not abgeloest(h)] + [h for h in hits if abgeloest(h)]


def modell() -> str:
    return os.environ.get(MODELL_ENV, "").strip() or MODELL


def tiefe() -> int:
    try:
        return max(2, min(POOL, int(os.environ.get(TIEFE_ENV, "") or TIEFE)))
    except ValueError:
        return TIEFE


def system() -> str:
    return SYSTEME.get(os.environ.get(PROMPT_ENV, "").strip() or "v1", SYSTEM)


def verfuegbar() -> bool:
    """Gibt es das Programm? Ohne es laeuft die Stufe gar nicht (kein Pool 50 fuer den Reranker):
    der Dienst auf peer (Nutzer `brain-dienst`) hat kein `claude`."""
    raw = os.environ.get(BIN_ENV, "").strip()
    return bool(shutil.which(raw) if raw else shutil.which("claude"))


def aktiv(reranking: bool, info: dict | None = None) -> bool:
    """Ob die Stufe fuer diese Suche laeuft: Schalter an, hinter dem Reranker und `claude` vorhanden.
    Fehlt nur das Programm, steht der Grund in `info` (die Suche bleibt die BGE-Stufe)."""
    if not (reranking and enabled()):
        return False
    if not verfuegbar():
        if info is not None:
            info.update({"modell": modell(), "grund": "claude_fehlt"})
        return False
    if gl_pause() and not erzwungen() and gesamtlauf_aktiv():
        if info is not None:
            info.update({"modell": modell(), "grund": "gesamtlauf"})
        return False
    return True


def frist_s() -> float:
    try:
        return max(0.5, float(os.environ.get(FRIST_ENV, "") or FRIST_MS) / 1000)
    except ValueError:
        return FRIST_MS / 1000


def prompt(query: str, items: Sequence[tuple[str, str]], zeichen: int = ZEICHEN) -> str:
    """`items`: (Vault-Pfad, Passage) in der Reihenfolge des Rerankers."""
    teile = [f"[{i}] Pfad: {rel}\n{text[:zeichen]}" for i, (rel, text) in enumerate(items, 1)]
    return (f"Frage: {query}\n\n" + "\n\n".join(teile)
            + f"\n\nFrage: {query}\nNummern 1-{len(items)} in neuer Reihenfolge:")


def reihenfolge(antwort: str, n: int) -> list[int]:
    """0-basierte Indizes aus der Antwort; fehlende hinten in alter Reihenfolge. Leer ohne Nummer."""
    order: list[int] = []
    for tok in re.findall(r"\d+", antwort):
        i = int(tok)
        if 1 <= i <= n and i - 1 not in order:
            order.append(i - 1)
    if not order:
        return []
    return order + [i for i in range(n) if i not in order]


def leerer_ordner() -> str:
    """Arbeitsordner fuer `claude -p`: leer und eigen. Direkt in $TMPDIR (12 460 Eintraege) kostete ein
    Aufruf 11-12 CPU-s, in einem leeren Ordner 0,5 s (gemessen 14.10.2026, brain-ideen M5)."""
    pfad = os.path.join(tempfile.gettempdir(), f"brain-claude-leer-{os.getuid()}")
    try:
        os.makedirs(pfad, mode=0o700, exist_ok=True)
    except OSError:
        return tempfile.gettempdir()
    return pfad


def claude_aufruf(text: str, model: str, frist: float) -> dict:
    """Ein magerer `claude -p`; Ergebnis {"text", "usd"} oder {"grund"}. Laeuft in eigener
    Prozessgruppe, die bei Fristende ganz beendet wird."""
    exe = os.environ.get(BIN_ENV, "").strip() or shutil.which("claude")
    if not exe:
        return {"grund": "claude_fehlt"}
    env = {k: v for k, v in os.environ.items() if k not in _SCHLUESSEL}
    env["MAX_THINKING_TOKENS"] = "0"
    cmd = [exe, "-p", "--model", model, "--setting-sources", "", "--settings", '{"disableAllHooks":true}',
           "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", system(),
           "--output-format", "json"]
    effort = os.environ.get(EFFORT_ENV, "").strip()
    if effort:
        cmd += ["--effort", effort]
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, env=env, cwd=leerer_ordner(), start_new_session=True)
    except OSError as exc:
        return {"grund": f"start:{type(exc).__name__}"}
    try:
        out, _err = proc.communicate(text, timeout=frist)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            proc.kill()
        proc.communicate()
        return {"grund": "zeit"}
    try:
        data = json.loads(out)
    except ValueError:
        return {"grund": f"exit_{proc.returncode}" if proc.returncode else "antwort_ungueltig"}
    if not isinstance(data, dict) or data.get("is_error"):
        return {"grund": "llm_fehler"}
    return {"text": str(data.get("result") or ""), "usd": float(data.get("total_cost_usd") or 0)}


def _gecacht(aufruf: Callable[[str, str, float], dict]) -> Callable[[str, str, float], dict]:
    raw = os.environ.get(CACHE_ENV, "").strip()
    if not raw:
        return aufruf
    root = Path(raw).expanduser()

    def call(text: str, model: str, frist: float) -> dict:
        key = hashlib.sha256("\0".join((model, system(), text)).encode()).hexdigest()
        path = root / f"{key}.json"
        try:
            got = json.loads(path.read_text(encoding="utf-8"))
            return {**got, "cache": True}
        except (OSError, ValueError):
            pass
        t0 = time.perf_counter()
        res = aufruf(text, model, frist)
        if not res.get("grund"):  # nur Antworten, keine Rueckfaelle
            try:
                root.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(f".{os.getpid()}.tmp")
                tmp.write_text(json.dumps({**res, "s": round(time.perf_counter() - t0, 3)}), encoding="utf-8")
                tmp.replace(path)
            except OSError:
                pass
        return res
    return call


def sortieren(query: str, hits: Sequence[T], passage_of: Callable[[T], str], rel_of: Callable[[T], str], *,
              info: dict | None = None, aufruf: Callable[[str, str, float], dict] | None = None) -> list[T]:
    """Die ersten `tiefe()` Treffer vom LLM ordnen lassen, den Rest unveraendert dahinter.
    Bei jeder Stoerung die Eingabe unveraendert (als Liste), Grund in `info`."""
    info = info if info is not None else {}
    model, n = modell(), tiefe()
    head, tail = list(hits[:n]), list(hits[n:])
    info.update({"modell": model, "tiefe": len(head)})
    if os.environ.get(PROMPT_ENV, "").strip() not in ("", "v1"):
        info["prompt"] = os.environ[PROMPT_ENV].strip()
    if len(head) < 2:
        info["grund"] = "keine_kandidaten"
        return list(hits)
    try:
        items = [(rel_of(h), passage_of(h)) for h in head]
    except Exception as exc:  # Passagenbau darf die Suche nie stoeren
        info["grund"] = f"passage:{type(exc).__name__}"
        return list(hits)
    t0 = time.perf_counter()
    res = _gecacht(aufruf or claude_aufruf)(prompt(query, items), model, frist_s())
    info["s"] = round(float(res["s"]) if "s" in res else time.perf_counter() - t0, 3)
    if res.get("cache"):
        info["cache"] = True
    if "usd" in res:
        info["usd"] = round(float(res["usd"]), 5)
    if res.get("grund"):
        info["grund"] = res["grund"]
        return list(hits)
    order = reihenfolge(res.get("text", ""), len(head))
    if not order:
        info["grund"] = "antwort_ohne_nummern"
        return list(hits)
    info["grund"] = ""
    info["umsortiert"] = len(head)
    head = [head[i] for i in order]
    if gueltig_enabled():
        neu = gueltig_vorn(head)
        info["gueltig_verschoben"] = sum(1 for a, b in zip(head, neu) if a is not b)
        head = neu
    return head + tail

