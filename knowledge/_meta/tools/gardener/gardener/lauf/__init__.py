"""`brain run`: the one local pipeline (Brain 5, packages B4 + B5).

Gardener and Dream merged into one run with one lock, one run id, one
report and one commit (BRAIN5-PIPELINE.md, Leitentscheidungen 1-8):

- ``buch``      the book: unit states, packages, pair verdicts, runs (in
                ``dream.db``, next to the untouched legacy ``units`` table)
- ``quellen``   harvest: transcripts, worker results, project docs and the
                Claude auto-memory, locally or from peer over ssh (read-only)
- ``motoren``   stage engines (peer gemma4:12b, fallback qwen3.5:9b,
                embeddinggemma, Mac Splash only for ``wartet-grossmodell``)
- ``stufen``    detector -> extraction -> matching -> big-model follow-up
- ``schreiben`` proposals into own marker blocks / own sections only
- ``ausgabe``   human text or ``--json`` event lines
- ``lauf``      orchestration, profiles, lock, report, commit
"""
