#!/usr/bin/env python3
# _video_gen.py — LTX-2 CUDA-Treiber hinter dem `video`-Wrapper (Linux-Port).
# UNGETESTET auf diesem Mac (kein NVIDIA). Verifikation auf Nobara + RTX 4070 SUPER.
#
# 12-GB-Strategie: fp8-Checkpoint + enable_sequential_cpu_offload() (layerweise).
# LTX-2 nennt 12 GB als absolutes Minimum -> kurze Clips + niedrige Aufloesung.
# Aufloesung hier bewusst konservativ (768x512), Breite/Hoehe muessen durch 32 teilbar sein.
import argparse
import sys


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True)
    p.add_argument("--prompt", required=True)
    p.add_argument("--frames", type=int, default=73)     # 8n+1
    p.add_argument("--fps", type=int, default=24)
    p.add_argument("--mode", choices=["fast", "hq"], default="fast")
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--image", default="")
    p.add_argument("--output", required=True)
    # 12-GB-konservativ; durch 32 teilbar.
    p.add_argument("--width", type=int, default=768)
    p.add_argument("--height", type=int, default=512)
    return p.parse_args()


def main():
    a = parse_args()
    try:
        import torch
        from diffusers import LTX2Pipeline
        from diffusers.utils import export_to_video
    except Exception as e:
        print(f"Fehler: LTX2Pipeline/diffusers nicht verfuegbar: {e}", file=sys.stderr)
        sys.exit(1)
    if not torch.cuda.is_available():
        print("Fehler: keine CUDA-GPU sichtbar.", file=sys.stderr)
        sys.exit(1)

    pipe = LTX2Pipeline.from_pretrained(a.model, torch_dtype=torch.bfloat16)
    # 12-GB-Pflicht: layerweises Offload haelt den Peak unter der VRAM-Grenze.
    pipe.enable_sequential_cpu_offload(device="cuda")
    try:
        pipe.vae.enable_tiling()
    except Exception:
        pass

    gen = None
    if a.seed is not None:
        gen = torch.Generator(device="cuda").manual_seed(int(a.seed))

    call = dict(prompt=a.prompt, width=a.width, height=a.height,
                num_frames=a.frames, frame_rate=a.fps, generator=gen)
    # Der Schnell-Modus faehrt den distilled-Pfad (weniger Schritte); hq den vollen.
    if a.mode == "fast":
        call["num_inference_steps"] = 8
    else:
        call["num_inference_steps"] = 40

    if a.image:
        from diffusers.utils import load_image
        call["image"] = load_image(a.image)

    result = pipe(**call)
    frames = result.frames[0]
    export_to_video(frames, a.output, fps=a.fps)
    print(a.output)


if __name__ == "__main__":
    main()
