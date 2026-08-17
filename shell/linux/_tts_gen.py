#!/usr/bin/env python3
# _tts_gen.py — CUDA-TTS-Treiber hinter dem `tts`-Wrapper (Linux-Port).
# UNGETESTET auf diesem Mac (kein NVIDIA). Verifikation auf Nobara + RTX 4070 SUPER.
# Schreibt genau eine Datei <out-prefix>_000.wav (24 kHz), damit der Wrapper sie findet.
import argparse
import sys


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--engine", required=True,
                   choices=["kokoro", "chatterbox", "qwen3"])
    p.add_argument("--text", required=True)
    p.add_argument("--model", default="")
    p.add_argument("--voice", default="")
    p.add_argument("--out-prefix", required=True)
    return p.parse_args()


def save_wav(path, audio, sr):
    import soundfile as sf
    import numpy as np
    a = np.asarray(audio)
    if hasattr(audio, "detach"):
        a = audio.detach().cpu().numpy()
    sf.write(path, a, sr)


def run_kokoro(a, out):
    # hexgrad/kokoro: KPipeline, PyTorch. 'a' = amerikanisches Englisch.
    from kokoro import KPipeline
    import numpy as np
    pipe = KPipeline(lang_code="a")
    voice = a.voice or "af_heart"
    chunks = [audio for _, _, audio in pipe(a.text, voice=voice)]
    audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
    save_wav(out, audio, 24000)


def run_chatterbox(a, out):
    # resemble-ai/chatterbox: ChatterboxTTS auf CUDA.
    import torch
    from chatterbox.tts import ChatterboxTTS
    model = ChatterboxTTS.from_pretrained(device="cuda")
    kw = {}
    if a.voice:
        kw["audio_prompt_path"] = a.voice   # Voice-Clone-Referenz optional
    wav = model.generate(a.text, **kw)
    save_wav(out, wav, model.sr)


def run_qwen3(a, out):
    # Qwen3-TTS-12Hz-0.6B-Base via qwen-tts (deutsch u.a.).
    from qwen_tts import Qwen3TTS
    model_id = a.model or "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
    model = Qwen3TTS.from_pretrained(model_id, device="cuda")
    kw = {}
    if a.voice:
        kw["voice"] = a.voice
    wav, sr = model.generate(a.text, **kw)
    save_wav(out, wav, sr)


def main():
    a = parse_args()
    out = f"{a.out_prefix}_000.wav"
    try:
        if a.engine == "kokoro":
            run_kokoro(a, out)
        elif a.engine == "chatterbox":
            run_chatterbox(a, out)
        else:
            run_qwen3(a, out)
    except Exception as e:
        print(f"tts engine {a.engine} failed: {e}", file=sys.stderr)
        sys.exit(1)
    print(out)


if __name__ == "__main__":
    main()
