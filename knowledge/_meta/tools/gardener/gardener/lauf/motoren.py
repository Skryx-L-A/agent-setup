"""Stage engines for `brain run`, configured in ``engines.yaml`` → ``stufen``.

Model choice (orchestrator, measured 2026-09-23, B2/B3 BEFUNDE):
extraction = peer ``gemma4:12b`` (fallback ``qwen3.5:9b``), pair judgment =
peer ``gemma4:12b`` at threshold 0.65, embedding = ``embeddinggemma``.  The
Mac (Splash) serves only units in ``wartet-grossmodell`` and only when it
answers; nothing else waits for it (Entscheidung 15, pull principle).

No stage silently switches to a model outside its list.  A model that is not
installed on the endpoint is skipped (``/api/tags``), a model this run loaded
is unloaded again at the end (``keep_alive: 0``); a model that was already
resident before the run is left alone.
"""
from __future__ import annotations

import dataclasses
import json
import logging
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .. import engines as engines_mod
from ..engines import (Endpoint, EngineError, EngineRegistry, EngineResponseError,
                       EngineUnavailable)

log = logging.getLogger("gardener.lauf")

STUFEN_DEFAULT: dict[str, dict[str, Any]] = {
    "extraktion": {"engine": "peer-ollama", "modelle": ["gemma4:12b", "qwen3.5:9b"],
                   "optionen": {"temperature": 0, "num_ctx": 8192}, "max_tokens": 2048,
                   "timeout": 600},
    "paarurteil": {"engine": "peer-ollama", "modelle": ["gemma4:12b"], "schwelle": 0.65,
                   "gleich_cos": 0.62, "timeout": 120},
    # p2 (j2 measurement c): project choice for units the rules leave empty
    "projektwahl": {"engine": "peer-ollama", "modelle": ["gemma4:12b"],
                    "optionen": {"num_ctx": 8192}, "timeout": 120},
    "einbettung": {"engine": "peer-ollama", "modelle": ["embeddinggemma"], "timeout": 120},
    # p3: quality check of proposals (``pruefen``): gemma4:12b question ``art`` +
    # logistic regression over [logit, source class, type, project] fitted on the
    # dev half of the 450 cloud verdicts; threshold = dev optimum (eval/vorschlaege-qualitaet)
    "pruefen": {"engine": "peer-ollama", "modelle": ["gemma4:12b"], "frage": "art",
                "gewichte": "pruefen-gewichte.json", "schwelle": 0.522,
                "optionen": {"num_ctx": 4096}, "timeout": 120},
    "grossmodell": {"engine": "mac-splash", "modelle": ["incoai/Qwen3.8-27B-Splash"],
                    "max_tokens": 2048, "timeout": 900},
}


class _One:
    """Registry-shaped view that offers exactly one endpoint to ``decide``."""

    def __init__(self, endpoint: Endpoint):
        self.endpoint = endpoint

    def pick(self, _needs) -> Endpoint:
        return self.endpoint


def _get_json(url: str, timeout: float = 5.0) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read())


class Motoren:
    def __init__(self, registry: EngineRegistry, stufen: dict[str, dict[str, Any]] | None = None):
        self.registry = registry
        self.stufen = {**STUFEN_DEFAULT, **(stufen or {})}
        self._endpoints: dict[tuple[str, str], Endpoint] = {}
        self._installed: dict[str, set[str] | None] = {}
        self._resident_before: dict[str, set[str]] = {}
        self._used: set[tuple[str, str]] = set()
        self.aufrufe: dict[str, int] = {}

    @classmethod
    def from_file(cls, path: str | Path | None = None) -> "Motoren":
        registry = EngineRegistry.from_file(path)
        config = Path(path or engines_mod.os.environ.get("BRAIN_ENGINES", engines_mod.DEFAULT_CONFIG))
        try:
            stufen = json.loads(config.read_text(encoding="utf-8")).get("stufen") or {}
        except (OSError, ValueError, AttributeError):
            stufen = {}
        return cls(registry, stufen)

    def __enter__(self) -> "Motoren":
        self.registry.__enter__()
        return self

    def __exit__(self, *exc: object) -> None:
        try:
            self.entladen()
        finally:
            self.registry.__exit__(*exc)

    # ------------------------------------------------------------ endpoints
    def _base(self, stufe: str) -> Endpoint | None:
        name = self.stufen[stufe]["engine"]
        return next((e for e in self.registry.endpoints if e.name == name), None)

    def zusatz(self, stufe: str) -> list[tuple[list[Endpoint], int]]:
        """Extra machines for ``stufe`` (``"zusatz": [{"engine": name, "nebenlaeufig": n}]`` in the
        stage config): each as (reachable endpoints in model order, concurrency).  Windows are spread
        over the main engine and these (der Nutzer, 2026-09-23: Mac als zweiter Motor für einen Lauf)."""
        out = []
        for extra in self.stufen[stufe].get("zusatz", []) or []:
            base = next((e for e in self.registry.endpoints if e.name == extra.get("engine")), None)
            if base is None or not self.registry.reachable(base):
                continue
            eps = []
            for modell in self.stufen[stufe]["modelle"]:
                key = (base.name, modell)
                if key not in self._endpoints:
                    clone = dataclasses.replace(base, model=modell, name=f"{base.name}:{modell}")
                    self.registry.endpoints.append(clone)
                    self._endpoints[key] = clone
                installed = self._installed_models(self._endpoints[key])
                if installed is not None and modell not in installed:
                    continue
                eps.append(self._endpoints[key])
            if eps:
                out.append((eps, max(1, int(extra.get("nebenlaeufig", 1)))))
        return out

    def _endpoint(self, stufe: str, modell: str) -> Endpoint | None:
        base = self._base(stufe)
        if base is None:
            return None
        key = (base.name, modell)
        if key not in self._endpoints:
            clone = dataclasses.replace(base, model=modell, name=f"{base.name}:{modell}")
            self.registry.endpoints.append(clone)
            self._endpoints[key] = clone
        return self._endpoints[key]

    def _installed_models(self, endpoint: Endpoint) -> set[str] | None:
        """Model names the Ollama endpoint has; None = not an Ollama or unknown."""
        base = endpoint.name.split(":", 1)[0]
        if base not in self._installed:
            names: set[str] | None = None
            if endpoint.kind == "ollama":
                try:
                    url = self.registry.base_url(endpoint)
                    data = _get_json(url + "/api/tags", timeout=self.registry.probe_timeout + 5)
                    names = set()
                    for model in data.get("models") or []:
                        full = str(model.get("name") or model.get("model") or "")
                        names.add(full)
                        if full.endswith(":latest"):
                            names.add(full[:-len(":latest")])
                    ps = _get_json(url + "/api/ps", timeout=self.registry.probe_timeout + 5)
                    self._resident_before[base] = {str(m.get("name") or m.get("model") or "")
                                                   for m in ps.get("models") or []}
                except (EngineError, urllib.error.URLError, OSError, ValueError):
                    names = None
            self._installed[base] = names
        return self._installed[base]

    def verfuegbar(self, stufe: str) -> list[Endpoint]:
        """Reachable endpoints of ``stufe`` in preference order."""
        out = []
        for modell in self.stufen[stufe]["modelle"]:
            endpoint = self._endpoint(stufe, modell)
            if endpoint is None or not self.registry.reachable(endpoint):
                continue
            installed = self._installed_models(endpoint)
            if installed is not None and modell not in installed:
                continue
            out.append(endpoint)
        return out

    def warte_auf(self, stufe: str, *, stop=lambda: False) -> list[Endpoint]:
        """Retry a required stage's reachability until its configured deadline.

        Between probes a stage endpoint's SSH tunnel is rebuilt: an ssh process
        that is still alive may forward into a dead remote port (peer Ollama
        restarted), and a plain re-probe would keep using it (p2, 2026-09-24:
        every pair judgment of three runs failed that way)."""
        deadline = time.monotonic() + max(0.0, float(self.stufen[stufe].get("start_warten_s", 600)))
        while True:
            # Reachability is a cache for a single probe, not a verdict for the run.
            for endpoint in self._endpoints.values():
                self.registry._reachable.pop(endpoint.name, None)
            self._installed.clear()
            ready = self.verfuegbar(stufe)
            if ready or stop() or time.monotonic() >= deadline:
                return ready
            self._tunnel_neu(stufe)
            time.sleep(min(2.0, max(0.0, deadline - time.monotonic())))

    def _tunnel_neu(self, stufe: str) -> None:
        for modell in self.stufen[stufe]["modelle"]:
            endpoint = self._endpoint(stufe, modell)
            if endpoint is None or not endpoint.live_url or endpoint._refresh is None:
                continue
            try:
                endpoint._refresh(endpoint.live_url)
            except EngineError:
                pass

    def beschreibung(self) -> dict[str, Any]:
        """For dry-run and report: configured model per stage and whether it
        answers.  Probes ``/api/tags`` only; never loads a model."""
        out = {}
        for stufe, cfg in self.stufen.items():
            ready = [e.model for e in self.verfuegbar(stufe)]
            out[stufe] = {"engine": cfg["engine"], "modelle": cfg["modelle"], "bereit": ready}
        return out

    # -------------------------------------------------------------- calls
    def _count(self, stufe: str) -> None:
        self.aufrufe[stufe] = self.aufrufe.get(stufe, 0) + 1

    def extrahiere(self, messages: list[dict[str, str]], schema: dict[str, Any], *,
                   grossmodell: bool = False) -> tuple[dict[str, Any], str]:
        """One constrained generation; returns (response, model).  Tries the
        stage's models in order on a transport error only; a parse problem is
        the caller's (it may try the next model via ``extrahiere_mit``)."""
        stufe = "grossmodell" if grossmodell else "extraktion"
        endpoints = self.verfuegbar(stufe)
        if not endpoints:
            raise EngineUnavailable(f"keine erreichbare Maschine fuer {stufe}")
        return self.extrahiere_mit(endpoints[0], messages, schema, stufe=stufe), endpoints[0].model

    def extrahiere_mit(self, endpoint: Endpoint, messages, schema, *, stufe: str = "extraktion"):
        cfg = self.stufen[stufe]
        self._count(stufe)
        self._used.add((endpoint.name.split(":", 1)[0], endpoint.model))
        return engines_mod.generate(endpoint, messages, json_schema=schema,
                                    max_tokens=int(cfg.get("max_tokens", 2048)), think=False,
                                    timeout=float(cfg.get("timeout", 600)),
                                    options=cfg.get("optionen"))

    def decider(self, stufe: str = "paarurteil"):
        """``decide`` bound to the stage's endpoint (paarurteil, projektwahl)."""
        endpoints = self.verfuegbar(stufe)
        if not endpoints:
            raise EngineUnavailable(f"keine erreichbare Maschine fuer {stufe}")
        endpoint = endpoints[0]
        cfg = self.stufen[stufe]
        timeout = float(cfg.get("timeout", 120))
        options = cfg.get("optionen")

        def decide(state, questions, **kwargs):
            self._count(stufe)
            self._used.add((endpoint.name.split(":", 1)[0], endpoint.model))
            if options and "options" not in kwargs:
                kwargs["options"] = options
            return engines_mod.decide(state, questions, registry=_One(endpoint),
                                      timeout=timeout, **kwargs)
        return decide, endpoint.model

    @property
    def schwelle(self) -> float:
        return float(self.stufen["paarurteil"].get("schwelle", 0.65))

    @property
    def gleich_cos(self) -> float:
        """Embedding cosine from which a pair counts as ``gleich`` without a
        model (j2 measurement b: 0.91 test accuracy against 0.75 for the
        pair-judgment model; threshold 0.619 on the dev half)."""
        return float(self.stufen["paarurteil"].get("gleich_cos", 0.62))

    def einbetten(self, texte: list[str]) -> list[list[float]]:
        endpoints = self.verfuegbar("einbettung")
        if not endpoints:
            raise EngineUnavailable("keine erreichbare Maschine fuer einbettung")
        endpoint = endpoints[0]
        self._count("einbettung")
        self._used.add((endpoint.name.split(":", 1)[0], endpoint.model))
        if endpoint.kind != "ollama":
            raise EngineError(f"{endpoint.name}: Einbettung nur ueber Ollama")
        data = engines_mod._request(endpoint.url + "/api/embed",
                                    {"model": endpoint.model, "input": texte},
                                    float(self.stufen["einbettung"].get("timeout", 120)), endpoint)
        vectors = data.get("embeddings")
        if not isinstance(vectors, list) or len(vectors) != len(texte):
            raise EngineResponseError("embed: unerwartete Antwort")
        return vectors

    # ------------------------------------------------------------ cleanup
    def entladen(self) -> list[str]:
        """Unload models this run loaded (not those resident before it)."""
        done = []
        for base_name, modell in sorted(self._used):
            endpoint = self._endpoints.get((base_name, modell))
            if endpoint is None or endpoint.kind != "ollama":
                continue
            before = self._resident_before.get(base_name, set())
            if modell in before or f"{modell}:latest" in before:
                continue
            try:
                url = endpoint.url
            except EngineError:
                continue
            for path, payload in (("/api/generate", {"model": modell, "keep_alive": 0}),
                                  ("/api/embed", {"model": modell, "input": [], "keep_alive": 0})):
                try:
                    engines_mod._request(url + path, payload, 30)
                    done.append(modell)
                    break
                except EngineResponseError:
                    continue
        return done
