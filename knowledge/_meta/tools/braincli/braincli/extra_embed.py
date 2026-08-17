"""Supplementary embedding cache for notes gardener's own embedding pass never
covers: the 18 `20-projects/*/MOC.md` project entry points (the 4
`30-topics/*/MOC.md` topic hubs are already embedded by
`gardener.topics.load_hubs()` for its own hub-membership logic, and are left
alone here).

Stored in this tool's OWN sqlite file (`_meta/tools/braincli/state/`), never
gardener's `_meta/tools/gardener/state/gardener.db` -- braincli must not write into
another tool's state directory. `semantic_search()` merges this store with
gardener's own at query time.

Maintenance-only: run this after a MOC.md's content changes (content-hash
gated, like gardener's own cache, so an unchanged note is a no-op). Not run
automatically per query -- a live Ollama call per MOC.md would blow the
auto-recall hook's 1.5s budget.
"""
from __future__ import annotations

from pathlib import Path

from gardener import config
from gardener.linking import cache_key, embed_document
from gardener.ollama import OllamaClient, OllamaError, OllamaUnavailable
from gardener.store import Store

from .vault import load_search_notes

EXTRA_DB_PATH = Path(__file__).resolve().parent.parent / "state" / "extra-embeddings.db"


def extra_db_path(vault) -> Path:
    """Derselbe Zustand-folgt-dem-Vault-Griff wie in `config.bind_vault`: dieser
    Nebenspeicher gehoert zu dem Vault, dessen MOC-Seiten darin liegen. `build()`
    endet mit `prune_embeddings`, also gilt hier dieselbe Loeschgefahr, die am
    2026-08-04 den Hauptindex getroffen hat."""
    return config.tool_dir_for(vault, "braincli") / "state" / "extra-embeddings.db"


def moc_notes(vault: Path):
    return [n for n in load_search_notes(vault) if Path(n.rel).name == "MOC.md"]


def build(vault: Path, db_path: Path | None = None) -> dict[str, str]:
    """Embed every MOC.md (content-hash gated). Returns {rel: status}."""
    db_path = extra_db_path(vault) if db_path is None else Path(db_path)
    store = Store(db_path)
    client = OllamaClient()
    status: dict[str, str] = {}
    try:
        notes = moc_notes(vault)
        for n in notes:
            key = cache_key(n)
            if store.get_embedding(n.rel, key) is not None:
                status[n.rel] = "cached"
                continue
            try:
                vec = embed_document(client, n.embed_text)
            except OllamaUnavailable:
                raise
            except OllamaError as e:
                status[n.rel] = f"failed: {e}"
                continue
            store.put_embedding(n.rel, key, vec)
            status[n.rel] = "embedded"
        store.prune_embeddings({n.rel for n in notes})
    finally:
        store.close()
    return status


def main() -> None:
    vault = config.DEFAULT_VAULT
    status = build(vault)
    for rel, s in sorted(status.items()):
        print(f"{s:10s} {rel}")
    counts: dict[str, int] = {}
    for s in status.values():
        key = s.split(":")[0]
        counts[key] = counts.get(key, 0) + 1
    print(counts)


if __name__ == "__main__":
    main()
