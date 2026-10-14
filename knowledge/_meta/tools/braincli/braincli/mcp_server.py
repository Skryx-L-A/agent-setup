"""`brain mcp`: a small stdio MCP server for read-only vault access."""
from __future__ import annotations

import argparse
import time
from pathlib import Path

from gardener import config
from mcp.server.fastmcp import FastMCP

from .mcp_backend import LocalBackend
from . import frage as frage_mod, nutzungslog


def _protokolliere(vault: Path, werkzeug: str, frage: str, rels: list[str], t0: float) -> None:
    """Nutzungsprotokoll, Kanal mcp (Firmenniveau-Plan M3): gleiche Schwaerzung wie `brain search`;
    protokolliert nie eine Ausnahme nach aussen. BRAIN_NUTZUNGSLOG=0 schaltet ab."""
    nutzungslog.protokolliere(
        "mcp", vault, anfrage=frage, treffer=[{"rel": r} for r in rels],
        grund=None if rels else "keine_treffer", dauer_ms=(time.perf_counter() - t0) * 1000,
        rolle_=nutzungslog.rolle(), detail=werkzeug)


def create_server(vault: Path) -> FastMCP:
    # Zustand (Einbettungsindex) an DIESEN Vault binden, wie jeder CLI-Einstieg: sonst sucht ein
    # Server mit --vault <anderer> im Index des Hauptvaults (gemessen 2026-09-23 bei der Abnahme).
    config.bind_vault(vault)
    backend = LocalBackend(vault)
    server = FastMCP("brain")

    @server.tool(description="Hybrid-Suche; liefert kurze Notiztreffer.")
    def suche(frage: str, k: int = 5, space: str | None = None) -> list[dict]:
        t0 = time.perf_counter()
        treffer = backend.search(frage, k, space)
        _protokolliere(vault, "suche", frage, [t["pfad"] for t in treffer], t0)
        return treffer

    @server.tool(description="Liest eine Notiz per Pfad oder Titel.")
    def lies(pfad: str | None = None, titel: str | None = None,
             abschnitt: str | None = None) -> dict:
        return backend.read(pfad, titel, abschnitt)

    @server.tool(description="Zeigt Notizen, die auf einen Titel verweisen.")
    def backlinks(titel: str) -> list[dict]:
        return backend.backlinks(titel)

    @server.tool(description="Liest das KERN.md eines Projekts.")
    def kern(projekt: str) -> dict:
        return backend.kern(projekt)

    @server.tool(description="Kurze Antwort aus dem Vault, jeder Satz mit pfad:zeile; "
                             "ohne Beleg 'Nicht im Vault belegt.' Dauert 5-20 s.")
    def antworte(frage: str, space: str | None = None) -> dict:
        t0 = time.perf_counter()
        antwort = frage_mod.ausfuehren(vault, frage, space=space).als_json()
        _protokolliere(vault, "antworte", frage, list(antwort.get("quellen") or []), t0)
        return antwort

    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="brain mcp")
    parser.add_argument("--vault", required=True, help="read-only vault root")
    args = parser.parse_args(argv)
    create_server(Path(args.vault)).run(transport="stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
