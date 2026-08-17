#!/usr/bin/env python3
# _stt_gen.py — CUDA-STT-Treiber hinter dem `stt`-Wrapper (Linux-Port).
# UNGETESTET auf diesem Mac (kein NVIDIA). Verifikation auf Nobara + RTX 4070 SUPER.
# Gibt den Transkript-Text (bzw. SRT bei --timestamps) auf stdout aus.
import argparse
import sys


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--engine", choices=["parakeet", "whisper"], default="parakeet")
    p.add_argument("--audio", required=True)
    p.add_argument("--timestamps", action="store_true")
    return p.parse_args()


def run_parakeet(audio):
    # NVIDIA NeMo, parakeet-tdt (native CUDA). ~2-3 GB VRAM, sehr schnell.
    import nemo.collections.asr as nemo_asr
    model = nemo_asr.models.ASRModel.from_pretrained(
        model_name="nvidia/parakeet-tdt-0.6b-v2")
    out = model.transcribe([audio])
    hyp = out[0]
    text = getattr(hyp, "text", hyp)
    print(text)


def _fmt_ts(t):
    h = int(t // 3600); m = int((t % 3600) // 60)
    s = int(t % 60); ms = int((t - int(t)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def run_whisper(audio, timestamps):
    # faster-whisper (CTranslate2 CUDA), large-v3, int8_float16 -> ~2.5 GB VRAM.
    from faster_whisper import WhisperModel
    model = WhisperModel("large-v3", device="cuda", compute_type="int8_float16")
    segments, _ = model.transcribe(audio, word_timestamps=timestamps)
    if timestamps:
        for i, seg in enumerate(segments, 1):
            print(i)
            print(f"{_fmt_ts(seg.start)} --> {_fmt_ts(seg.end)}")
            print(seg.text.strip())
            print()
    else:
        print(" ".join(seg.text.strip() for seg in segments))


def main():
    a = parse_args()
    try:
        if a.engine == "parakeet":
            run_parakeet(a.audio)
        else:
            run_whisper(a.audio, a.timestamps)
    except Exception as e:
        print(f"stt engine {a.engine} failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
