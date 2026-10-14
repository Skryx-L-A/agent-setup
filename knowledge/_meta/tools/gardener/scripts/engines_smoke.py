#!/usr/bin/env python3
"""Explicit, non-suite smoke test for peer-Ollama's decision logprobs."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from gardener.engines import EngineRegistry, Question, decide  # noqa: E402


def _peer_models() -> list[str]:
    proc = subprocess.run(["ssh", "peer", "ollama", "list"], capture_output=True,
                          text=True, timeout=15, check=True)
    return [line.split()[0] for line in proc.stdout.splitlines()[1:] if line.split()]


def _unload(base_url: str, model: str) -> None:
    request = urllib.request.Request(base_url + "/api/chat",
        data=json.dumps({"model": model, "messages": [], "keep_alive": 0,
                         "stream": False}).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=15):
            pass
    except Exception as exc:  # result is still useful, but cleanup must be visible
        print(f"WARNUNG Entladen fehlgeschlagen: {exc}", file=sys.stderr)


def main() -> int:
    gpu = subprocess.run(["ssh", "peer", "nvidia-smi", "--query-compute-apps=pid,process_name,used_memory",
                          "--format=csv,noheader"], capture_output=True, text=True, timeout=15, check=True)
    # Desktop-Prozesse (Chromium, Nautilus, ~0,6 GiB) sind keine fremde Modell-Last; abgebrochen
    # wird erst ab 2 GiB Rechenbelegung oder wenn Ollama bereits ein Modell haelt (2026-09-23).
    used = 0
    for line in gpu.stdout.strip().splitlines():
        try:
            used += int(line.rsplit(",", 1)[1].strip().split()[0])
        except (IndexError, ValueError):
            used += 10**6
    loaded = subprocess.run(["ssh", "peer", "ollama", "ps"], capture_output=True, text=True, timeout=15).stdout
    if used > 2048 or len(loaded.strip().splitlines()) > 1:
        print("ABBRUCH: peer-GPU ist belegt:\n" + gpu.stdout.strip() + "\n" + loaded.strip(), file=sys.stderr)
        return 2
    models = _peer_models()
    wanted = next((m for m in models if m.startswith("llama3.2:1b")), None)
    if wanted is None:
        print("ABBRUCH: kein kleines erwartetes Modell vorhanden (gefunden: " + ", ".join(models) + ")", file=sys.stderr)
        return 2
    config = {"engines": [{"name": "smoke", "kind": "ollama", "base_url": "http://127.0.0.1:11434",
               "ssh_tunnel": "peer", "model": wanted, "machine": "peer", "capabilities": {"logprobs": True, "json_schema": True, "max_parallel": 1, "keep_alive": "2m"}}]}
    path = ROOT / ".engines-smoke.json"
    path.write_text(json.dumps(config))
    questions = [Question("Ist die Aussage klar belegt?", "noul"),
                 Question("Welche Einordnung passt?", "choice", ["Entscheidung", "Fehler", "Fakt"]),
                 Question("Wie stark ist der Beleg?", "score"),
                 Question("Soll die Pipeline warten?", "noul"),
                 Question("Ist eine Prüfung nötig?", "noul")]
    # peer-Ollama lauscht nur auf 127.0.0.1; die Registry oeffnet und schliesst den Tunnel.
    with EngineRegistry.from_file(path) as registry:
        try:
            _smoke(registry, questions)
        finally:
            path.unlink(missing_ok=True)
            endpoint = registry.endpoints[0]
            if endpoint.live_url:
                _unload(endpoint.live_url, wanted)
    return 0


def _smoke(registry: EngineRegistry, questions: list[Question]) -> None:
    for index, question in enumerate(questions, 1):
        started = time.perf_counter()
        answer = decide("Der Testzustand enthält eine kurze deutsche Aktennotiz.", [question], registry=registry)[0]
        elapsed = (time.perf_counter() - started) * 1000
        print(f"{index}. {question.type}: {answer.choice}; {elapsed:.1f} ms")


if __name__ == "__main__":
    raise SystemExit(main())
