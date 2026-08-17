"""Local Ollama client (stdlib only). Embeddings + JSON judgments. No cloud calls."""
from __future__ import annotations

import json
import logging
import re
import urllib.request

from . import config

log = logging.getLogger("gardener")


class OllamaError(Exception):
    pass


class OllamaUnavailable(OllamaError):
    """Ollama itself is gone (not one slow call): the run must abort."""


class OllamaClient:
    """One slow call is not a dead service.

    Observed 2026-07-12: a single judge call ran into the 120 s timeout while a
    35B model held the GPU, the OllamaError propagated out of the linking loop,
    and the whole run died with exit 2 - throwing away every phase that had not
    run yet. A transport failure is therefore retried once and then reported as
    "this pair could not be judged" (the callers already treat that as: skip,
    retry next run). Only a RUN of consecutive failures means Ollama is really
    down, and only then does the run abort.
    """

    RETRIES = 1
    MAX_CONSECUTIVE_FAILURES = 5

    def __init__(self, base_url: str = config.OLLAMA_URL,
                 embed_model: str = config.EMBED_MODEL,
                 judge_model: str = config.JUDGE_MODEL,
                 timeout: int = config.OLLAMA_TIMEOUT):
        self.base_url = base_url.rstrip("/")
        self.embed_model = embed_model
        self.judge_model = judge_model
        self.timeout = timeout
        self.failures = 0          # consecutive transport failures
        self.transient_failures = 0  # total, for the report

    def _ok(self) -> None:
        self.failures = 0

    def _failed(self, what: str, exc: Exception) -> None:
        """Count a transport failure; trip the breaker when they pile up."""
        self.failures += 1
        self.transient_failures += 1
        if self.failures >= self.MAX_CONSECUTIVE_FAILURES:
            raise OllamaUnavailable(
                f"{self.failures} consecutive {what} failures (last: {exc}) - "
                "Ollama is not answering, aborting the run")
        log.warning("%s failed (%d/%d in a row, tolerated): %s",
                    what, self.failures, self.MAX_CONSECUTIVE_FAILURES, exc)

    def _post_retrying(self, path: str, payload: dict, what: str) -> dict | None:
        """POST with one retry. None = transient failure the caller must absorb."""
        for attempt in range(self.RETRIES + 1):
            try:
                data = self._post(path, payload)
            except OllamaError as e:
                if attempt < self.RETRIES:
                    log.warning("%s failed (%s) - retrying once", what, e)
                    continue
                self._failed(what, e)     # raises OllamaUnavailable when tripped
                return None
            self._ok()
            return data
        return None

    def _post(self, path: str, payload: dict) -> dict:
        req = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read())
        except OllamaError:
            raise
        except Exception as e:
            raise OllamaError(f"ollama {path} failed: {e}") from e

    def _get(self, path: str) -> dict:
        try:
            with urllib.request.urlopen(self.base_url + path, timeout=15) as resp:
                return json.loads(resp.read())
        except Exception as e:
            raise OllamaError(f"ollama {path} failed: {e}") from e

    def big_model_loaded(self) -> str | None:
        """48-GB rule: name of a loaded >15-GB model, or None."""
        data = self._get("/api/ps")  # raises OllamaError if unreachable
        for m in data.get("models", []):
            size = max(m.get("size", 0), m.get("size_vram", 0))
            if size > config.MAX_LOADED_MODEL_BYTES:
                return m.get("name", "?")
        return None

    def has_model(self, name: str) -> bool:
        """True if the model is pulled locally. False (never raises) otherwise."""
        try:
            data = self._get("/api/tags")
        except OllamaError:
            return False
        return any(m.get("name") == name or m.get("model") == name
                   for m in data.get("models", []))

    def describe_image(self, image_b64: str, prompt: str,
                       model: str | None = None) -> str:
        """Local vision description. Caller checks has_model() and the 48-GB rule."""
        data = self._post("/api/chat", {
            "model": model or config.VISION_MODEL,
            "stream": False,
            "options": {"temperature": 0},
            "messages": [{"role": "user", "content": prompt,
                          "images": [image_b64]}],
        })
        return ((data.get("message") or {}).get("content") or "").strip()

    def embed(self, text: str) -> list[float]:
        data = self._post_retrying("/api/embed", {
            "model": self.embed_model,
            "input": text[:config.EMBED_MAX_CHARS],
        }, "embed")
        if data is None:
            raise OllamaError("embedding failed (transient)")
        embs = data.get("embeddings") or []
        if not embs:
            raise OllamaError(f"empty embedding response: {data}")
        return embs[0]

    def judge(self, system: str, prompt: str) -> dict:
        """Ask the judge model for a JSON object; tolerant parsing.

        Returns {} when this one call could not be answered - a slow or
        malformed answer is never fatal. Raises OllamaUnavailable only when
        Ollama has failed MAX_CONSECUTIVE_FAILURES times in a row.
        """
        data = self._post_retrying("/api/chat", {
            "model": self.judge_model,
            "stream": False,
            "format": "json",
            "options": {"temperature": 0},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
        }, "judge")
        if data is None:
            return {}
        content = (data.get("message") or {}).get("content", "")
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            m = re.search(r"\{.*\}", content, re.DOTALL)
            if m:
                try:
                    return json.loads(m.group(0))
                except json.JSONDecodeError:
                    pass
        log.warning("judge returned non-JSON: %.200s", content)
        return {}
